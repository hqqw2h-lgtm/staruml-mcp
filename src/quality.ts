/**
 * Listings and result shapes of extension 0.3.0's checks: `/lint_diagram` (src/handlers/lint.ts
 * there), which the core tier lists, `/uml_lint` and `/diff_diagram`. Each finding names its
 * elements by id and by path, and a lint finding carries an `autofix`, a `{path, body}` request
 * shaped like a `batch` op, so every autofix of an answer can be sent as one batch.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";
import { jsonResult } from "./tool-result.js";

export const LINT_DIAGRAM = "lint_diagram";
export const UML_LINT = "uml_lint";
export const DIFF_DIAGRAM = "diff_diagram";

/** One line for tools/list; the extension's description lists the seven rules in 390 characters. */
export const LINT_DIAGRAM_DESCRIPTION =
  "Find what makes a diagram hard to read; each finding has an autofix op for one batch.";

export function lintDiagramInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    { diagram: "Id or path; default the current one.", rules: "Rule ids or names; default all." },
    // The item type says nothing the description does not; the request schema checks it.
    new Set(["rules"]),
  );
}

type Json = Record<string, unknown>;

/**
 * A finding without the ids its paths already name: `id` beside a `path`, `ids` beside `paths`
 * when every view has one (a view of no model has none). Paths are what a model reads and what
 * the next call takes; the ids are about 12 o200k_base tokens each and an autofix keeps its own.
 */
function withoutIds(finding: Json): Json {
  const { id, ids, ...rest } = finding;
  const paths = finding.paths;
  const keepIds =
    ids !== undefined &&
    !(Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === "string"));
  return {
    ...rest,
    ...(typeof finding.path === "string" || id === undefined ? {} : { id }),
    ...(keepIds ? { ids } : {}),
  };
}

/**
 * A /lint_diagram, /uml_lint or /diff_diagram answer for the model: the checked diagram as its
 * path (its summary repeats the id, type and owner), `truncated: false` left out, findings
 * without the ids their paths name. Anything else passes as compact JSON.
 */
export function findingsResult(data: unknown, input: Json): CallToolResult {
  if (typeof data !== "object" || data === null) return jsonResult(data, input);
  const { diagram, truncated, findings, ...rest } = data as Json;
  const summary = diagram as { _id?: unknown; path?: unknown } | undefined;
  return jsonResult(
    {
      ...(summary === undefined ? {} : { diagram: summary.path ?? summary._id }),
      ...rest,
      ...(truncated === true ? { truncated } : {}),
      ...(Array.isArray(findings) ? { findings: findings.map((f) => withoutIds(f as Json)) } : {}),
    },
    input,
  );
}
