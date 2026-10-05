import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OK, serialize } from "./compact.js";
import { diagnose, formatReport } from "./doctor.js";
import { ErrorCode, ToolInputError } from "./errors.js";
import {
  CatalogState,
  syncExtensionTools,
  tierCheck,
  type RegisteredExtensionTools,
} from "./extension-tools.js";
import { PROJECTION_INSTRUCTIONS, unstamped } from "./manifest.js";
import { readProjectTree } from "./project-tree.js";
import { StarUMLClient } from "./staruml-client.js";
import { parseToolSelection, type ToolSelection } from "./tiers.js";
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
export const METAMODEL_URI = "staruml://introspect/metamodel";
export const ENDPOINTS_URI = "staruml://introspect/endpoints";
export const DIAGRAM_IMAGE_TEMPLATE = "staruml://diagram/{id}.png";

/** Diagram ids are base64-like and may contain `/`, `+` and `=`, so they are percent-encoded. */
export function diagramImageUri(id: string): string {
  return `staruml://diagram/${encodeURIComponent(id)}.png`;
}

const INSTRUCTIONS =
  "Results are minified JSON; null and empty fields are omitted and arguments are not echoed. " +
  `${PROJECTION_INSTRUCTIONS} ` +
  "Endpoints without a tool: describe_endpoints, then call_endpoint. " +
  "Resources: diagram PNGs, project tree, metamodel, endpoint manifest. " +
  "Run doctor when calls fail with STARUML_UNREACHABLE or EXTENSION_UNREACHABLE.";

export interface ServerConfig {
  apiPort?: number;
  apiHost?: string;
  extPort?: number;
  /** staruml-mcp-extension's access token (`--ext-token`). */
  extToken?: string;
  name?: string;
  version?: string;
  /** Extension catalog and tool selection; the bundled manifest and the core tier when absent. */
  catalog?: CatalogState;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const id = (what: string) => z.string().min(1).describe(`${what} _id.`);

const GenerateDiagramInput = unstamped(
  z.object({
    code: z
      .string()
      .min(1)
      .describe(`Mermaid source starting with ${SUPPORTED_MERMAID_DIAGRAMS.join("|")}.`),
  }),
);

const DiagramImageInput = unstamped(z.object({ diagramId: id("Diagram") }));

const DoctorInput = unstamped(
  z.object({
    tools: z
      .string()
      .optional()
      .describe("List other extension tools: core, all or comma-separated endpoint names."),
  }),
);

export function createServer(config: ServerConfig = {}): McpServer {
  const client = new StarUMLClient({
    host: config.apiHost,
    port: config.apiPort,
    extPort: config.extPort,
    extToken: config.extToken,
  });

  const server = new McpServer(
    { name: config.name ?? "staruml-mcp", version: config.version ?? "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  const catalog = config.catalog ?? new CatalogState();
  registerResources(server, client, catalog);

  server.registerTool(
    "generate_diagram",
    {
      description: "Render Mermaid code as a new StarUML diagram.",
      inputSchema: GenerateDiagramInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ code }) =>
      runTool("generate diagram", async () => {
        await client.generateDiagram(code);
        return textResult(OK);
      }),
  );

  server.registerTool(
    "get_all_diagrams_info",
    {
      description: `List diagrams (id, type, name) of the open project. Resource: ${DIAGRAMS_URI}.`,
      annotations: READ_ONLY,
    },
    async () =>
      runTool("get all diagrams info", async () => jsonResult(await client.getAllDiagramsInfo())),
  );

  server.registerTool(
    "get_current_diagram_info",
    { description: "Active diagram (id, type, name), or null.", annotations: READ_ONLY },
    async () =>
      runTool("get current diagram info", async () =>
        jsonResult(await client.getCurrentDiagramInfo()),
      ),
  );

  // StarUML 7.1.1's /get_diagram_image_by_id ignores every field but diagramId (checked with
  // scale, maxWidth, width and format: identical bytes), so no sizing options are offered.
  server.registerTool(
    "get_diagram_image_by_id",
    {
      description: `Diagram as PNG. Resource: ${DIAGRAM_IMAGE_TEMPLATE}.`,
      inputSchema: DiagramImageInput,
      annotations: READ_ONLY,
    },
    async ({ diagramId }) =>
      runTool("get diagram image", async () => {
        const image = await client.getDiagramImageById(diagramId);
        return { content: [{ type: "image", data: image, mimeType: "image/png" }] };
      }),
  );

  server.registerTool(
    "doctor",
    {
      description: "Check StarUML, extension and Node setup; reloads the extension's tools.",
      inputSchema: DoctorInput,
      annotations: READ_ONLY,
    },
    async ({ tools }) =>
      runTool("run doctor", async () => {
        if (tools !== undefined) catalog.selection = selectionArgument(tools);
        const { checks, catalog: next } = await diagnose(client);
        catalog.current = next;
        syncExtensionTools(server, client, catalog, extensionTools);
        return textResult(formatReport([...checks, tierCheck(catalog)]));
      }),
  );

  // Everything else comes from the manifest of staruml-mcp-extension: the live one read at
  // startup, or the bundled snapshot when the extension was not reachable.
  const extensionTools: RegisteredExtensionTools = new Map();
  syncExtensionTools(server, client, catalog, extensionTools);

  return server;
}

function selectionArgument(value: string): ToolSelection {
  try {
    return parseToolSelection(value, "tools");
  } catch (error) {
    throw new ToolInputError((error as Error).message, { code: ErrorCode.InvalidArgument });
  }
}

function jsonResource(uri: URL, data: unknown): ReadResourceResult {
  return textResource(uri, serialize(data));
}

function rawJsonResource(uri: URL, data: unknown): ReadResourceResult {
  return textResource(uri, JSON.stringify(data));
}

function textResource(uri: URL, text: string): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
}

/**
 * Resources let clients that support them pull images and project data on demand, so a PNG is not
 * inlined as base64 into a tool result. The equivalent tools stay for clients without resources.
 */
function registerResources(server: McpServer, client: StarUMLClient, catalog: CatalogState): void {
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

  // The catalogues keep their JSON Schemas intact: compact.ts would drop `default: []` and other
  // empty values that carry meaning in a schema.
  server.registerResource(
    "metamodel",
    METAMODEL_URI,
    {
      description: "Every metamodel type with its attributes, supertypes and view types.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const data = await client.callExtension("/introspect", { include: ["metamodel"] });
        return rawJsonResource(uri, data);
      } catch (error) {
        throw resourceError("read metamodel", error);
      }
    },
  );

  server.registerResource(
    "endpoints",
    ENDPOINTS_URI,
    {
      description: "The extension's endpoint manifest with request and response JSON Schemas.",
      mimeType: "application/json",
    },
    async (uri) => rawJsonResource(uri, catalog.current.compiled.manifest),
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
