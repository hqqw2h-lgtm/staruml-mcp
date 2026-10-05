/**
 * Which extension endpoints get a tool of their own. Every tool definition is resent with each
 * model turn: with one tool per endpoint of extension 0.3.0 (88), tools/list and the instructions
 * cost about 12,000 tokens, the core tier under 2,000 (o200k_base, scripts/token-benchmark.mjs). The endpoints
 * most modelling sessions need are listed and the rest are reached through describe_endpoints and
 * call_endpoint.
 */

/**
 * The core tier: the element CRUD every session uses, the composite endpoints that replace
 * dozens of calls (`/batch`, `/build_diagram`, `/export_diagram`), the model-first pair since
 * 0.6.0: `/build_model` (a model from an object spec) and `/apply_pattern` (a design pattern with
 * every property it prescribes, which a model writing batch ops by hand gets wrong or leaves
 * out), and since 0.7.0 the quality loop of extension #32: `/diagram_quality` scores a diagram
 * from its geometry, which a model cannot see in text, and `/improve_diagram` lays it out by the
 * style profile and applies the lint autofixes until the score reaches the profile's target.
 * Names missing from the running manifest are ignored.
 *
 * Budget, 2,000 tools/list tokens with the instructions: 0.6.0 moved `/introspect` (doctor
 * reports both versions), `/describe_diagram` (diagram_as_text reads a diagram in as many
 * tokens), `/validate_model` and `/search_types` out to make room for the pair. In 0.7.0
 * `/lint_diagram` (70 tokens) leaves for the quality pair: improve_diagram runs its autofixes in
 * its loop and diagram_quality reports what it still finds, by rule. `--tools core,lint_diagram`
 * and the like list them again.
 */
export const CORE_ENDPOINTS: readonly string[] = [
  "find_elements",
  "get_element_by_id",
  "update_element",
  "delete_element",
  "batch",
  "build_diagram",
  "export_diagram",
  "build_model",
  "apply_pattern",
  "diagram_quality",
  "improve_diagram",
];

/** `all` lists every endpoint; otherwise `names` are listed, `core` expanded to {@link CORE_ENDPOINTS}. */
export interface ToolSelection {
  all: boolean;
  names: ReadonlySet<string>;
  /** The value it was parsed from, for reports. */
  label: string;
}

export const DEFAULT_TOOLS = "core";

const NAME = /^[a-z0-9_]+$/;

/**
 * Parses `core`, `all` or a comma-separated list of endpoint names, which may include `core`
 * (`core,create_diagram,save_project`). Throws on an empty list or a token that cannot be a tool
 * name; whether a name exists is only known once the manifest is read, so the doctor reports it.
 */
export function parseToolSelection(value: string, source = "--tools"): ToolSelection {
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const bad = tokens.find((t) => !NAME.test(t));
  if (tokens.length === 0 || bad !== undefined) {
    throw new Error(
      `Invalid ${source}: "${value}". Use core, all, or comma-separated tool names such as core,create_diagram.`,
    );
  }
  const names = new Set<string>();
  for (const token of tokens) {
    for (const name of token === "core" ? CORE_ENDPOINTS : [token]) names.add(name);
  }
  return { all: names.has("all"), names, label: tokens.join(",") };
}

export function selects(selection: ToolSelection, name: string): boolean {
  return selection.all || selection.names.has(name);
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
  ["project", /project|modified/],
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
