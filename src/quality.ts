/**
 * Listings and result shapes of extension 0.3.0's checks: `/lint_diagram` (src/handlers/lint.ts
 * there), `/uml_lint`, `/diff_diagram` and `/model_lint`, and the quality loop of extension #32
 * (src/handlers/quality.ts there), `/diagram_quality` and `/improve_diagram`, which the core tier
 * lists. Each finding names its elements by id and by path, and a lint finding carries an
 * `autofix`, a `{path, body}` request shaped like a `batch` op, so every autofix of an answer can
 * be sent as one batch.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";
import { countsByRule, hardFailures } from "./reports.js";
import { jsonResult } from "./tool-result.js";

export const LINT_DIAGRAM = "lint_diagram";
export const UML_LINT = "uml_lint";
export const DIFF_DIAGRAM = "diff_diagram";
export const MODEL_LINT = "model_lint";
export const DIAGRAM_QUALITY = "diagram_quality";
export const IMPROVE_DIAGRAM = "improve_diagram";

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

/** The extension's descriptions list the measures and the loop's steps in 710 and 630 characters. */
export const DIAGRAM_QUALITY_DESCRIPTION =
  "Score a layout 0-100; penalties say what costs points, failures what caps it.";

export const IMPROVE_DIAGRAM_DESCRIPTION =
  "Re-lay out a diagram by the style profile until it scores its target.";

/** The diagram, as the canonical `ref` (`diagram` and `id` are its aliases). */
const DIAGRAM_REF = "Id or path; default the current one.";

export function diagramQualityInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, { ref: DIAGRAM_REF });
}

/**
 * `ref` and `dryRun`. `target` (default the profile's threshold for the kind, 80 in every
 * built-in), `maxIterations`, `relayout` and `preset` pass unlisted for the rare call that wants
 * another goal or preset, and describe_endpoints shows them: listed, they cost 60 tokens of the
 * core tier's 2,000.
 */
export function improveDiagramInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    { ref: DIAGRAM_REF, dryRun: "Change nothing; answer the score it would reach." },
    new Set(["dryRun"]),
  );
}

interface DiagramSummary {
  _id?: unknown;
  name?: unknown;
}

/** The scored diagram by name, which a later call takes as a reference; its id when unnamed. */
function diagramName(diagram: unknown): unknown {
  const summary = (diagram ?? {}) as DiagramSummary;
  return typeof summary.name === "string" && summary.name !== "" ? summary.name : summary._id;
}

/**
 * A /diagram_quality answer for the model: the diagram by name, the score against the target,
 * the penalties that cost points (the zero ones left out, the largest first) and the findings
 * counted by rule. `rating` and `passes` follow from the score and the target, and the raw
 * `metrics` are what the penalties are computed from: for a two-class diagram from StarUML 7.1.1
 * the answer goes from 189 o200k_base tokens to 27. `failures` stays when it names a hard limit
 * (reports.ts `hardFailures`).
 */
export function qualityResult(data: unknown, input: Json): CallToolResult {
  const answer = data as Json | null;
  if (typeof answer?.score !== "number") return jsonResult(data, input);
  const penalties = Object.entries((answer.penalties ?? {}) as Record<string, number>)
    .filter(([, lost]) => lost > 0)
    .sort(([, a], [, b]) => b - a);
  return jsonResult(
    {
      diagram: diagramName(answer.diagram),
      kind: answer.kind,
      score: answer.score,
      target: answer.target,
      penalties: Object.fromEntries(penalties),
      findings: countsByRule(answer.findings),
      ...hardFailures(answer.failures),
    },
    input,
  );
}

/**
 * An /improve_diagram answer with the diagram by name; its `quality` report is compacted with
 * every other answer's (reports.ts).
 */
export function improveResult(data: unknown, input: Json): CallToolResult {
  const answer = data as Json | null;
  if (typeof answer !== "object" || answer === null || !("diagram" in answer)) {
    return jsonResult(data, input);
  }
  return jsonResult({ ...answer, diagram: diagramName(answer.diagram) }, input);
}

export const MODEL_LINT_DESCRIPTION =
  "Review the object design: god classes, feature envy, package cycles, anaemic entities, ...";

export function modelLintInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    {
      scope: "Model or package; default the project.",
      rules: "Per rule id or name: off|error|warning|info.",
    },
    // The record of severities lists in 40 tokens what the description says; limit passes.
    new Set(["rules"]),
  );
}
