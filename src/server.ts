import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OK, serialize } from "./compact.js";
import {
  CatalogState,
  syncExtensionTools,
  type RegisteredExtensionTools,
} from "./extension-tools.js";
import { PROJECTION_INSTRUCTIONS } from "./manifest.js";
import { readProjectTree } from "./project-tree.js";
import { StarUMLClient } from "./staruml-client.js";
import { jsonResult, resourceError, runTool, textResult } from "./tool-result.js";

const SUPPORTED_MERMAID_DIAGRAMS = [
  "classDiagram",
  "sequenceDiagram",
  "flowchart",
  "erDiagram",
  "mindmap",
  "requirementDiagram",
  "stateDiagram",
] as const;

export const DIAGRAMS_URI = "staruml://diagrams";
export const PROJECT_URI = "staruml://project";
export const PROJECT_TREE_URI = "staruml://project/tree";
export const DIAGRAM_IMAGE_TEMPLATE = "staruml://diagram/{id}.png";

/** Diagram ids are base64-like and may contain `/`, `+` and `=`, so they are percent-encoded. */
export function diagramImageUri(id: string): string {
  return `staruml://diagram/${encodeURIComponent(id)}.png`;
}

const INSTRUCTIONS =
  "Results are minified JSON; null and empty fields are omitted and arguments are not echoed. " +
  `${PROJECTION_INSTRUCTIONS} ` +
  "Clients with resource support can read diagram PNGs and project data as resources instead of tool calls.";

export interface ServerConfig {
  apiPort?: number;
  apiHost?: string;
  extPort?: number;
  name?: string;
  version?: string;
  /** Extension tools to offer; the bundled manifest when absent. */
  catalog?: CatalogState;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const id = (what: string) => z.string().min(1).describe(`${what} _id.`);

export function createServer(config: ServerConfig = {}): McpServer {
  const client = new StarUMLClient({
    host: config.apiHost,
    port: config.apiPort,
    extPort: config.extPort,
  });

  const server = new McpServer(
    { name: config.name ?? "staruml-mcp", version: config.version ?? "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  const catalog = config.catalog ?? new CatalogState();
  registerResources(server, client);

  server.tool(
    "generate_diagram",
    "Render Mermaid code as a new StarUML diagram.",
    {
      code: z
        .string()
        .min(1)
        .describe(`Mermaid source starting with ${SUPPORTED_MERMAID_DIAGRAMS.join("|")}.`),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ code }) =>
      runTool("generate diagram", async () => {
        await client.generateDiagram(code);
        return textResult(OK);
      }),
  );

  server.tool(
    "get_all_diagrams_info",
    `List diagrams (id, type, name) of the open project. Resource: ${DIAGRAMS_URI}.`,
    {},
    READ_ONLY,
    async () =>
      runTool("get all diagrams info", async () => jsonResult(await client.getAllDiagramsInfo())),
  );

  server.tool(
    "get_current_diagram_info",
    "Active diagram (id, type, name), or null.",
    {},
    READ_ONLY,
    async () =>
      runTool("get current diagram info", async () =>
        jsonResult(await client.getCurrentDiagramInfo()),
      ),
  );

  // StarUML 7.1.1's /get_diagram_image_by_id ignores every field but diagramId (checked with
  // scale, maxWidth, width and format: identical bytes), so no sizing options are offered.
  server.tool(
    "get_diagram_image_by_id",
    `Diagram as PNG. Resource: ${DIAGRAM_IMAGE_TEMPLATE}.`,
    { diagramId: id("Diagram") },
    READ_ONLY,
    async ({ diagramId }) =>
      runTool("get diagram image", async () => {
        const image = await client.getDiagramImageById(diagramId);
        return { content: [{ type: "image", data: image, mimeType: "image/png" }] };
      }),
  );

  // Everything else comes from the manifest of staruml-mcp-extension: the live one read at
  // startup, or the bundled snapshot when the extension was not reachable.
  const extensionTools: RegisteredExtensionTools = new Map();
  syncExtensionTools(server, client, catalog.current, extensionTools);

  return server;
}

function jsonResource(uri: URL, data: unknown): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: serialize(data) }] };
}

/**
 * Resources let clients that support them pull images and project data on demand, so a PNG is not
 * inlined as base64 into a tool result. The equivalent tools stay for clients without resources.
 */
function registerResources(server: McpServer, client: StarUMLClient): void {
  server.registerResource(
    "diagrams",
    DIAGRAMS_URI,
    { description: "Diagrams (id, type, name) of the open project.", mimeType: "application/json" },
    async (uri) => {
      try {
        return jsonResource(uri, await client.getAllDiagramsInfo());
      } catch (error) {
        throw resourceError("read diagrams", error);
      }
    },
  );

  server.registerResource(
    "project",
    PROJECT_URI,
    { description: "Project filename and root summary.", mimeType: "application/json" },
    async (uri) => {
      try {
        return jsonResource(uri, await client.callExtension("/get_project_info", {}));
      } catch (error) {
        throw resourceError("read project", error);
      }
    },
  );

  server.registerResource(
    "project-tree",
    PROJECT_TREE_URI,
    {
      description: "Model elements and diagrams as an ownership tree (_id, _type, name, children).",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        return jsonResource(uri, await readProjectTree(client));
      } catch (error) {
        throw resourceError("read project tree", error);
      }
    },
  );

  server.registerResource(
    "diagram-image",
    new ResourceTemplate(DIAGRAM_IMAGE_TEMPLATE, {
      // resources/list is called by clients on connect, often before StarUML is up; failing the
      // whole listing would also hide the static resources, so the template contributes nothing.
      list: async () => {
        try {
          const diagrams = (await client.getAllDiagramsInfo()) as { id: string; name: string }[];
          return {
            resources: diagrams.map((d) => ({
              uri: diagramImageUri(d.id),
              name: d.name,
              mimeType: "image/png",
            })),
          };
        } catch {
          return { resources: [] };
        }
      },
    }),
    { description: "Diagram rendered as PNG.", mimeType: "image/png" },
    async (uri, variables) => {
      try {
        const diagramId = decodeURIComponent(String(variables.id));
        const blob = await client.getDiagramImageById(diagramId);
        return { contents: [{ uri: uri.href, mimeType: "image/png", blob }] };
      } catch (error) {
        throw resourceError("read diagram image", error);
      }
    },
  );
}
