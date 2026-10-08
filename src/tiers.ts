/**
 * Which extension endpoints get a tool of their own. Every tool definition is resent with each
 * model turn: with one tool per endpoint of extension 0.3.0 (103), tools/list and the instructions
 * cost about 14,300 tokens, the core tier under 2,000 and the oo tier under 1,500 (o200k_base,
 * scripts/token-benchmark.mjs). The endpoints a session needs are listed and the rest are reached
 * through describe_endpoints and call_endpoint.
 */

/**
 * The core tier: the element reads and updates every session uses, the composite endpoints that
 * replace dozens of calls (`/batch`, `/build_diagram`, `/export_diagram`), `/build_model` (a
 * model from an object spec, since 0.6.0) and since 0.7.0 the quality loop of extension #32:
 * `/diagram_quality` scores a diagram from its geometry, which a model cannot see in text, and
 * `/improve_diagram` lays it out by the style profile and applies the lint autofixes until the
 * score reaches the profile's target. Names missing from the running manifest are ignored.
 *
 * Budget, 2,000 tools/list tokens with the instructions: 0.6.0 moved `/introspect` (doctor
 * reports both versions), `/describe_diagram` (diagram_as_text reads a diagram in as many
 * tokens), `/validate_model` and `/search_types` out to make room for `/build_model` and
 * `/apply_pattern`. In 0.7.0 `/lint_diagram` (70 tokens) left for the quality pair:
 * improve_diagram runs its autofixes in its loop and diagram_quality reports what it still
 * finds, by rule. In 0.8.0 build_diagram's kind enum, now 29 kinds, costs 111 tokens, so
 * `/apply_pattern` (112) moves to the `patterns` group, where the apply-pattern prompt and the
 * oo tier, which lists it, still reach it, and `/delete_element` (53) leaves too: a deletion is
 * one `/batch` op or call_endpoint away, and the default listing no longer offers the one tool
 * that takes a whole subtree with it. `--tools core,apply_pattern` and the like list them again.
 * `/quick_find` (issue #15, 60 tokens) joins: find_elements needs a type or the exact name, and
 * "where is the thing called something like X" is what a session asks first of a model it did
 * not build.
 */
export const CORE_ENDPOINTS: readonly string[] = [
  "find_elements",
  "quick_find",
  "get_element_by_id",
  "update_element",
  "batch",
  "build_diagram",
  "export_diagram",
  "build_model",
  "diagram_quality",
  "improve_diagram",
];

/**
 * The `oo` tier (issue #17): model-first authoring with nothing that draws. An agent states the
 * domain as objects (`/build_model`), the extension derives every diagram the model implies by
 * rule and lays each out by the style profile (`/derive_diagrams`), and the agent reads, reviews
 * and scores the result. Only these tools are listed, the hand-written ones included: StarUML's
 * built-in `generate_diagram` draws from Mermaid and `get_diagram_image_by_id` is
 * view_diagram's fallback anyway. Since 0.10.0 (issue #20) the agent can also state what a reader
 * wants to know and let the extension pick the view (`/request_diagram`), and name the templates
 * diagrams are drawn with (`/list_templates`): 153 tokens, which the tier's 1,500 has room for.
 */
export const OO_TOOLS: readonly string[] = [
  "build_model",
  "derive_diagrams",
  "request_diagram",
  "list_templates",
  "explain_model",
  "model_lint",
  "apply_pattern",
  "detect_patterns",
  "validate_model",
  "diagram_quality",
  "diagram_as_text",
  "view_diagram",
  "doctor",
];

/**
 * What call_endpoint reaches in the `oo` tier besides the listed tools: reads, model-level
 * writes (elements, members, stereotypes, documentation, relationships without views), the
 * pattern library, history, the style profile's read side, the quality loop, saving and
 * exporting. Left out are the endpoints that place, size, colour or draw views
 * (`DRAWING_ENDPOINTS` in the extension's src/style/guard.ts: /move_views, /set_view_style,
 * /layout_diagram, ...), except `/build_diagram`, which since 0.10.0 draws here through a template
 * from content alone (TEMPLATE_ONLY_FIELDS); `/set_style_profile`, which could turn strict mode
 * off; `/batch` and `/execute_command`, which run any of those; and the editor's UI state. The tier
 * makes the project's style profile strict before it changes anything (`needsStrictProfile`), so
 * the extension refuses the drawing endpoints as well (STYLE_LOCKED) and a client that bypasses
 * this server cannot draw either.
 */
export const OO_REACHABLE: readonly string[] = [
  "get_project_info",
  "save_project",
  "save_project_as",
  "new_project",
  "open_project",
  "is_modified",
  "find_elements",
  "quick_find",
  "get_element_by_id",
  "get_relationships_of",
  "get_refs_to",
  "create_element",
  "update_element",
  "delete_element",
  "create_relationship",
  "set_stereotype",
  "set_documentation",
  "add_attribute",
  "add_operation",
  "add_parameter",
  "add_enumeration_literal",
  "add_template_parameter",
  "add_slot",
  "add_tag",
  "describe_diagram",
  "export_diagram",
  "export_diagrams",
  "export_pdf",
  "export_html",
  "export_text",
  "uml_lint",
  "undo",
  "redo",
  "snapshot",
  "diff_since",
  "restore_snapshot",
  "sync_operations",
  "check_messages",
  "list_patterns",
  "describe_pattern",
  "apply_preset",
  "describe_type",
  "search_types",
  "get_style_profile",
  "apply_style_profile",
  "explain_style_violation",
  "improve_diagram",
  // Viewpoints and templates (extension #42, #43): the catalogues, the conformance lint, and
  // /build_diagram through a template from content alone (TEMPLATE_ONLY_FIELDS).
  "list_viewpoints",
  "describe_viewpoint",
  "describe_template",
  "viewpoint_lint",
  "build_diagram",
];

/**
 * What a closed tier lets through to the endpoints that draw diagrams from content (issue #20):
 * a template's name and the content, never a layout, a direction or a style. These are the
 * fields extension #43's strict profile leaves open (`FREE_FORM` and `spec.styles` in
 * src/handlers/build.ts, `policy` in src/handlers/oo.ts refused as TEMPLATE_ONLY), so the tier
 * refuses before sending what the extension would refuse after, and lists only these.
 * `required` must be given: a strict build without a template is refused too.
 */
export const TEMPLATE_ONLY_FIELDS: ReadonlyMap<
  string,
  { allowed: ReadonlySet<string>; required?: string }
> = new Map([
  [
    "build_diagram",
    {
      allowed: new Set([
        "template",
        "kind",
        "spec",
        "mermaid",
        "text",
        "format",
        "name",
        "parent",
        "upsert",
        "prune",
        "dryRun",
        "result",
      ]),
      required: "template",
    },
  ],
  ["derive_diagrams", { allowed: new Set(["scope", "kinds", "viewpoints", "template", "dryRun"]) }],
]);

/**
 * View attributes that place or style a view (`VIEW_STYLE_FIELDS`, extension
 * src/style/guard.ts). Model elements have none of them, so in the `oo` tier an
 * `/update_element` setting one is refused here before the extension is asked; a strict profile
 * refuses it there too.
 */
export const VIEW_STYLE_FIELDS: ReadonlySet<string> = new Set([
  "left",
  "top",
  "width",
  "height",
  "points",
  "fillColor",
  "lineColor",
  "fontColor",
  "font",
  "lineStyle",
  "stereotypeDisplay",
  "autoResize",
  "showVisibility",
  "showOperationSignature",
  "showProperty",
  "showType",
  "showMultiplicity",
  "suppressAttributes",
  "suppressOperations",
  "wordWrap",
  "showNamespace",
]);

/**
 * Tiers by name; any other token names one tool. A Map, since a token is user input: an object
 * literal would read `constructor` from its prototype (found by tests/properties.test.ts).
 */
const TIERS = new Map<string, readonly string[]>([
  ["core", CORE_ENDPOINTS],
  ["oo", OO_TOOLS],
]);

/**
 * `all` lists every endpoint; otherwise `names` are listed, `core` and `oo` expanded to their
 * tools. A selection with `oo` and without `core` or `all` is closed.
 */
export interface ToolSelection {
  all: boolean;
  names: ReadonlySet<string>;
  /** The value it was parsed from, for reports. */
  label: string;
  /**
   * Hand-written tools are listed only when named, and call_endpoint and describe_endpoints
   * reach only `reachable`. An open selection lists every hand-written tool and reaches every
   * endpoint.
   */
  closed: boolean;
  /** Under a closed selection: `names` and {@link OO_REACHABLE}. Empty otherwise. */
  reachable: ReadonlySet<string>;
}

export const DEFAULT_TOOLS = "core";

const NAME = /^[a-z0-9_]+$/;

/**
 * Parses `core`, `oo`, `all` or a comma-separated list of tool names, which may include a tier
 * (`core,create_diagram`, `oo,save_project`). Throws on an empty list or a token that cannot be a
 * tool name; whether a name exists is only known once the manifest is read, so the doctor
 * reports it.
 */
export function parseToolSelection(value: string, source = "--tools"): ToolSelection {
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const bad = tokens.find((t) => !NAME.test(t));
  if (tokens.length === 0 || bad !== undefined) {
    throw new Error(
      `Invalid ${source}: "${value}". Use core, oo, all, or comma-separated tool names such as core,create_diagram.`,
    );
  }
  const names = new Set<string>();
  for (const token of tokens) {
    for (const name of TIERS.get(token) ?? [token]) names.add(name);
  }
  const all = names.has("all");
  const closed = tokens.includes("oo") && !tokens.includes("core") && !all;
  return {
    all,
    names,
    label: tokens.join(","),
    closed,
    reachable: closed ? new Set([...names, ...OO_REACHABLE]) : new Set(),
  };
}

/** Whether an extension endpoint gets a tool of its own. */
export function selects(selection: ToolSelection, name: string): boolean {
  return selection.all || selection.names.has(name);
}

/** Whether a hand-written tool is listed: always, unless a closed selection leaves it out. */
export function listsHandWritten(selection: ToolSelection, name: string): boolean {
  return !selection.closed || selection.names.has(name);
}

/** Whether call_endpoint and describe_endpoints may reach an endpoint. */
export function reaches(selection: ToolSelection, name: string): boolean {
  return !selection.closed || selection.reachable.has(name);
}

/** What the `oo` tier reaches without the user naming anything. */
const OO_DEFAULT: ReadonlySet<string> = new Set([...OO_TOOLS, ...OO_REACHABLE]);

/**
 * Whether a body may carry `override`, which makes the extension do what a strict profile
 * (STYLE_LOCKED) or `blockSaveOnErrors` (SAVE_BLOCKED) would refuse. A closed tier does not
 * expose it for what it reaches by default, so STYLE_LOCKED stays the last word there; an
 * endpoint the user named at launch (`oo,move_views`) comes as the user asked, override included.
 */
export function exposesOverride(selection: ToolSelection, name: string): boolean {
  return !selection.closed || !OO_DEFAULT.has(name);
}

/**
 * Endpoints that replace the open project. Making the project they discard strict first would
 * only mark it modified; the next change in the new project makes that one strict.
 */
const REPLACES_PROJECT: ReadonlySet<string> = new Set(["new_project", "open_project"]);

/**
 * Whether a call needs the project's style profile strict first (issue #19): any endpoint of a
 * closed tier the manifest does not mark read-only, saves and exports included, so the file a
 * session saves carries the strict profile too.
 */
export function needsStrictProfile(
  selection: ToolSelection,
  name: string,
  readOnly: boolean,
): boolean {
  return selection.closed && !readOnly && !REPLACES_PROJECT.has(name);
}

/**
 * Whether `next` reaches an endpoint or lists a hand-written tool that `current` does not (issue
 * #19). An open selection reaches every endpoint through call_endpoint and lists every
 * hand-written tool, so only a closed one can be widened: `core` to `all` lists more tools but
 * reaches nothing new, while `oo` to `core`, or to `oo,move_views`, reaches drawing endpoints.
 */
export function widens(current: ToolSelection, next: ToolSelection): boolean {
  if (!current.closed) return false;
  return !next.closed || [...next.reachable].some((name) => !current.reachable.has(name));
}

/**
 * Groups for describe_endpoints. The manifest has no group field, so endpoints are grouped by
 * name; the last rule catches everything, which keeps endpoints added by a newer extension
 * reachable through a group without a release of this server.
 */
const GROUP_RULES: readonly (readonly [string, RegExp])[] = [
  // Checks that change nothing: StarUML's validation, the extension's lints, a spec diff, and
  // since extension #32 the quality score and the loop that raises it.
  ["quality", /lint|^validate_model$|^diff_diagram$|^diagram_quality$|^improve_diagram$/],
  // Model checkpoints and the undo history they restore through.
  ["history", /snapshot|^diff_since$|^(undo|redo)$/],
  // Extension #42 and #43: the views a model has, asked for by intent, and the templates they are
  // drawn with. list_templates names StarUML's project templates too, but what an agent reads it
  // for since #43 is the diagram templates build_diagram requires under a strict profile.
  ["viewpoint", /viewpoints?$|^request_diagram$|^(list|describe)_templates?$/],
  // Extension #28: model fragments (.mfj) and XMI in and out. divide_fragment splits a combined
  // fragment of a sequence diagram and stays in diagram.
  ["io", /^(export|import)_(fragment|xmi)$/],
  // Extension #26's write-path diagnostics.
  ["perf", /^performance_stats$/],
  // The project and its editor: file, metadata and templates, StarUML's preferences, the
  // extensions it loads, and the diagram tabs open (extension #28).
  [
    "project",
    /project|modified|preference|templates?$|^list_extensions$|working_diagrams$|^close_diagrams$/,
  ],
  ["command", /command/],
  // search_types searches the same catalogues introspect dumps; describe_type explains one.
  ["meta", /^(introspect|debug|search_types|describe_type)$/],
  // Patterns as data (extension #30): the library, applying, detecting, and the presets that
  // give one element the properties of a kind (value object, entity, ...).
  ["patterns", /pattern|preset/],
  // Model first (extension #23, #33): a model from an object spec, the diagrams derived from
  // it, its text explanation, and the sequence diagrams' messages checked against and synced
  // into its operations. model_lint is a check and sits in quality.
  ["model", /^build_model$|^derive_diagrams$|^explain_model$|_operations$|_messages$/],
  // How views look: themes and per-view colours and fonts.
  ["style", /theme|style|color|font/],
  ["feature", /^add_/],
  ["editor", /selection|editor/],
  // Code generation and reverse engineering through StarUML's language extensions.
  ["code", /_code/],
  ["diagram", /diagram|view|layout|route|export|image|move|resize|z_order|fragment/],
  // Matches the empty string too, so every name has a group (found by tests/properties.test.ts).
  ["element", /^/],
];

export const ENDPOINT_GROUPS = GROUP_RULES.map(([group]) => group) as [string, ...string[]];

export function endpointGroup(name: string): string {
  return GROUP_RULES.find(([, rule]) => rule.test(name))![0];
}
