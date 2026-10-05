type Schema = Record<string, unknown>;

function propertiesOf(schema: Schema): Record<string, Schema> {
  return (schema.properties ?? {}) as Record<string, Schema>;
}

/** A value `schema` accepts; enough to exercise a tool without knowing its meaning. */
export function sampleValue(schema: Schema): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.anyOf)) return sampleValue(schema.anyOf[0] as Schema);
  const type = Array.isArray(schema.type)
    ? (schema.type as string[]).find((t) => t !== "null")
    : schema.type;
  switch (type) {
    case "string":
      return "s";
    case "integer":
    case "number":
      return (schema.minimum as number | undefined) ?? 1;
    case "boolean":
      return true;
    case "array":
      return Array.from({ length: (schema.minItems as number | undefined) ?? 0 }, () =>
        sampleValue((schema.items ?? {}) as Schema),
      );
    case "object":
      return sampleArgs(schema);
    default:
      return "v";
  }
}

/** Every required property of an object schema, with a sample value. */
export function sampleArgs(schema: Schema): Record<string, unknown> {
  const required = (schema.required ?? []) as string[];
  return Object.fromEntries(
    required.map((name) => [name, sampleValue(propertiesOf(schema)[name]!)]),
  );
}

/**
 * Arguments the schema rejects: a missing required property, else a number where a string or
 * boolean is expected. Undefined for schemas that accept anything.
 */
export function invalidArgs(schema: Schema): Record<string, unknown> | undefined {
  if (((schema.required ?? []) as string[]).length > 0) return {};
  const entry = Object.entries(propertiesOf(schema)).find(
    ([, p]) => p.type === "string" || p.type === "boolean",
  );
  return entry === undefined ? undefined : { [entry[0]]: 7 };
}

/**
 * The JSON Schema defaults zod writes out on the way back: an object without
 * `additionalProperties` allows any (`{}`), and a record-like object has `properties: {}`. Both
 * are equivalent to leaving them out (JSON Schema 2020-12, 10.3.2.1 and 10.3.2.3).
 */
export function withExplicitDefaults(value: unknown, root = true): unknown {
  if (Array.isArray(value)) return value.map((v) => withExplicitDefaults(v, false));
  if (typeof value !== "object" || value === null) return value;
  const out: Schema = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      key === "properties"
        ? Object.fromEntries(
            Object.entries(item as Schema).map(([k, v]) => [k, withExplicitDefaults(v, false)]),
          )
        : withExplicitDefaults(item, false);
  }
  if (out.type === "object" && !root) {
    out.properties ??= {};
    out.additionalProperties ??= {};
  }
  return out;
}
