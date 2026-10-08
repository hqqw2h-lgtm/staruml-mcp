import {
  McpServer,
  ResourceTemplate,
  type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { serialize } from "./compact.js";
import { diagnose, formatReport } from "./doctor.js";
import { ErrorCode, ToolInputError } from "./errors.js";
import {
  CatalogState,
  readIntrospect,
  syncExtensionTools,
  tierCheck,
  type RegisteredExtensionTools,
} from "./extension-tools.js";
import { BUILD_DIAGRAM } from "./build-diagram.js";
import {
  DIAGRAM_AS_TEXT,
  DIAGRAM_AS_TEXT_DESCRIPTION,
  DIAGRAM_TEXT_FORMATS,
  diagramAsText,
  exportText,
  TEXT_EXTENSIONS,
  TEXT_FORMATS,
  type TextFormat,
} from "./diagram-text.js";
import { generateDiagram } from "./generate-diagram.js";
import { IMAGE_FORMATS, type ImageFormat } from "./images.js";
import { nonEmpty, PROJECTION_INSTRUCTIONS, unlisted, unstamped, untrivial } from "./manifest.js";
import { readProjectTree } from "./project-tree.js";
import { registerPrompts, syncPrompts } from "./prompts.js";
import { StarUMLClient } from "./staruml-client.js";
import { listsHandWritten, parseToolSelection, type ToolSelection } from "./tiers.js";
import { jsonResult, resourceError, runTool, textResult } from "./tool-result.js";
import { ANNOTATE, VIEW_DIAGRAM, VIEW_DIAGRAM_DESCRIPTION, viewDiagram } from "./view-diagram.js";
import {
  declaresUi,
  VIEWER_HTML,
  VIEWER_MIME_TYPE,
  VIEWER_TOOL_META,
  VIEWER_URI,
} from "./viewer.js";

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
export const PATTERNS_URI = "staruml://patterns";
export const PATTERN_TEMPLATE = "staruml://pattern/{name}";
export const DIAGRAM_IMAGE_TEMPLATE = "staruml://diagram/{id}.png";
export const DIAGRAM_TEXT_TEMPLATES: Record<TextFormat, string> = {
  mermaid: `staruml://diagram/{id}.${TEXT_EXTENSIONS.mermaid}`,
  plantuml: `staruml://diagram/{id}.${TEXT_EXTENSIONS.plantuml}`,
};

/** Diagram ids are base64-like and may contain `/`, `+` and `=`, so they are percent-encoded. */
export function diagramImageUri(id: string): string {
  return `staruml://diagram/${encodeURIComponent(id)}.png`;
}

/** Pattern names have spaces ("Abstract Factory"), so they are percent-encoded too. */
export function patternUri(name: string): string {
  return `staruml://pattern/${encodeURIComponent(name)}`;
}

export function diagramTextUri(id: string, format: TextFormat): string {
  return `staruml://diagram/${encodeURIComponent(id)}.${TEXT_EXTENSIONS[format]}`;
}

const INSTRUCTIONS =
  "Results are JSON without null or empty fields or echoed arguments. " +
  `${PROJECTION_INSTRUCTIONS} ` +
  "Element fields take an _id or a path: Pkg/Class, Class.attr, Class#op(), Class@Diagram, " +
  "@current. " +
  "Endpoints without a tool: describe_endpoints, then call_endpoint. " +
  "Resources: diagram PNG, Mermaid, PlantUML; project tree; metamodel; endpoints; patterns.";

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
  /**
   * `--image-max-width`: the widest inline PNG or JPEG in pixels, 0 for no cap; the style
   * profile's page width when absent (images.ts).
   */
  imageMaxWidth?: number;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const id = (what: string) => nonEmpty().describe(`${what} _id.`);

const GenerateDiagramInput = unstamped(
  z.object({
    code: nonEmpty().describe(`Mermaid: ${SUPPORTED_MERMAID_DIAGRAMS.join("|")}.`),
    name: z.string().optional().describe("Diagram name; default the Mermaid title."),
    kind: unlisted(z.enum(["activity", "usecase"]), "enum", "type")
      .optional()
      .describe("activity|usecase: build a flowchart as this kind."),
  }),
);

const DiagramImageInput = unstamped(z.object({ diagramId: id("Diagram") }));

/**
 * A diagram reference: an id, or with the extension a path (`Model/Shop/Main`, a diagram's name,
 * `@current`). `id`, the name before extension 0.3.0 took paths, still passes unlisted through
 * the loose root, as the extension keeps its own old names as aliases.
 */
const diagramRef = unlisted(nonEmpty(), "type")
  .optional()
  .describe("Diagram id or path; default the current one.");

const ViewDiagramInput = unstamped(
  untrivial(
    z.looseObject({
      diagram: diagramRef,
      // The modes as export_diagram lists them, which is in the same tier.
      annotate: unlisted(z.enum(ANNOTATE), "enum", "type")
        .optional()
        .describe("As export_diagram's."),
      path: unlisted(nonEmpty(), "type")
        .optional()
        .describe("Absolute file to write instead; .drawio writes draw.io."),
    }),
  ),
);

const DiagramAsTextInput = unstamped(
  untrivial(
    z.looseObject({
      diagram: diagramRef,
      format: z.enum(DIAGRAM_TEXT_FORMATS).optional().describe("Default mermaid."),
    }),
  ),
);

/**
 * view_diagram's `maxWidth`, which the loose root passes unlisted: listed, it took the core tier
 * past its 2,000-token budget. Pixels, 0 for no cap.
 */
function widthArgument(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new ToolInputError(`maxWidth: expected a whole number of pixels, 0 or more`, {
    code: ErrorCode.InvalidArgument,
    hint: "maxWidth caps the inline PNG's width; 0 keeps it at full size, path writes a file.",
  });
}

/**
 * view_diagram's `format`, which the loose root passes unlisted: the file's extension says it in
 * every call seen so far, and `.drawio` is in path's description. It names the format of a file
 * whose name does not.
 */
function formatArgument(value: unknown): ImageFormat | undefined {
  if (value === undefined) return undefined;
  if ((IMAGE_FORMATS as readonly unknown[]).includes(value)) return value as ImageFormat;
  throw new ToolInputError(`format: expected one of ${IMAGE_FORMATS.join(", ")}`, {
    code: ErrorCode.InvalidArgument,
    hint: "format names the file's format; by default the path's extension does.",
  });
}

/** `diagram`, or the unlisted `id` it replaced. */
function diagramArgument(input: { diagram?: string; id?: unknown }): string | undefined {
  return input.diagram ?? (typeof input.id === "string" ? input.id : undefined);
}

/**
 * The tier argument says what the server lets it do. A closed launch tier without
 * --allow-tier-switch cannot widen (TIER_LOCKED), and a model reading only "tier to list" would
 * try `core` from `oo`; an open one reaches every endpoint already, so any tier is taken.
 */
const doctorInput = (locked: boolean) =>
  unstamped(
    z.object({
      tools: z
        .string()
        .optional()
        .describe(
          locked
            ? "Tier: core, oo, all or tool names; never wider than at launch."
            : "Tier to list: core, oo, all or tool names.",
        ),
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
  /** Tools of this server, which a closed tier (`oo`) lists only when it names them. */
  const handWritten: Record<string, RegisteredTool> = {};

  // A host may render MCP Apps without declaring the capability; fetching the view is the other
  // sign that it does (the approach of jgraph/drawio-mcp's app server). An HTTP request without a
  // session gets a new server that sees neither, so the PNG is returned there.
  let viewerRead = false;
  server.registerResource(
    "viewer",
    VIEWER_URI,
    {
      description: "Interactive SVG viewer for view_diagram (MCP Apps).",
      mimeType: VIEWER_MIME_TYPE,
    },
    async (uri) => {
      viewerRead = true;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: VIEWER_MIME_TYPE,
            text: VIEWER_HTML,
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      };
    },
  );

  handWritten["generate_diagram"] = server.registerTool(
    "generate_diagram",
    {
      description: "Render Mermaid code as a new StarUML diagram.",
      inputSchema: GenerateDiagramInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      runTool("generate diagram", () =>
        generateDiagram(client, extensionTool(catalog, BUILD_DIAGRAM), input),
      ),
  );

  handWritten["get_all_diagrams_info"] = server.registerTool(
    "get_all_diagrams_info",
    {
      description: "List diagrams (id, type, name) of the open project.",
      annotations: READ_ONLY,
    },
    async () =>
      runTool("get all diagrams info", async () => jsonResult(await client.getAllDiagramsInfo())),
  );

  handWritten["get_current_diagram_info"] = server.registerTool(
    "get_current_diagram_info",
    { description: "Active diagram (id, type, name), or null.", annotations: READ_ONLY },
    async () =>
      runTool("get current diagram info", async () =>
        jsonResult(await client.getCurrentDiagramInfo()),
      ),
  );

  // StarUML 7.1.1's /get_diagram_image_by_id ignores every field but diagramId (checked with
  // scale, maxWidth, width and format: identical bytes), so no sizing options are offered.
  handWritten["get_diagram_image_by_id"] = server.registerTool(
    "get_diagram_image_by_id",
    {
      description: "Diagram as PNG.",
      inputSchema: DiagramImageInput,
      annotations: READ_ONLY,
    },
    async ({ diagramId }) =>
      runTool("get diagram image", async () => {
        const image = await client.getDiagramImageById(diagramId);
        return { content: [{ type: "image", data: image, mimeType: "image/png" }] };
      }),
  );

  handWritten[VIEW_DIAGRAM] = server.registerTool(
    VIEW_DIAGRAM,
    {
      description: VIEW_DIAGRAM_DESCRIPTION,
      inputSchema: ViewDiagramInput,
      // path writes, and overwrites, a file (issue #19); a client that runs read-only tools
      // without asking must not run this one so.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: VIEWER_TOOL_META,
    },
    async (input) =>
      runTool("view diagram", () => {
        const inline = viewerRead || declaresUi(server.server.getClientCapabilities());
        const diagram = diagramArgument(input);
        const exportTool = extensionTool(catalog, "export_diagram");
        return viewDiagram(client, exportTool, diagram, inline, {
          annotate: input.annotate,
          path: input.path,
          format: formatArgument(input.format),
          maxWidth: widthArgument(input.maxWidth) ?? config.imageMaxWidth,
        });
      }),
  );

  handWritten[DIAGRAM_AS_TEXT] = server.registerTool(
    DIAGRAM_AS_TEXT,
    {
      description: DIAGRAM_AS_TEXT_DESCRIPTION,
      inputSchema: DiagramAsTextInput,
      annotations: READ_ONLY,
    },
    async (input) =>
      runTool("write diagram as text", () =>
        diagramAsText(
          client,
          extensionTool(catalog, "export_text"),
          diagramArgument(input),
          input.format ?? "mermaid",
        ),
      ),
  );

  handWritten.doctor = server.registerTool(
    "doctor",
    {
      description: "Check StarUML, extension and Node setup; reloads the extension's tools.",
      inputSchema: doctorInput(!catalog.allowTierSwitch && catalog.selection.closed),
      annotations: READ_ONLY,
    },
    async ({ tools }) =>
      runTool("run doctor", async () => {
        const selection = tools === undefined ? undefined : selectionArgument(tools);
        // Before anything is read, so a refused widening changes nothing.
        if (selection !== undefined) catalog.checkSelection(selection);
        const { checks, catalog: next } = await diagnose(client);
        // Re-syncs this server's tools and those of every other live session.
        catalog.update(next, selection);
        return textResult(formatReport([...checks, tierCheck(catalog)]));
      }),
  );

  // Everything else comes from the manifest of staruml-mcp-extension: the live one read at
  // startup, or the bundled snapshot when the extension was not reachable.
  const extensionTools: RegisteredExtensionTools = new Map();
  const prompts = registerPrompts(server, catalog);
  const sync = () => {
    syncExtensionTools(server, client, catalog, extensionTools, {
      imageMaxWidth: config.imageMaxWidth,
    });
    for (const [name, tool] of Object.entries(handWritten)) {
      const wanted = listsHandWritten(catalog.selection, name);
      // Each change sends notifications/tools/list_changed, so unchanged tools are left alone.
      if (tool.enabled !== wanted) {
        if (wanted) tool.enable();
        else tool.disable();
      }
    }
    syncPrompts(catalog, prompts);
  };
  sync();
  // The catalog outlives this server, so the subscription must end with it.
  server.server.onclose = catalog.subscribe(sync);

  return server;
}

/** An endpoint of the current catalog, which hand-written tools use whether listed or not. */
function extensionTool(catalog: CatalogState, name: string) {
  const { enabled, compiled } = catalog.current;
  return enabled ? compiled.tools.find((t) => t.name === name) : undefined;
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
        const data = await readIntrospect(client, catalog, "/introspect", {
          include: ["metamodel"],
        });
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

  // The pattern library is data shipped with the extension (its src/patterns/library), so reads
  // are cached like the catalogues until doctor reloads the catalog.
  server.registerResource(
    "patterns",
    PATTERNS_URI,
    {
      description: "Design patterns apply_pattern applies: category, intent, roles, variants.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const data = await catalog.read("/list_patterns {}", () =>
          client.callExtension("/list_patterns", {}),
        );
        return jsonResource(uri, data);
      } catch (error) {
        throw resourceError("read patterns", error);
      }
    },
  );

  // Not enumerated: staruml://patterns names them, and listing 30 more resources would cost a
  // call to the extension on every resources/list.
  server.registerResource(
    "pattern",
    new ResourceTemplate(PATTERN_TEMPLATE, { list: undefined }),
    {
      description:
        "A pattern's roles, members, relationship ends and the properties each gets; what apply_pattern sets.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        const name = decodeURIComponent(String(variables.name));
        const body = { name };
        const data = await catalog.read(`/describe_pattern ${JSON.stringify(body)}`, () =>
          client.callExtension("/describe_pattern", body),
        );
        return jsonResource(uri, data);
      } catch (error) {
        throw resourceError("read pattern", error);
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

  // Not enumerated by resources/list, which already names every diagram once as a PNG;
  // resources/templates/list shows them. Neither format has a registered media type (IANA lists
  // no text/vnd.mermaid or PlantUML type), so they are text/plain, which every client can show.
  for (const format of TEXT_FORMATS) {
    server.registerResource(
      `diagram-${TEXT_EXTENSIONS[format]}`,
      new ResourceTemplate(DIAGRAM_TEXT_TEMPLATES[format], { list: undefined }),
      {
        description: `Diagram written as ${format === "mermaid" ? "Mermaid" : "PlantUML"} text.`,
        mimeType: "text/plain",
      },
      async (uri, variables) => {
        try {
          const diagramId = decodeURIComponent(String(variables.id));
          const tool = extensionTool(catalog, "export_text");
          const out = await exportText(client, tool, diagramId, format);
          const about = {
            kind: out.kind,
            ...(out.warnings?.length ? { warnings: out.warnings } : {}),
          };
          return {
            contents: [{ uri: uri.href, mimeType: "text/plain", text: out.text, _meta: about }],
          };
        } catch (error) {
          throw resourceError(`read diagram ${format}`, error);
        }
      },
    );
  }
}
