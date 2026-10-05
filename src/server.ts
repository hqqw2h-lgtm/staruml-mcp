import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OK, serialize } from "./compact.js";
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
export const DIAGRAM_IMAGE_TEMPLATE = "staruml://diagram/{id}.png";

/** Diagram ids are base64-like and may contain `/`, `+` and `=`, so they are percent-encoded. */
export function diagramImageUri(id: string): string {
  return `staruml://diagram/${encodeURIComponent(id)}.png`;
}

const INSTRUCTIONS =
  "Results are minified JSON; null and empty fields are omitted and arguments are not echoed. " +
  "Clients with resource support can read diagram PNGs and project data as resources instead of tool calls.";

export interface ServerConfig {
  apiPort?: number;
  apiHost?: string;
  extPort?: number;
  name?: string;
  version?: string;
}

const id = (what: string) => z.string().min(1).describe(`${what} _id.`);
const mdjPath = z.string().min(1).describe("Absolute .mdj path.");

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
    async () =>
      runTool("get all diagrams info", async () => jsonResult(await client.getAllDiagramsInfo())),
  );

  server.tool(
    "get_current_diagram_info",
    "Active diagram (id, type, name), or null.",
    {},
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
    async ({ diagramId }) =>
      runTool("get diagram image", async () => {
        const image = await client.getDiagramImageById(diagramId);
        return { content: [{ type: "image", data: image, mimeType: "image/png" }] };
      }),
  );

  // The tools below need staruml-mcp-extension; StarUML's built-in API (7.1.1) only offers the
  // four endpoints above. Its absence is reported per call with an install hint
  // (EXTENSION_UNREACHABLE), so descriptions do not repeat it.

  server.tool("get_all_commands", "List command ids for execute_command.", {}, async () =>
    runTool("get commands", async () => jsonResult(await client.getAllCommands())),
  );

  server.tool(
    "execute_command",
    "Run a StarUML command.",
    {
      id: z.string().min(1).describe("Command id, e.g. project:save."),
      args: z.array(z.unknown()).optional().describe("Positional command arguments."),
    },
    async (input) =>
      runTool("execute command", async () =>
        jsonResult(await client.executeCommand(input.id, input.args), input),
      ),
  );

  server.tool(
    "get_project_info",
    `Project filename and root summary. Resource: ${PROJECT_URI}.`,
    {},
    async () => runTool("get project info", async () => jsonResult(await client.getProjectInfo())),
  );

  server.tool(
    "save_project",
    "Save the project.",
    { filename: z.string().optional().describe("Absolute .mdj path; default the current file.") },
    async (input) =>
      runTool("save project", async () =>
        jsonResult(await client.saveProject(input.filename), input),
      ),
  );

  server.tool(
    "save_project_as",
    "Save the project to a new file.",
    { filename: mdjPath },
    async (input) =>
      runTool("save project as", async () =>
        jsonResult(await client.saveProjectAs(input.filename), input),
      ),
  );

  server.tool("new_project", "Open an empty project, discarding unsaved changes.", {}, async () =>
    runTool("create new project", async () => {
      await client.newProject();
      return textResult(OK);
    }),
  );

  server.tool("open_project", "Open a .mdj file.", { filename: mdjPath }, async (input) =>
    runTool("open project", async () =>
      jsonResult(await client.openProject(input.filename), input),
    ),
  );

  server.tool(
    "get_element_by_id",
    "Element properties; references are {_id, name}.",
    { id: id("Element") },
    async (input) =>
      runTool("get element", async () => jsonResult(await client.getElementById(input.id))),
  );

  server.tool(
    "find_elements",
    "Find elements by type and/or exact name; no filter returns all.",
    {
      type: z.string().optional().describe("Metamodel type, e.g. UMLClass."),
      name: z.string().optional().describe("Exact name."),
    },
    async (input) =>
      runTool("find elements", async () => jsonResult(await client.findElements(input))),
  );

  server.tool(
    "create_element",
    "Create a model element without a view; use create_element_with_view to draw it.",
    {
      type: z.string().min(1).describe("Metamodel type, e.g. UMLClass, UMLPackage."),
      parentId: id("Owner"),
      name: z.string().optional().describe("Name."),
    },
    async (input) =>
      runTool("create element", async () => jsonResult(await client.createElement(input), input)),
  );

  server.tool(
    "create_element_with_view",
    "Create an element and its view on a diagram; returns view and model ids.",
    {
      type: z
        .string()
        .min(1)
        .describe("Metamodel type, e.g. UMLActor, UMLUseCase, UMLAction, UMLClass."),
      parentId: id("Owning model"),
      diagramId: id("Diagram"),
      name: z.string().optional().describe("Name."),
      x: z.number().optional().describe("Left px; default 100."),
      y: z.number().optional().describe("Top px; default 100."),
      x2: z.number().optional().describe("Right px; default x+100."),
      y2: z.number().optional().describe("Bottom px; default y+50."),
    },
    async (input) =>
      runTool("create element with view", async () =>
        jsonResult(await client.createElementWithView(input), input),
      ),
  );

  server.tool(
    "create_edge_with_view",
    "Connect two views with a relationship edge.",
    {
      type: z
        .string()
        .min(1)
        .describe(
          "Edge type, e.g. UMLAssociation, UMLControlFlow, UMLMessage, UMLGeneralization, UMLDependency.",
        ),
      parentId: id("Owning model"),
      diagramId: id("Diagram"),
      tailViewId: id("Source view"),
      headViewId: id("Target view"),
      name: z.string().optional().describe("Label."),
      x: z.number().optional().describe("Tail px."),
      y: z.number().optional().describe("Tail px; set per UMLMessage or messages overlap."),
      x2: z.number().optional().describe("Head px."),
      y2: z.number().optional().describe("Head px; default y."),
    },
    async (input) =>
      runTool("create edge", async () => jsonResult(await client.createEdgeWithView(input), input)),
  );

  server.tool(
    "update_element",
    "Set one property of an element.",
    {
      id: id("Element"),
      field: z.string().min(1).describe("Property, e.g. name, documentation, visibility."),
      value: z.unknown().describe("New value."),
    },
    async (input) =>
      runTool("update element", async () => jsonResult(await client.updateElement(input))),
  );

  server.tool("delete_element", "Delete an element.", { id: id("Element") }, async (input) =>
    runTool("delete element", async () => jsonResult(await client.deleteElement(input.id), input)),
  );

  server.tool(
    "create_diagram",
    "Create an empty typed diagram.",
    {
      type: z
        .string()
        .min(1)
        .describe("Diagram type, e.g. UMLClassDiagram, UMLUseCaseDiagram, ERDDiagram."),
      parentId: id("Owner"),
      name: z.string().optional().describe("Name."),
    },
    async (input) =>
      runTool("create diagram", async () => jsonResult(await client.createDiagram(input), input)),
  );

  server.tool("switch_diagram", "Open a diagram tab.", { id: id("Diagram") }, async (input) =>
    runTool("switch diagram", async () => jsonResult(await client.switchDiagram(input.id), input)),
  );

  server.tool("close_diagram", "Close a diagram tab.", { id: id("Diagram") }, async (input) =>
    runTool("close diagram", async () => jsonResult(await client.closeDiagram(input.id), input)),
  );

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
        return jsonResource(uri, await client.getProjectInfo());
      } catch (error) {
        throw resourceError("read project", error);
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
