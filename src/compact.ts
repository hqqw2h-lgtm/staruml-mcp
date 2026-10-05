/**
 * Result serialization tuned for model context: every token a tool returns is paid for on each
 * later turn, so output is minified and stripped of fields that carry no information.
 */

type JsonObject = Record<string, unknown>;

/** Text returned when a call succeeds with nothing left to report. */
export const OK = "ok";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isObject(value) && Object.keys(value).length === 0;
}

/**
 * Drops null, undefined, `[]` and `{}` properties from every object. Emptiness is judged on the
 * upstream value, so an object whose own properties were all pruned is kept as `{}` rather than
 * disappearing from its parent: `{owner: {stereotype: null}}` says there is an owner. That makes
 * prune idempotent except for those `{}`, which a second pass would drop
 * (tests/properties.test.ts). Array items are never removed: their position can carry meaning.
 */
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (!isObject(value)) return value;
  // fromEntries defines own properties; `out[key] =` would turn a "__proto__" key from JSON.parse
  // into the object's prototype and drop it from the result.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => !isEmpty(item))
      .map(([key, item]) => [key, prune(item)]),
  );
}

/**
 * Removes top-level properties that repeat a primitive argument of the same name, such as the
 * `filename` the extension returns from save_project or the `id` from execute_command; the caller
 * already has them.
 */
export function omitEcho(value: unknown, input: JsonObject): unknown {
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => {
      const sent = input[key];
      const primitive =
        typeof sent === "string" || typeof sent === "number" || typeof sent === "boolean";
      return !(primitive && sent === item);
    }),
  );
}

/**
 * Minified JSON of `value` after {@link prune} and {@link omitEcho}. Nothing to report
 * (`undefined`, or an object with no properties left) becomes {@link OK}; `null` and `[]` stay,
 * because "no active diagram" and "no diagrams" are answers.
 */
export function serialize(value: unknown, input: JsonObject = {}): string {
  const out = omitEcho(prune(value), input);
  if (out === undefined || (isObject(out) && Object.keys(out).length === 0)) return OK;
  return JSON.stringify(out);
}

interface OpResult {
  path?: string;
  success?: boolean;
  [key: string]: unknown;
}

/**
 * /batch op results without the op's path, which the caller sent in the same position, and
 * without `success: true`; a failed op keeps `success: false` beside its code.
 */
export function compactOpResults(results: readonly OpResult[]): unknown[] {
  return results.map((result) => {
    const { path: _path, success, ...rest } = result;
    return success === true ? rest : { success, ...rest };
  });
}
