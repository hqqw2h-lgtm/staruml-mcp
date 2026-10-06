/**
 * The two reports extension #31 and #32 attach to every authoring answer: `style`, what the
 * style profile changed (src/style/apply.ts `styleReport` there), and `quality`, the quality
 * loop's outcome (src/quality/loop.ts `qualitySchema`). /build_diagram, /build_model,
 * /apply_pattern, /layout_diagram, /improve_diagram and the single-view creates carry them, so
 * they are compacted once for every answer instead of per endpoint.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface LintCount {
  rule?: unknown;
  name?: unknown;
  count?: unknown;
}

/**
 * `/lint_diagram` findings counted by rule, `[{rule, name, severity, count}]`, as `{name: count}`.
 * The name is what lint_diagram's `rules` takes as well as the id; the severity follows from the
 * rule and the profile. Anything else passes as it is.
 */
export function countsByRule(findings: unknown): unknown {
  if (!Array.isArray(findings)) return findings;
  const counted = findings as LintCount[];
  if (!counted.every((f) => typeof f?.name === "string" && typeof f.count === "number")) {
    return findings;
  }
  return Object.fromEntries(counted.map((f) => [f.name as string, f.count]));
}

/**
 * The loop's report as `{score, target, iterations, findings}`: `rating` is the score in fifths
 * (4 needs 80), `passes` is score >= target, `before` and `steps` say how the loop got there,
 * which the next call does not need. Left findings stay, counted by rule: a report with one
 * finding left is 25 o200k_base tokens against 62 (StarUML 7.1.1, a two-class build). So do
 * `failures`, the hard limits extension #38 caps the score at 59 for (aspect past the profile's
 * maxAspect, more boxes than maxNodes): no relayout fixes them, so the next call has to split
 * the diagram, and an empty list says nothing.
 */
export function compactQuality(quality: unknown): unknown {
  if (!isObject(quality) || typeof quality.score !== "number") return quality;
  const { score, target, iterations, findings, failures } = quality;
  return {
    score,
    ...(target === undefined ? {} : { target }),
    ...(iterations === undefined ? {} : { iterations }),
    ...(findings === undefined ? {} : { findings: countsByRule(findings) }),
    ...hardFailures(failures),
  };
}

/** `{failures}` when the list names any, else nothing. */
export function hardFailures(failures: unknown): { failures?: unknown } {
  return Array.isArray(failures) && failures.length > 0 ? { failures } : {};
}

interface Rename {
  from?: unknown;
  to?: unknown;
}

/**
 * The style report with each rename as `from: to`; the kind is the element's, which the name
 * already says. `{profile}` alone stays: it names the profile that styled the answer.
 */
export function compactStyle(style: unknown): unknown {
  if (!isObject(style) || typeof style.profile !== "string") return style;
  const renamed = style.renamed;
  if (!Array.isArray(renamed)) return style;
  const pairs = renamed as Rename[];
  if (!pairs.every((r) => typeof r?.from === "string" && typeof r.to === "string")) return style;
  return {
    ...style,
    renamed: Object.fromEntries(pairs.map((r) => [r.from as string, r.to])),
  };
}

/** `data` with its top-level `quality` and `style` reports compacted. */
export function withReports(data: unknown): unknown {
  if (!isObject(data)) return data;
  if (!("quality" in data) && !("style" in data)) return data;
  return {
    ...data,
    ...("quality" in data ? { quality: compactQuality(data.quality) } : {}),
    ...("style" in data ? { style: compactStyle(data.style) } : {}),
  };
}
