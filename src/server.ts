import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EXTENSION_REPOSITORY } from "./errors.js";
import { StarUMLClient } from "./staruml-client.js";
import { runTool, textResult } from "./tool-result.js";

const SUPPORTED_MERMAID_DIAGRAMS = [
  "classDiagram",
  "sequenceDiagram",
  "flowchart",
  "erDiagram",
  "mindmap",
  "requirementDiagram",
  "stateDiagram",
] as const;

export interface ServerConfig {
  apiPort?: number;
  apiHost?: string;
  extPort?: number;
  name?: string;
  version?: string;
}

export function createServer(config: ServerConfig = {}): McpServer {
  const client = new StarUMLClient({
    host: config.apiHost,
    port: config.apiPort,
    extPort: config.extPort,
  });

  const server = new McpServer({
    name: config.name ?? "staruml-mcp",
    version: config.version ?? "0.1.0",
  });

  server.tool(
    "generate_diagram",
    `Generate a UML diagram in StarUML from Mermaid code. Supported Mermaid diagram types: ${SUPPORTED_MERMAID_DIAGRAMS.join(", ")}. StarUML must be running with apiServer enabled.`,
    {
      code: z
        .string()
        .min(1)
        .describe(
          `Mermaid diagram source code. Must start with one of: ${SUPPORTED_MERMAID_DIAGRAMS.join(", ")}. Example: "flowchart LR\\n  A[Start] --> B[End]"`,
        ),
    },
    async ({ code }) =>
      runTool("generate diagram", async () => {
        await client.generateDiagram(code);
        return textResult("Diagram successfully generated in StarUML.");
      }),
  );

  server.tool(
    "get_all_diagrams_info",
    "Get metadata (id, name, type) for all diagrams in the currently open StarUML project.",
    {},
    async () =>
      runTool("get all diagrams info", async () => {
        const data = await client.getAllDiagramsInfo();
        return textResult(`Diagrams: ${JSON.stringify(data, null, 2)}`);
      }),
  );

  server.tool(
    "get_current_diagram_info",
    "Get metadata for the currently active (focused) diagram in StarUML.",
    {},
    async () =>
      runTool("get current diagram info", async () => {
        const data = await client.getCurrentDiagramInfo();
        return textResult(
          data
            ? `Current diagram: ${JSON.stringify(data, null, 2)}`
            : "No diagram is currently active.",
        );
      }),
  );

  server.tool(
    "get_diagram_image_by_id",
    "Retrieve a PNG image of a diagram by its ID. Use get_all_diagrams_info first to obtain IDs.",
    {
      diagramId: z
        .string()
        .min(1)
        .describe(
          "Diagram ID. Obtain from get_all_diagrams_info tool (each diagram entry has an 'id' field).",
        ),
    },
    async ({ diagramId }) =>
      runTool("get diagram image", async () => {
        const image = await client.getDiagramImageById(diagramId);
        return { content: [{ type: "image", data: image, mimeType: "image/png" }] };
      }),
  );

  // The tools below need staruml-mcp-extension; StarUML's built-in API (7.1.1) only offers
  // the four endpoints used above.
  const EXT_NOTE = `Requires staruml-mcp-extension to be installed in StarUML. Install from ${EXTENSION_REPOSITORY}`;

  server.tool(
    "get_all_commands",
    `List all registered StarUML command IDs (e.g. 'project:save', 'view:fit-to-window', 'alignment:align-left'). Useful to discover what execute_command can trigger. ${EXT_NOTE}`,
    {},
    async () =>
      runTool("get commands", async () => {
        const data = await client.getAllCommands();
        return textResult(`Commands: ${JSON.stringify(data, null, 2)}`);
      }),
  );

  server.tool(
    "execute_command",
    `Execute any built-in StarUML command by its ID. Use get_all_commands to discover available IDs. ${EXT_NOTE}`,
    {
      id: z
        .string()
        .min(1)
        .describe("Command ID. Examples: 'project:save', 'view:fit-to-window', 'project:new'"),
      args: z
        .array(z.unknown())
        .optional()
        .describe("Optional positional arguments passed to the command handler"),
    },
    async ({ id, args }) =>
      runTool("execute command", async () => {
        const data = await client.executeCommand(id, args);
        return textResult(`Executed: ${JSON.stringify(data, null, 2)}`);
      }),
  );

  server.tool(
    "get_project_info",
    `Get the current StarUML project's filename and top-level element summary. ${EXT_NOTE}`,
    {},
    async () =>
      runTool("get project info", async () => {
        const data = await client.getProjectInfo();
        return textResult(JSON.stringify(data, null, 2));
      }),
  );

  server.tool(
    "save_project",
    `Save the current StarUML project. If filename is given, saves to that path. Otherwise saves to current path. ${EXT_NOTE}`,
    {
      filename: z
        .string()
        .optional()
        .describe("Optional absolute path. If omitted, saves to current project path."),
    },
    async ({ filename }) =>
      runTool("save project", async () => {
        const data = await client.saveProject(filename);
        return textResult(`Saved: ${JSON.stringify(data)}`);
      }),
  );

  server.tool(
    "save_project_as",
    `Save the current StarUML project to a new path. ${EXT_NOTE}`,
    {
      filename: z.string().min(1).describe("Absolute path for the .mdj file"),
    },
    async ({ filename }) =>
      runTool("save project as", async () => {
        const data = await client.saveProjectAs(filename);
        return textResult(`Saved as: ${JSON.stringify(data)}`);
      }),
  );

  server.tool(
    "new_project",
    `Create a new empty StarUML project (discards unsaved changes in current project). ${EXT_NOTE}`,
    {},
    async () =>
      runTool("create new project", async () => {
        await client.newProject();
        return textResult("New project created.");
      }),
  );

  server.tool(
    "open_project",
    `Open a StarUML project file (.mdj). ${EXT_NOTE}`,
    {
      filename: z.string().min(1).describe("Absolute path to the .mdj project file"),
    },
    async ({ filename }) =>
      runTool("open project", async () => {
        const data = await client.openProject(filename);
        return textResult(`Opened: ${JSON.stringify(data)}`);
      }),
  );

  server.tool(
    "get_element_by_id",
    `Retrieve a model element by its internal ID. ${EXT_NOTE}`,
    {
      id: z.string().min(1).describe("Element _id as stored in the StarUML repository"),
    },
    async ({ id }) =>
      runTool("get element", async () => {
        const data = await client.getElementById(id);
        return textResult(JSON.stringify(data, null, 2));
      }),
  );

  server.tool(
    "find_elements",
    `Find elements by metamodel type and/or name. Examples: type='UMLClass', name='User'. Omit both to return all. ${EXT_NOTE}`,
    {
      type: z
        .string()
        .optional()
        .describe("Metamodel type. Examples: 'Project', 'UMLModel', 'UMLClass', 'UMLPackage'"),
      name: z.string().optional().describe("Exact name match"),
    },
    async ({ type, name }) =>
      runTool("find elements", async () => {
        const data = await client.findElements({ type, name });
        return textResult(JSON.stringify(data, null, 2));
      }),
  );

  server.tool(
    "create_element",
    `Create a new UML model element (MODEL ONLY — not placed on any diagram canvas). For native typed diagrams (Use Case, Activity, Class), use create_element_with_view instead so shapes appear in the diagram. The 'type' is a metamodel class name. ${EXT_NOTE}`,
    {
      type: z.string().min(1).describe("Metamodel type, e.g. 'UMLClass', 'UMLPackage'"),
      parentId: z.string().min(1).describe("Parent element's _id"),
      name: z.string().optional().describe("Optional element name"),
    },
    async ({ type, parentId, name }) =>
      runTool("create element", async () => {
        const data = await client.createElement({ type, parentId, name });
        return textResult(`Created: ${JSON.stringify(data, null, 2)}`);
      }),
  );

  server.tool(
    "create_element_with_view",
    `Create a model element AND its visual View on a diagram in one call. Use for populating native typed diagrams (UMLUseCaseDiagram, UMLActivityDiagram, UMLClassDiagram, etc.). Type examples: 'UMLActor', 'UMLUseCase', 'UMLAction', 'UMLInitialNode', 'UMLFinalNode', 'UMLDecisionNode', 'UMLClass', 'UMLComponent', 'UMLNode'. Returns view._id (for edge connections) and model._id. ${EXT_NOTE}`,
    {
      type: z
        .string()
        .min(1)
        .describe(
          "Element metamodel type. Examples: 'UMLActor', 'UMLUseCase', 'UMLAction', 'UMLInitialNode', 'UMLFinalNode', 'UMLDecisionNode', 'UMLMergeNode', 'UMLForkNode', 'UMLJoinNode'",
        ),
      parentId: z.string().min(1).describe("Owning model's _id (usually a UMLModel or UMLPackage)"),
      diagramId: z.string().min(1).describe("Target diagram's _id"),
      name: z.string().optional().describe("Element label"),
      x: z.number().optional().describe("Left X coordinate (default 100)"),
      y: z.number().optional().describe("Top Y coordinate (default 100)"),
      x2: z.number().optional().describe("Right X coordinate (default x+100)"),
      y2: z.number().optional().describe("Bottom Y coordinate (default y+50)"),
    },
    async (args) =>
      runTool("create element with view", async () => {
        const data = await client.createElementWithView(args);
        return textResult(`Created: ${JSON.stringify(data, null, 2)}`);
      }),
  );

  server.tool(
    "create_edge_with_view",
    `Connect two existing Views on a diagram with a typed relationship edge. Edge types: 'UMLAssociation' (use case), 'UMLControlFlow' (activity), 'UMLMessage' (sequence), 'UMLGeneralization', 'UMLDependency'. tailViewId is the source, headViewId is the target. Use view IDs from create_element_with_view results. ${EXT_NOTE}`,
    {
      type: z
        .string()
        .min(1)
        .describe(
          "Edge metamodel type: 'UMLAssociation', 'UMLControlFlow', 'UMLMessage', 'UMLGeneralization', 'UMLDependency'",
        ),
      parentId: z.string().min(1).describe("Owning model's _id"),
      diagramId: z.string().min(1).describe("Diagram's _id"),
      tailViewId: z.string().min(1).describe("Source view _id (from create_element_with_view)"),
      headViewId: z.string().min(1).describe("Target view _id (from create_element_with_view)"),
      name: z.string().optional().describe("Optional edge label"),
      x: z
        .number()
        .optional()
        .describe("Edge tail X coordinate (required for SeqMessage vertical positioning)"),
      y: z
        .number()
        .optional()
        .describe(
          "Edge tail Y coordinate (REQUIRED for UMLMessage in sequence diagrams — determines vertical position of the message; without this, all messages stack at same y)",
        ),
      x2: z.number().optional().describe("Edge head X coordinate"),
      y2: z.number().optional().describe("Edge head Y coordinate (defaults to y if omitted)"),
    },
    async (args) =>
      runTool("create edge", async () => {
        const data = await client.createEdgeWithView(args);
        return textResult(`Created edge: ${JSON.stringify(data, null, 2)}`);
      }),
  );

  server.tool(
    "update_element",
    `Set a property on an existing element. ${EXT_NOTE}`,
    {
      id: z.string().min(1).describe("Element _id"),
      field: z
        .string()
        .min(1)
        .describe("Property name, e.g. 'name', 'documentation', 'visibility'"),
      value: z.unknown().describe("New value"),
    },
    async ({ id, field, value }) =>
      runTool("update element", async () => {
        const data = await client.updateElement({ id, field, value });
        return textResult(JSON.stringify(data, null, 2));
      }),
  );

  server.tool(
    "delete_element",
    `Delete an element from the project. ${EXT_NOTE}`,
    {
      id: z.string().min(1).describe("Element _id to delete"),
    },
    async ({ id }) =>
      runTool("delete element", async () => {
        const data = await client.deleteElement(id);
        return textResult(JSON.stringify(data));
      }),
  );

  server.tool(
    "create_diagram",
    `Create a typed UML diagram. The 'type' is a metamodel class name (e.g. 'UMLClassDiagram', 'UMLUseCaseDiagram', 'UMLSequenceDiagram', 'UMLActivityDiagram', 'ERDDiagram'). Unlike generate_diagram (Mermaid), this gives a native empty diagram you can populate via create_element. ${EXT_NOTE}`,
    {
      type: z
        .string()
        .min(1)
        .describe(
          "Diagram metamodel type: 'UMLClassDiagram', 'UMLUseCaseDiagram', 'UMLSequenceDiagram', 'UMLActivityDiagram', 'UMLStateDiagram', 'UMLComponentDiagram', 'UMLDeploymentDiagram', 'ERDDiagram'",
        ),
      parentId: z
        .string()
        .min(1)
        .describe("Parent element's _id (usually the project or a package)"),
      name: z.string().optional().describe("Diagram name"),
    },
    async ({ type, parentId, name }) =>
      runTool("create diagram", async () => {
        const data = await client.createDiagram({ type, parentId, name });
        return textResult(`Created diagram: ${JSON.stringify(data, null, 2)}`);
      }),
  );

  server.tool(
    "switch_diagram",
    `Focus (open tab) a diagram by its ID. ${EXT_NOTE}`,
    {
      id: z.string().min(1).describe("Diagram _id"),
    },
    async ({ id }) =>
      runTool("switch diagram", async () => {
        const data = await client.switchDiagram(id);
        return textResult(JSON.stringify(data));
      }),
  );

  server.tool(
    "close_diagram",
    `Close a diagram tab by its ID. ${EXT_NOTE}`,
    {
      id: z.string().min(1).describe("Diagram _id"),
    },
    async ({ id }) =>
      runTool("close diagram", async () => {
        const data = await client.closeDiagram(id);
        return textResult(JSON.stringify(data));
      }),
  );

  return server;
}
