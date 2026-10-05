/**
 * Which extension endpoints get a tool of their own. Every tool definition is resent with each
 * model turn: with one tool per endpoint of extension 0.3.0 (79), tools/list and the instructions
 * cost about 12,000 tokens, the core tier under 2,000 (o200k_base, scripts/token-benchmark.mjs). The endpoints
 * most modelling sessions need are listed and the rest are reached through describe_endpoints and
 * call_endpoint.
 */

/**
 * The core tier: the element CRUD every session uses, the composite endpoints that replace
 * dozens of calls (`/batch`, `/build_diagram`, `/export_diagram`), `/lint_diagram`, whose
 * findings carry the fix for each layout problem a model cannot see in text, and since 0.6.0 the
 * model-first pair: `/build_model` (a model from an object spec) and `/apply_pattern` (a design
 * pattern with every property it prescribes, which a model writing batch ops by hand gets wrong
 * or leaves out). Names missing from the running manifest are ignored.
 *
 * The pair cost 237 tokens, so four endpoints left the tier in 0.6.0 to keep it under 2,000:
 * `/introspect` (doctor reports both versions; call_endpoint gives it the summary tool's
 * defaults, extension-tools.ts), `/describe_diagram` (diagram_as_text, always listed, reads a
 * diagram in as many tokens), `/validate_model` (a final check that sits with `/uml_lint` in the
 * quality group) and `/search_types` (the spec tools take names, not metamodel ids; the type an
 * op body needs is a describe_endpoints step away anyway). `--tools core,search_types` and the
 * like list them again.
 */
export const CORE_ENDPOINTS: readonly string[] = [
  "find_elements",
  "get_element_by_id",
  "update_element",
  "delete_element",
  "batch",
  "build_diagram",
  "export_diagram",
  "lint_diagram",
  "build_model",
  "apply_pattern",
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
  // Checks that change nothing: StarUML's validation, the extension's lints, a spec diff.
  ["quality", /lint|^validate_model$|^diff_diagram$/],
  // Model checkpoints and the undo history they restore through.
  ["history", /snapshot|^diff_since$|^(undo|redo)$/],
  ["project", /project|modified/],
  ["command", /command/],
  // search_types searches the same catalogues introspect dumps; describe_type explains one.
  ["meta", /^(introspect|debug|search_types|describe_type)$/],
  // Patterns as data (extension #30): the library, applying, detecting, and the presets that
  // give one element the properties of a kind (value object, entity, ...).
  ["patterns", /pattern|preset/],
  // Model first (extension #23): a model from an object spec, and the sequence diagrams'
  // messages checked against and synced into its operations.
  ["model", /^build_model$|_operations$|_messages$/],
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
