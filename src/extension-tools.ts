import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BATCH, BATCH_DESCRIPTION, BatchInput, batchResult, checkBatch } from "./batch.js";
import { BUILD_DIAGRAM, BUILD_DIAGRAM_DESCRIPTION, buildDiagramInput } from "./build-diagram.js";
import { ErrorCode, ToolInputError } from "./errors.js";
import {
  EXPORT_DIAGRAM,
  EXPORT_DIAGRAM_DESCRIPTION,
  exportDiagramInput,
} from "./export-diagram.js";
import { LruCache, memo } from "./cache.js";
import type { Check } from "./doctor.js";
import {
  FIND_ELEMENTS,
  FIND_ELEMENTS_DESCRIPTION,
  findElementsInput,
  UPDATE_ELEMENT,
  UPDATE_ELEMENT_DESCRIPTION,
  updateElementInput,
} from "./elements.js";
import {
  BUNDLED_MANIFEST,
  compileManifest,
  listedRequestSchema,
  unstamped,
  untrivial,
  withoutTrivialKeywords,
  type CompiledManifest,
  type GeneratedTool,
} from "./manifest.js";
import {
  DESCRIBE_DIAGRAM,
  DESCRIBE_DIAGRAM_DESCRIPTION,
  describeDiagramInput,
  describeResult,
  SEARCH_TYPES,
  SEARCH_TYPES_DESCRIPTION,
  searchResult,
  searchTypesInput,
  VALIDATE_MODEL,
  VALIDATE_MODEL_DESCRIPTION,
  validateModelInput,
} from "./reads.js";
import type { StarUMLClient } from "./staruml-client.js";
import {
  CORE_ENDPOINTS,
  DEFAULT_TOOLS,
  ENDPOINT_GROUPS,
  endpointGroup,
  parseToolSelection,
  selects,
  type ToolSelection,
} from "./tiers.js";
import { exportResult, jsonResult, runTool } from "./tool-result.js";

/**
 * Tools written by hand: the four endpoints of StarUML's built-in API, which has no manifest, and
 * tools of this server. A manifest entry with one of these names is ignored.
 */
export const HAND_WRITTEN_TOOLS: ReadonlySet<string> = new Set([
  "generate_diagram",
  "get_all_diagrams_info",
  "get_current_diagram_info",
  "get_diagram_image_by_id",
  "view_diagram",
  "diagram_as_text",
  "doctor",
  "describe_endpoints",
  "call_endpoint",
]);

/** The extension tools a server offers, and where their definitions came from. */
export interface ExtensionCatalog {
  compiled: CompiledManifest;
  source: "live" | "bundled";
  /** False when the running extension's version is incompatible; no extension tools are listed. */
  enabled: boolean;
}

export function bundledCatalog(): ExtensionCatalog {
  return {
    compiled: compileManifest(BUNDLED_MANIFEST, HAND_WRITTEN_TOOLS),
    source: "bundled",
    enabled: true,
  };
}

/**
 * Shared by every McpServer of a process: one per HTTP session or stateless request, or the stdio
 * one. The doctor tool replaces `current` after reading the manifest again, and `selection` when
 * asked to; every subscribed server then re-syncs its tools, so a session other than the doctor's
 * also gets `notifications/tools/list_changed`.
 */
export class CatalogState {
  private readonly listeners = new Set<() => void>();
  /**
   * Catalogue reads: the /introspect sections and describe_endpoints answers. They change only
   * with the extension or the selection, so {@link update} (doctor, a new manifest) drops them.
   * Keys hold the request body, which the introspect tool's `types` makes open-ended; 64 entries
   * keep the common ones without letting it grow.
   */
  readonly reads = new LruCache<Promise<unknown>>(64);

  constructor(
    private currentCatalog: ExtensionCatalog = bundledCatalog(),
    private currentSelection: ToolSelection = parseToolSelection(DEFAULT_TOOLS),
  ) {}

  get current(): ExtensionCatalog {
    return this.currentCatalog;
  }

  get selection(): ToolSelection {
    return this.currentSelection;
  }

  update(current: ExtensionCatalog, selection: ToolSelection = this.currentSelection): void {
    this.currentCatalog = current;
    this.currentSelection = selection;
    this.reads.clear();
    for (const listener of [...this.listeners]) listener();
  }

  /** `load()`'s answer, cached under `key` until the next {@link update}. */
  read<T>(key: string, load: () => Promise<T>): Promise<T> {
    return memo(this.reads, key, load);
  }

  /** Calls `listener` after every {@link update}; the returned function unsubscribes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribed listeners; a server unsubscribes when it closes. */
  get subscribers(): number {
    return this.listeners.size;
  }
}

/** The summary tool replaces the endpoint's own: a full /introspect answer is about 250 KB. */
const SUMMARIZED = "introspect";

/** Endpoints that get a tool of their own under the current selection. */
export function listedTools(state: CatalogState): GeneratedTool[] {
  const { current, selection } = state;
  if (!current.enabled) return [];
  return current.compiled.tools.filter((t) => t.name !== SUMMARIZED && selects(selection, t.name));
}

/** The /introspect endpoint when its summary tool is listed. */
function summarized(state: CatalogState): GeneratedTool | undefined {
  const { current, selection } = state;
  if (!current.enabled || !selects(selection, SUMMARIZED)) return undefined;
  return current.compiled.tools.find((t) => t.name === SUMMARIZED);
}

/** Endpoints reachable only through call_endpoint. */
export function unlistedTools(state: CatalogState): GeneratedTool[] {
  const listed = new Set(listedTools(state).map((t) => t.name));
  if (summarized(state) !== undefined) listed.add(SUMMARIZED);
  return state.current.enabled
    ? state.current.compiled.tools.filter((t) => !listed.has(t.name))
    : [];
}

/** A tool to keep registered; `fingerprint` changes when it must be registered again. */
interface ToolSpec {
  name: string;
  fingerprint: string;
  register(): RegisteredTool;
}

export type RegisteredExtensionTools = Map<string, { tool: RegisteredTool; fingerprint: string }>;

/**
 * Makes `registered` match the catalog and selection: tools for new or changed endpoints are
 * (re)registered and tools that left the listing removed. The SDK sends
 * `notifications/tools/list_changed` for each change once a client is connected, so unchanged
 * tools are left alone.
 */
export function syncExtensionTools(
  server: McpServer,
  client: StarUMLClient,
  state: CatalogState,
  registered: RegisteredExtensionTools,
): void {
  const wanted = specs(server, client, state);
  const names = new Set(wanted.map((s) => s.name));
  for (const [name, entry] of registered) {
    if (!names.has(name)) {
      entry.tool.remove();
      registered.delete(name);
    }
  }
  for (const spec of wanted) {
    const existing = registered.get(spec.name);
    if (existing?.fingerprint === spec.fingerprint) continue;
    existing?.tool.remove();
    registered.set(spec.name, { tool: spec.register(), fingerprint: spec.fingerprint });
  }
}

/**
 * Endpoints listed with a hand-written description and a shorter schema than the manifest's,
 * whose bodies are checked against the manifest's whole request schema before they are sent.
 */
const SHORT_LISTED: Record<
  string,
  { description: string; input: (tool: GeneratedTool) => z.ZodObject }
> = {
  [BATCH]: { description: BATCH_DESCRIPTION, input: () => BatchInput },
  [BUILD_DIAGRAM]: {
    description: BUILD_DIAGRAM_DESCRIPTION,
    input: (tool) => buildDiagramInput(tool.entry),
  },
  [EXPORT_DIAGRAM]: {
    description: EXPORT_DIAGRAM_DESCRIPTION,
    input: (tool) => exportDiagramInput(tool.entry),
  },
  [FIND_ELEMENTS]: {
    description: FIND_ELEMENTS_DESCRIPTION,
    input: (tool) => findElementsInput(tool.entry),
  },
  [UPDATE_ELEMENT]: {
    description: UPDATE_ELEMENT_DESCRIPTION,
    input: (tool) => updateElementInput(tool.entry),
  },
  [SEARCH_TYPES]: {
    description: SEARCH_TYPES_DESCRIPTION,
    input: (tool) => searchTypesInput(tool.entry),
  },
  [DESCRIBE_DIAGRAM]: {
    description: DESCRIBE_DIAGRAM_DESCRIPTION,
    input: (tool) => describeDiagramInput(tool.entry),
  },
  [VALIDATE_MODEL]: {
    description: VALIDATE_MODEL_DESCRIPTION,
    input: (tool) => validateModelInput(tool.entry),
  },
};

function specs(server: McpServer, client: StarUMLClient, state: CatalogState): ToolSpec[] {
  const out: ToolSpec[] = listedTools(state).map((tool) => {
    const short = SHORT_LISTED[tool.name];
    return short === undefined
      ? {
          name: tool.name,
          fingerprint: tool.fingerprint,
          register: () => registerGenerated(server, client, tool),
        }
      : {
          name: tool.name,
          fingerprint: `short ${tool.fingerprint}`,
          register: () =>
            registerShortListed(server, client, state, tool, short.description, short.input(tool)),
        };
  });
  const introspect = summarized(state);
  if (introspect !== undefined) {
    out.push({
      name: SUMMARIZED,
      fingerprint: `summary ${introspect.fingerprint}`,
      register: () => registerIntrospectSummary(server, client, state, introspect),
    });
  }
  if (unlistedTools(state).length > 0) {
    out.push(
      {
        name: "describe_endpoints",
        fingerprint: "generic",
        register: () => registerDescribe(server, state),
      },
      {
        name: "call_endpoint",
        fingerprint: "generic",
        register: () => registerCall(server, client, state),
      },
    );
  }
  return out;
}

function registerGenerated(
  server: McpServer,
  client: StarUMLClient,
  tool: GeneratedTool,
): RegisteredTool {
  return server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
    async (input: Record<string, unknown>) =>
      runTool(actionOf(tool.name), async () =>
        resultOf(tool.name, await client.callExtension(tool.path, input), input),
      ),
  );
}

/** Endpoints whose answers are reshaped for the model; the rest are compact JSON. */
const RESULT_SHAPES: Record<
  string,
  (data: unknown, input: Record<string, unknown>) => CallToolResult
> = {
  [BATCH]: batchResult,
  [EXPORT_DIAGRAM]: exportResult,
  [SEARCH_TYPES]: searchResult,
  [DESCRIBE_DIAGRAM]: describeResult,
};

function resultOf(name: string, data: unknown, input: Record<string, unknown>): CallToolResult {
  return (RESULT_SHAPES[name] ?? jsonResult)(data, input);
}

/**
 * An endpoint of {@link SHORT_LISTED}; the body is checked against the manifest's schemas (for
 * /batch the batch's and each op's) before it is sent.
 */
function registerShortListed(
  server: McpServer,
  client: StarUMLClient,
  state: CatalogState,
  tool: GeneratedTool,
  description: string,
  inputSchema: z.ZodObject,
): RegisteredTool {
  return server.registerTool(
    tool.name,
    { description, inputSchema, annotations: tool.annotations },
    async (input: Record<string, unknown>) =>
      runTool(actionOf(tool.name), async () => {
        const body = validated(state, tool, input);
        return resultOf(tool.name, await client.callExtension(tool.path, body), body);
      }),
  );
}

/**
 * `body` checked against the endpoint's whole request schema, unknown keys rejected, and for
 * /batch every op against its own endpoint's.
 */
function validated(
  state: CatalogState,
  tool: GeneratedTool,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = tool.requestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    throw new ToolInputError(issues.join("; "), {
      code: ErrorCode.InvalidArgument,
      endpoint: tool.path,
      hint: `describe_endpoints({names: ["${tool.name}"]}) shows its schema.`,
    });
  }
  if (tool.name === BATCH) {
    checkBatch(
      state.current.compiled.tools,
      (parsed.data as { ops: Parameters<typeof checkBatch>[1] }).ops,
    );
  }
  return parsed.data;
}

const IntrospectSummaryInput = unstamped(
  z.object({
    include: z
      .array(z.enum(["factory", "metamodel", "toolbox"]))
      .optional()
      .describe("Default none; metamodel when types is given."),
    types: z.array(z.string().min(1)).optional().describe("Only these metamodel types."),
    inherited: z.boolean().optional().describe("With inherited attributes."),
  }),
);

/**
 * /introspect without its bulky defaults: versions only unless sections are asked for, and never
 * the endpoint manifest, which describe_endpoints and staruml://introspect/endpoints serve.
 */
function registerIntrospectSummary(
  server: McpServer,
  client: StarUMLClient,
  state: CatalogState,
  tool: GeneratedTool,
): RegisteredTool {
  return server.registerTool(
    tool.name,
    {
      description: "StarUML and extension versions; include adds factory ids, metamodel, toolbox.",
      inputSchema: IntrospectSummaryInput,
      annotations: tool.annotations,
    },
    async (input) =>
      runTool(actionOf(tool.name), async () => {
        const include = input.include ?? (input.types === undefined ? [] : ["metamodel"]);
        const data = await readIntrospect(client, state, tool.path, { ...input, include });
        return jsonResult(data, input);
      }),
  );
}

/**
 * An /introspect answer, cached in `state`: versions, metamodel, factory ids and toolbox only change
 * when StarUML or the extension restarts, after which doctor reloads the catalog anyway.
 */
export function readIntrospect(
  client: StarUMLClient,
  state: CatalogState,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return state.read(`${path} ${JSON.stringify(body)}`, () => client.callExtension(path, body));
}

const DescribeInput = unstamped(
  z.object({
    names: z.array(z.string().min(1)).optional().describe("Endpoints to describe in full."),
    group: z.enum(ENDPOINT_GROUPS).optional().describe("Describe every endpoint of a group."),
  }),
);

function registerDescribe(server: McpServer, state: CatalogState): RegisteredTool {
  return server.registerTool(
    "describe_endpoints",
    {
      description: "Endpoints without a tool, for call_endpoint. No arguments: names by group.",
      inputSchema: DescribeInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool("describe endpoints", async () =>
        jsonResult(
          await state.read(`describe ${JSON.stringify(input)}`, async () => describe(state, input)),
        ),
      ),
  );
}

/**
 * Without arguments an index of the unlisted endpoints, one line each; with names or a group their
 * descriptions and request schemas as tools/list would show them. Listed endpoints are left out
 * of the index and groups, since the caller already has their definitions.
 */
export function describe(
  state: CatalogState,
  input: { names?: string[]; group?: string },
): Record<string, unknown> {
  const unlisted = unlistedTools(state);
  if (input.names === undefined && input.group === undefined) {
    const index: Record<string, Record<string, string>> = {};
    for (const tool of unlisted) {
      (index[endpointGroup(tool.name)] ??= {})[tool.name] = tool.description;
    }
    return index;
  }
  const chosen = new Map<string, GeneratedTool>();
  for (const name of input.names ?? []) chosen.set(name, findTool(state, name));
  for (const tool of unlisted) {
    if (endpointGroup(tool.name) === input.group) chosen.set(tool.name, tool);
  }
  const out: Record<string, unknown> = {};
  for (const [name, { entry }] of chosen) {
    out[name] = {
      description: entry.description,
      ...(entry.readOnly ? { readOnly: true } : {}),
      ...(entry.destructive ? { destructive: true } : {}),
      request: withoutTrivialKeywords(listedRequestSchema(entry).schema),
    };
  }
  return out;
}

const CallInput = unstamped(
  z.object({
    name: z.string().min(1).describe("Endpoint name from describe_endpoints."),
    body: untrivial(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Request body; default {}."),
  }),
);

function registerCall(
  server: McpServer,
  client: StarUMLClient,
  state: CatalogState,
): RegisteredTool {
  return server.registerTool(
    "call_endpoint",
    {
      description:
        "Call an extension endpoint that has no tool; the body is checked against its schema.",
      inputSchema: CallInput,
      // The endpoint decides; MCP defaults to the most cautious hints when none are stated.
      annotations: { openWorldHint: false },
    },
    async ({ name, body = {} }) =>
      runTool(actionOf(name), async () => {
        const tool = findTool(state, name);
        const sent = validated(state, tool, body);
        return resultOf(name, await client.callExtension(tool.path, sent), body);
      }),
  );
}

function findTool(state: CatalogState, name: string): GeneratedTool {
  const tool = state.current.enabled
    ? state.current.compiled.tools.find((t) => t.name === name)
    : undefined;
  if (tool !== undefined) return tool;
  const { extension } = state.current.compiled.manifest;
  throw new ToolInputError(`No endpoint "${name}" in ${extension.name} ${extension.version}`, {
    code: ErrorCode.UnknownEndpoint,
    hint: HAND_WRITTEN_TOOLS.has(name)
      ? `${name} is a tool; call it directly.`
      : "describe_endpoints() lists the endpoints.",
  });
}

function actionOf(name: string): string {
  return name.replaceAll("_", " ");
}

/**
 * How the selection played out against the manifest, for the doctor report. Names that are
 * neither an endpoint nor part of the core tier are probably misspelt.
 */
export function tierCheck(state: CatalogState): Check {
  const { selection, current } = state;
  const known = new Set([
    ...HAND_WRITTEN_TOOLS,
    ...CORE_ENDPOINTS,
    ...current.compiled.manifest.endpoints.map((e) => e.path.slice(1)),
  ]);
  const unknown = [...selection.names].filter((n) => n !== "all" && !known.has(n));
  const listed = listedTools(state).length + (summarized(state) === undefined ? 0 : 1);
  const detail = `${selection.label}: ${listed} extension tools listed, ${unlistedTools(state).length} endpoints through call_endpoint`;
  return unknown.length === 0
    ? { name: "tier", status: "ok", detail }
    : {
        name: "tier",
        status: "warn",
        detail: `${detail}; unknown: ${unknown.join(", ")}`,
        remedy: "Check the names against describe_endpoints() or staruml://introspect/endpoints.",
      };
}
