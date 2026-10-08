import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BATCH, BATCH_DESCRIPTION, BatchInput, batchResult, checkBatch } from "./batch.js";
import {
  BUILD_DIAGRAM,
  BUILD_DIAGRAM_DESCRIPTION,
  buildDiagramInput,
  buildResult,
} from "./build-diagram.js";
import { ErrorCode, ToolInputError } from "./errors.js";
import {
  EXPORT_DIAGRAM,
  EXPORT_DIAGRAM_DESCRIPTION,
  exportDiagramInput,
} from "./export-diagram.js";
import { LruCache, memo } from "./cache.js";
import { checkDrawioFile, exportRaster, imageMaxWidth, inlineRaster } from "./images.js";
import type { Check } from "./doctor.js";
import {
  DELETE_ELEMENT,
  DELETE_ELEMENT_DESCRIPTION,
  FIND_ELEMENTS,
  FIND_ELEMENTS_DESCRIPTION,
  findElementsInput,
  GET_ELEMENT_BY_ID,
  GET_ELEMENT_BY_ID_DESCRIPTION,
  QUICK_FIND,
  QUICK_FIND_DESCRIPTION,
  quickFindInput,
  refInput,
  UPDATE_ELEMENT,
  UPDATE_ELEMENT_DESCRIPTION,
  updateElementInput,
} from "./elements.js";
import {
  BUNDLED_MANIFEST,
  canonicalBody,
  compileManifest,
  issuePath,
  listedRequestSchema,
  nonEmpty,
  unlisted,
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
import {
  DIAGRAM_QUALITY,
  DIAGRAM_QUALITY_DESCRIPTION,
  diagramQualityInput,
  DIFF_DIAGRAM,
  findingsResult,
  IMPROVE_DIAGRAM,
  IMPROVE_DIAGRAM_DESCRIPTION,
  improveDiagramInput,
  improveResult,
  LINT_DIAGRAM,
  LINT_DIAGRAM_DESCRIPTION,
  lintDiagramInput,
  MODEL_LINT,
  MODEL_LINT_DESCRIPTION,
  modelLintInput,
  qualityResult,
  UML_LINT,
} from "./quality.js";
import {
  APPLY_THEME,
  BUILD_MODEL,
  BUILD_MODEL_DESCRIPTION,
  buildModelInput,
  DERIVE_DIAGRAMS,
  DERIVE_DIAGRAMS_DESCRIPTION,
  deriveDiagramsInput,
  deriveResult,
  EXPLAIN_MODEL,
  EXPLAIN_MODEL_DESCRIPTION,
  explainModelInput,
  explainResult,
  modelResult,
  SYNC_OPERATIONS,
} from "./model.js";
import {
  APPLY_PATTERN,
  APPLY_PATTERN_DESCRIPTION,
  APPLY_PRESET,
  applyPatternInput,
  DETECT_PATTERNS,
  DETECT_PATTERNS_DESCRIPTION,
  detectPatternsInput,
  detectResult,
  patternResult,
} from "./patterns.js";
import { withReports } from "./reports.js";
import { ensureStrictProfile, SET_STYLE_PROFILE, setProfileResult } from "./style.js";
import type { StarUMLClient } from "./staruml-client.js";
import {
  CORE_ENDPOINTS,
  DEFAULT_TOOLS,
  ENDPOINT_GROUPS,
  endpointGroup,
  exposesOverride,
  needsStrictProfile,
  OO_TOOLS,
  parseToolSelection,
  reaches,
  selects,
  VIEW_STYLE_FIELDS,
  widens,
  type ToolSelection,
} from "./tiers.js";
import { exportResult, jsonResult, runTool } from "./tool-result.js";
import {
  DESCRIBE_TEMPLATE,
  DESCRIBE_TEMPLATE_DESCRIPTION,
  DESCRIBE_VIEWPOINT,
  DESCRIBE_VIEWPOINT_DESCRIPTION,
  describeTemplateInput,
  describeViewpointInput,
  LIST_TEMPLATES,
  LIST_TEMPLATES_DESCRIPTION,
  LIST_VIEWPOINTS,
  LIST_VIEWPOINTS_DESCRIPTION,
  listTemplatesInput,
  listViewpointsInput,
  REQUEST_DIAGRAM,
  REQUEST_DIAGRAM_DESCRIPTION,
  requestDiagramInput,
  templatesResult,
  VIEWPOINT_LINT,
  VIEWPOINT_LINT_DESCRIPTION,
  viewpointLintInput,
} from "./viewpoints.js";

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

/**
 * What the `oo` tier offers instead of drawing, for its refusals. It never names a way out of the
 * tier: the re-validation's agent followed exactly that advice and left it in one call.
 */
export const MODEL_FIRST_HINT =
  "The oo tier states the model and derives the diagrams: change the model with build_model (or the model endpoints describe_endpoints() lists), then derive_diagrams lays out every diagram the model implies and improve_diagram raises one's score.";

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

  /** `--allow-tier-switch`: doctor may widen the tier as well as narrow it. */
  readonly allowTierSwitch: boolean;

  constructor(
    private currentCatalog: ExtensionCatalog = bundledCatalog(),
    private currentSelection: ToolSelection = parseToolSelection(DEFAULT_TOOLS),
    options: { allowTierSwitch?: boolean } = {},
  ) {
    this.allowTierSwitch = options.allowTierSwitch ?? false;
  }

  get current(): ExtensionCatalog {
    return this.currentCatalog;
  }

  get selection(): ToolSelection {
    return this.currentSelection;
  }

  /**
   * Refuses a selection that reaches more than the current one (`widens`), unless the server
   * was started with `--allow-tier-switch`. The tier is what the user chose at launch; an agent
   * that could widen it with one doctor call would treat the `oo` tier as advice (issue #19,
   * from the oo re-validation, where `doctor({tools: "core"})` let build_diagram run).
   */
  checkSelection(next: ToolSelection): void {
    if (this.allowTierSwitch || !widens(this.currentSelection, next)) return;
    throw new ToolInputError(
      `doctor cannot widen the ${this.currentSelection.label} tier to ${next.label}: the tier was fixed when the server started`,
      {
        code: ErrorCode.TierLocked,
        hint: `${MODEL_FIRST_HINT} Only the user can start the server with a wider tier (--tools, or --allow-tier-switch).`,
      },
    );
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

/**
 * /export_text writes no file: its draw.io text, every view of the diagram as mxGraph XML, would
 * reach the model whole, so it is refused with export_diagram's file as the way to get one.
 */
const EXPORT_TEXT = "export_text";

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

/** Endpoints reachable only through call_endpoint: in a closed tier only those it reaches. */
export function unlistedTools(state: CatalogState): GeneratedTool[] {
  const listed = new Set(listedTools(state).map((t) => t.name));
  if (summarized(state) !== undefined) listed.add(SUMMARIZED);
  return state.current.enabled
    ? state.current.compiled.tools.filter(
        (t) => !listed.has(t.name) && reaches(state.selection, t.name),
      )
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
  options: SendOptions = {},
): void {
  const wanted = specs(server, client, state, options);
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
  [GET_ELEMENT_BY_ID]: {
    description: GET_ELEMENT_BY_ID_DESCRIPTION,
    input: (tool) => refInput(tool.entry),
  },
  [DELETE_ELEMENT]: {
    description: DELETE_ELEMENT_DESCRIPTION,
    input: (tool) => refInput(tool.entry),
  },
  [LINT_DIAGRAM]: {
    description: LINT_DIAGRAM_DESCRIPTION,
    input: (tool) => lintDiagramInput(tool.entry),
  },
  [FIND_ELEMENTS]: {
    description: FIND_ELEMENTS_DESCRIPTION,
    input: (tool) => findElementsInput(tool.entry),
  },
  [QUICK_FIND]: {
    description: QUICK_FIND_DESCRIPTION,
    input: (tool) => quickFindInput(tool.entry),
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
  [BUILD_MODEL]: {
    description: BUILD_MODEL_DESCRIPTION,
    input: (tool) => buildModelInput(tool.entry),
  },
  [APPLY_PATTERN]: {
    description: APPLY_PATTERN_DESCRIPTION,
    input: (tool) => applyPatternInput(tool.entry),
  },
  [DIAGRAM_QUALITY]: {
    description: DIAGRAM_QUALITY_DESCRIPTION,
    input: (tool) => diagramQualityInput(tool.entry),
  },
  [IMPROVE_DIAGRAM]: {
    description: IMPROVE_DIAGRAM_DESCRIPTION,
    input: (tool) => improveDiagramInput(tool.entry),
  },
  // The oo tier's model-first tools.
  [DERIVE_DIAGRAMS]: {
    description: DERIVE_DIAGRAMS_DESCRIPTION,
    input: (tool) => deriveDiagramsInput(tool.entry),
  },
  [EXPLAIN_MODEL]: {
    description: EXPLAIN_MODEL_DESCRIPTION,
    input: (tool) => explainModelInput(tool.entry),
  },
  [MODEL_LINT]: {
    description: MODEL_LINT_DESCRIPTION,
    input: (tool) => modelLintInput(tool.entry),
  },
  [DETECT_PATTERNS]: {
    description: DETECT_PATTERNS_DESCRIPTION,
    input: (tool) => detectPatternsInput(tool.entry),
  },
  // Viewpoints and templates (extension #42, #43).
  [REQUEST_DIAGRAM]: {
    description: REQUEST_DIAGRAM_DESCRIPTION,
    input: (tool) => requestDiagramInput(tool.entry),
  },
  [LIST_TEMPLATES]: {
    description: LIST_TEMPLATES_DESCRIPTION,
    input: (tool) => listTemplatesInput(tool.entry),
  },
  [DESCRIBE_TEMPLATE]: {
    description: DESCRIBE_TEMPLATE_DESCRIPTION,
    input: (tool) => describeTemplateInput(tool.entry),
  },
  [LIST_VIEWPOINTS]: {
    description: LIST_VIEWPOINTS_DESCRIPTION,
    input: (tool) => listViewpointsInput(tool.entry),
  },
  [DESCRIBE_VIEWPOINT]: {
    description: DESCRIBE_VIEWPOINT_DESCRIPTION,
    input: (tool) => describeViewpointInput(tool.entry),
  },
  [VIEWPOINT_LINT]: {
    description: VIEWPOINT_LINT_DESCRIPTION,
    input: (tool) => viewpointLintInput(tool.entry),
  },
};

function specs(
  server: McpServer,
  client: StarUMLClient,
  state: CatalogState,
  options: SendOptions,
): ToolSpec[] {
  const out: ToolSpec[] = listedTools(state).map((tool) => {
    const short = Object.hasOwn(SHORT_LISTED, tool.name) ? SHORT_LISTED[tool.name] : undefined;
    return short === undefined
      ? {
          name: tool.name,
          fingerprint: tool.fingerprint,
          register: () => registerGenerated(server, client, state, tool, options),
        }
      : {
          name: tool.name,
          fingerprint: `short ${tool.fingerprint}`,
          register: () =>
            registerShortListed(
              server,
              client,
              state,
              tool,
              short.description,
              short.input(tool),
              options,
            ),
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
        register: () => registerCall(server, client, state, options),
      },
    );
  }
  return out;
}

function registerGenerated(
  server: McpServer,
  client: StarUMLClient,
  state: CatalogState,
  tool: GeneratedTool,
  options: SendOptions,
): RegisteredTool {
  return server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
    async (input: Record<string, unknown>) =>
      runTool(actionOf(tool.name), async () =>
        resultOf(tool.name, await send(client, state, tool, input, options), input),
      ),
  );
}

/** What the server was started with that shapes how a call is sent. */
export interface SendOptions {
  /** `--image-max-width`; the style profile's page width when absent. */
  imageMaxWidth?: number;
}

/**
 * Every extension tool sends through here: under a closed tier a call that changes something
 * waits until the project's style profile is strict, and is refused when it cannot be made so;
 * an inline /export_diagram at the default scale comes back no wider than the image cap.
 */
async function send(
  client: StarUMLClient,
  state: CatalogState,
  tool: GeneratedTool,
  body: Record<string, unknown>,
  options: SendOptions,
): Promise<unknown> {
  checkDrawioFile(body.format, tool.name === EXPORT_TEXT ? undefined : body.path, tool.path);
  if (needsStrictProfile(state.selection, tool.name, tool.entry.readOnly === true)) {
    await ensureStrictProfile(client, tool.path);
  }
  if (tool.name === EXPORT_DIAGRAM && inlineRaster(body)) {
    const cap = await imageMaxWidth(client, options.imageMaxWidth);
    return exportRaster(client, tool.path, body, cap);
  }
  return client.callExtension(tool.path, body);
}

/** Endpoints whose answers are reshaped for the model; the rest are compact JSON. */
const RESULT_SHAPES: Record<
  string,
  (data: unknown, input: Record<string, unknown>) => CallToolResult
> = {
  [BATCH]: batchResult,
  [BUILD_DIAGRAM]: buildResult,
  [EXPORT_DIAGRAM]: exportResult,
  [SEARCH_TYPES]: searchResult,
  [DESCRIBE_DIAGRAM]: describeResult,
  [LINT_DIAGRAM]: findingsResult,
  [UML_LINT]: findingsResult,
  [DIFF_DIAGRAM]: findingsResult,
  [MODEL_LINT]: findingsResult,
  // The quality loop: the score against its target and what costs points; the style profile's
  // answers name the profile instead of repeating it whole.
  [DIAGRAM_QUALITY]: qualityResult,
  [IMPROVE_DIAGRAM]: improveResult,
  [SET_STYLE_PROFILE]: setProfileResult,
  [DERIVE_DIAGRAMS]: deriveResult,
  [EXPLAIN_MODEL]: explainResult,
  // Endpoints that run a batch of their own answer a dry run's ops counted; patterns and presets
  // name their elements and properties by path.
  [BUILD_MODEL]: modelResult,
  [SYNC_OPERATIONS]: modelResult,
  [APPLY_THEME]: modelResult,
  [APPLY_PATTERN]: patternResult,
  [APPLY_PRESET]: patternResult,
  [DETECT_PATTERNS]: detectResult,
  // request_diagram answers its choice and the diagrams it derived, as derive_diagrams does.
  [REQUEST_DIAGRAM]: deriveResult,
  [LIST_TEMPLATES]: templatesResult,
  [VIEWPOINT_LINT]: findingsResult,
};

/**
 * The answer shaped for the model: the style and quality reports any authoring endpoint attaches
 * compacted first (reports.ts), then the endpoint's own shape.
 */
function resultOf(name: string, data: unknown, input: Record<string, unknown>): CallToolResult {
  // hasOwn: a manifest may name an endpoint after an Object.prototype member.
  const shape = Object.hasOwn(RESULT_SHAPES, name) ? RESULT_SHAPES[name]! : jsonResult;
  return shape(withReports(data), input);
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
  options: SendOptions,
): RegisteredTool {
  return server.registerTool(
    tool.name,
    { description, inputSchema, annotations: tool.annotations },
    async (input: Record<string, unknown>) =>
      runTool(actionOf(tool.name), async () => {
        const body = validated(state, tool, input);
        return resultOf(tool.name, await send(client, state, tool, body, options), body);
      }),
  );
}

/**
 * `body` with its aliases renamed, checked against the endpoint's whole request schema, unknown
 * keys rejected, and for /batch every op against its own endpoint's. An issue names a field as
 * the caller wrote it, alias or canonical.
 */
function validated(
  state: CatalogState,
  tool: GeneratedTool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { body, used } = canonicalBody(tool, input);
  refuseDrawing(state, tool, body);
  refuseOverride(state, tool, body);
  const parsed = tool.requestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${issuePath(i.path, used).join(".") || "body"}: ${i.message}`,
    );
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

/**
 * A closed tier reaches /update_element for model elements; a field that only a view has (its
 * place, size, colours, what it shows) is refused before anything is sent, whether the profile
 * is strict or not. The extension refuses it again under a strict profile (STYLE_LOCKED).
 */
function refuseDrawing(state: CatalogState, tool: GeneratedTool, body: Record<string, unknown>) {
  const field = body.field;
  if (
    !state.selection.closed ||
    tool.name !== UPDATE_ELEMENT ||
    typeof field !== "string" ||
    !VIEW_STYLE_FIELDS.has(field)
  ) {
    return;
  }
  throw new ToolInputError(
    `field: ${field} places or styles a view, which the ${state.selection.label} tier leaves to the style profile`,
    {
      code: ErrorCode.NotInTier,
      endpoint: tool.path,
      hint: "Change the model and let derive_diagrams or improve_diagram lay the views out.",
    },
  );
}

/**
 * `override` past a strict profile or `blockSaveOnErrors`, refused under a closed tier for what
 * it reaches by default (`exposesOverride`). Without it, a STYLE_LOCKED or SAVE_BLOCKED from the
 * extension is final there.
 */
function refuseOverride(state: CatalogState, tool: GeneratedTool, body: Record<string, unknown>) {
  if (!Object.hasOwn(body, "override") || exposesOverride(state.selection, tool.name)) return;
  throw new ToolInputError(
    `override is not part of the ${state.selection.label} tier: the style profile decides`,
    {
      code: ErrorCode.NotInTier,
      endpoint: tool.path,
      hint: `${MODEL_FIRST_HINT} A save or export the profile blocks needs uml_lint's and model_lint's errors fixed first.`,
    },
  );
}

/**
 * Listed by description alone: the types and the section enum cost about 30 tools/list tokens
 * for what the descriptions say. They are still checked.
 */
const IntrospectSummaryInput = unstamped(
  z.object({
    include: unlisted(z.array(z.enum(["factory", "metamodel", "toolbox"])), "type", "items")
      .optional()
      .describe("Any of factory, metamodel, toolbox; default none, metamodel with types."),
    types: unlisted(z.array(nonEmpty()), "type", "items")
      .optional()
      .describe("Only these metamodel types."),
    inherited: unlisted(z.boolean(), "type").optional().describe("With inherited attributes."),
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
        const data = await readIntrospect(client, state, tool.path, summaryBody(input));
        return jsonResult(data, input);
      }),
  );
}

/**
 * The summary tool's defaults: versions only, or the metamodel when `types` narrows it. The
 * extension's own default is every section, 522 KB from 7.1.1 with 79 endpoints, so
 * call_endpoint applies these too.
 */
function summaryBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, include: body.include ?? (body.types === undefined ? [] : ["metamodel"]) };
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
    names: unlisted(z.array(nonEmpty()), "type", "items")
      .optional()
      .describe("Endpoint names to describe in full."),
    // The index without arguments names the groups; listing them as an enum cost 30 tokens.
    group: unlisted(z.enum(ENDPOINT_GROUPS), "enum")
      .meta({ type: "string" })
      .optional()
      .describe("Describe every endpoint of a group the index names."),
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
    const { schema } = listedRequestSchema(entry);
    out[name] = {
      description: entry.description,
      ...(entry.readOnly ? { readOnly: true } : {}),
      ...(entry.destructive ? { destructive: true } : {}),
      request: withoutTrivialKeywords(
        exposesOverride(state.selection, name) ? schema : withoutOverride(schema),
      ),
    };
  }
  return out;
}

/** A request schema without its `override` property, which a closed tier refuses anyway. */
function withoutOverride(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  if (!Object.hasOwn(properties, "override")) return schema;
  const { override: _override, ...rest } = properties;
  return { ...schema, properties: rest };
}

const CallInput = unstamped(
  z.object({
    name: nonEmpty().describe("Endpoint name from describe_endpoints."),
    body: untrivial(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Request body; default {}."),
  }),
);

function registerCall(
  server: McpServer,
  client: StarUMLClient,
  state: CatalogState,
  options: SendOptions,
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
        if (name === SUMMARIZED) {
          const sent = validated(state, tool, summaryBody(body));
          return jsonResult(await readIntrospect(client, state, tool.path, sent), body);
        }
        const sent = validated(state, tool, body);
        return resultOf(name, await send(client, state, tool, sent, options), body);
      }),
  );
}

function findTool(state: CatalogState, name: string): GeneratedTool {
  const tool = state.current.enabled
    ? state.current.compiled.tools.find((t) => t.name === name)
    : undefined;
  if (tool !== undefined && !reaches(state.selection, name)) {
    // Issue #17's first enforcement layer: what the tier leaves out cannot be called by name.
    throw new ToolInputError(`${name} is outside the ${state.selection.label} tier`, {
      code: ErrorCode.NotInTier,
      endpoint: tool.path,
      hint: `${MODEL_FIRST_HINT} Nothing in the tier places or styles views.`,
    });
  }
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
    ...OO_TOOLS,
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
