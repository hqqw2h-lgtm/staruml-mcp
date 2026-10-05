/**
 * Which extension endpoints get a tool of their own. Every tool definition is resent with each
 * model turn: with one tool per endpoint of extension 0.3.0 (56), tools/list and the instructions
 * cost 9,322 tokens, the core tier 1,992 (o200k_base, scripts/token-benchmark.mjs). The endpoints most
 * modelling sessions need are listed and the rest are reached through describe_endpoints and
 * call_endpoint.
 */

/**
 * The core tier: the element CRUD every session uses, and the composite endpoints that replace
 * dozens of calls once an extension ships them (`/batch`, `/build_diagram`, `/export_diagram`).
 * Names missing from the running manifest are ignored. `introspect` is the summary tool.
 */
export const CORE_ENDPOINTS: readonly string[] = [
  "introspect",
  "find_elements",
  "get_element_by_id",
  "update_element",
  "delete_element",
  "batch",
  "build_diagram",
  "export_diagram",
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
  ["project", /project|modified/],
  ["command", /command/],
  ["meta", /^(introspect|debug)$/],
  ["feature", /^add_/],
  ["editor", /selection|editor|undo|redo/],
  // Code generation and reverse engineering through StarUML's language extensions.
  ["code", /_code/],
  ["diagram", /diagram|view|layout|export|image|style|color|font|move|resize|z_order/],
  ["element", /./],
];

export const ENDPOINT_GROUPS = GROUP_RULES.map(([group]) => group) as [string, ...string[]];

export function endpointGroup(name: string): string {
  return GROUP_RULES.find(([, rule]) => rule.test(name))![0];
}
