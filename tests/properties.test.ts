/**
 * Property-based tests (fast-check): invariants that hold for every input, not only the examples
 * the unit tests pick. A failure prints the shrunk counterexample and the seed to replay it with.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkBatch } from "../src/batch.js";
import { OK, omitEcho, prune, serialize } from "../src/compact.js";
import { ToolInputError } from "../src/errors.js";
import {
  bundledCatalog,
  CatalogState,
  listedTools,
  unlistedTools,
} from "../src/extension-tools.js";
import { isLoopback } from "../src/index.js";
import {
  aliasesOf,
  ALIAS_OF,
  BUNDLED_MANIFEST,
  canonicalBody,
  compileManifest,
  listedRequestSchema,
  MAX_DESCRIPTION_LENGTH,
  terseDescription,
  toolName,
} from "../src/manifest.js";
import { sampleArgs } from "./support/schema.js";
import { countedPlan } from "../src/model.js";
import { patternResult } from "../src/patterns.js";
import { diagramImageUri, diagramTextUri, patternUri } from "../src/server.js";
import {
  CORE_ENDPOINTS,
  ENDPOINT_GROUPS,
  endpointGroup,
  listsHandWritten,
  OO_REACHABLE,
  OO_TOOLS,
  parseToolSelection,
  reaches,
  selects,
} from "../src/tiers.js";

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** JSON as the extension sends it: any value, nulls and empty containers included. */
const json = fc.jsonValue({ maxDepth: 4 });

describe("compact.ts", () => {
  it("prune is idempotent but for the {} it keeps for objects it emptied", () => {
    /** `twice` is `once` without its `{}` properties, at any depth, and otherwise unchanged. */
    const dropsOnlyEmptyObjects = (once: unknown, twice: unknown): void => {
      if (Array.isArray(once)) {
        expect(twice).toHaveLength(once.length);
        once.forEach((item, i) => dropsOnlyEmptyObjects(item, (twice as unknown[])[i]));
      } else if (typeof once === "object" && once !== null) {
        const kept = Object.entries(once).filter(([, item]) => {
          // The first pass left no null or [] property behind.
          expect(item === null || (Array.isArray(item) && item.length === 0)).toBe(false);
          return !isEmpty(item);
        });
        expect(Object.keys(twice as object)).toEqual(kept.map(([key]) => key));
        for (const [key, item] of kept) {
          dropsOnlyEmptyObjects(item, (twice as Record<string, unknown>)[key]);
        }
      } else {
        expect(twice).toBe(once);
      }
    };
    fc.assert(
      fc.property(json, (value) => {
        const once = prune(value);
        dropsOnlyEmptyObjects(once, prune(once));
      }),
    );
    // And where the first pass emptied no object, the second changes nothing.
    fc.assert(
      fc.property(json, (value) => {
        const once = prune(value);
        fc.pre(!JSON.stringify(once).includes("{}"));
        expect(prune(once)).toEqual(once);
      }),
    );
  });

  it("keeps a __proto__ key as data", () => {
    const value = JSON.parse('{"__proto__": {"a": 1}, "b": null}') as object;
    expect(JSON.stringify(prune(value))).toBe('{"__proto__":{"a":1}}');
    expect(JSON.stringify(omitEcho(value, {}))).toBe('{"__proto__":{"a":1},"b":null}');
  });

  it("prune keeps every non-empty property, and every array item in place", () => {
    const keeps = (before: unknown, after: unknown): void => {
      if (Array.isArray(before)) {
        expect(after).toHaveLength(before.length);
        before.forEach((item, i) => keeps(item, (after as unknown[])[i]));
      } else if (typeof before === "object" && before !== null) {
        for (const [key, item] of Object.entries(before)) {
          const kept = (after as Record<string, unknown>)[key];
          if (isEmpty(item)) expect(Object.hasOwn(after as object, key)).toBe(false);
          else keeps(item, kept);
        }
      } else {
        expect(after).toBe(before);
      }
    };
    fc.assert(fc.property(json, (value) => keeps(value, prune(value))));
  });

  it("serialize writes JSON or OK, and no object in it holds a null or empty property", () => {
    const clean = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(clean);
      else if (typeof value === "object" && value !== null) {
        for (const item of Object.values(value)) {
          expect(item === null || (Array.isArray(item) && item.length === 0)).toBe(false);
          clean(item);
        }
      }
    };
    fc.assert(
      fc.property(json, (value) => {
        const text = serialize(value);
        if (text !== OK) clean(JSON.parse(text));
      }),
    );
  });

  it("omitEcho drops only properties equal to a primitive argument of the same name", () => {
    const primitive = fc.oneof(fc.string(), fc.integer(), fc.boolean());
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), json),
        fc.dictionary(fc.string(), primitive),
        (value, input) => {
          const out = omitEcho(value, input) as Record<string, unknown>;
          for (const [key, item] of Object.entries(value)) {
            expect(Object.hasOwn(out, key)).toBe(
              !(Object.hasOwn(input, key) && input[key] === item),
            );
          }
        },
      ),
    );
  });
});

const NAME = fc.stringMatching(/^[a-z0-9_]{1,20}$/);

describe("tiers.ts", () => {
  it("names each core endpoint once", () => {
    expect(new Set(CORE_ENDPOINTS).size).toBe(CORE_ENDPOINTS.length);
  });

  it("the core tier lists a subset of all, with unique names, for any manifest subset", () => {
    const endpoints = BUNDLED_MANIFEST.endpoints;
    fc.assert(
      fc.property(
        fc.subarray(endpoints),
        fc.subarray(endpoints.map((e) => toolName(e.path))),
        (subset, extra) => {
          const catalog = bundledCatalog();
          const compiled = {
            ...catalog.compiled,
            tools: catalog.compiled.tools.filter((t) => subset.includes(t.entry)),
          };
          const at = (tools: string) =>
            new CatalogState({ ...catalog, compiled }, parseToolSelection(tools));
          const core = listedTools(at(["core", ...extra].join(","))).map((t) => t.name);
          const all = listedTools(at("all")).map((t) => t.name);
          expect(new Set(core).size).toBe(core.length);
          expect(new Set(all).size).toBe(all.length);
          for (const name of core) expect(all).toContain(name);
          // Every endpoint is listed or reachable through call_endpoint, never both.
          const state = at(["core", ...extra].join(","));
          const unlisted = unlistedTools(state).map((t) => t.name);
          for (const name of core) expect(unlisted).not.toContain(name);
        },
      ),
      { numRuns: 50 },
    );
  });

  const TIER: Record<string, readonly string[]> = { core: CORE_ENDPOINTS, oo: OO_TOOLS };
  /** Names, tiers, and the tools the tiers expand to, so probes hit both sides of every check. */
  const TOKEN = fc.oneof(
    NAME,
    fc.constantFrom("core", "oo", "all"),
    fc.constantFrom(...OO_TOOLS, ...OO_REACHABLE, "build_diagram", "move_views", "batch"),
  );
  const PROBE = fc.oneof(
    NAME,
    fc.constantFrom(...OO_TOOLS, ...OO_REACHABLE, ...CORE_ENDPOINTS, "generate_diagram"),
  );

  it("a selection selects exactly its names, tiers expanded, and all selects everything", () => {
    fc.assert(
      fc.property(fc.array(TOKEN, { minLength: 1 }), PROBE, (tokens, probe) => {
        const selection = parseToolSelection(tokens.join(","));
        const expected = new Set(tokens.flatMap((t) => (Object.hasOwn(TIER, t) ? TIER[t]! : [t])));
        expect(selection.names).toEqual(expected);
        expect(selects(selection, probe)).toBe(expected.has("all") || expected.has(probe));
        expect(selects(parseToolSelection(`all,${tokens.join(",")}`), probe)).toBe(true);
      }),
    );
  });

  it("only oo without core or all closes a selection, which lists and reaches its own names", () => {
    fc.assert(
      fc.property(fc.array(TOKEN, { minLength: 1 }), PROBE, (tokens, probe) => {
        const selection = parseToolSelection(tokens.join(","));
        const closed = tokens.includes("oo") && !tokens.includes("core") && !tokens.includes("all");
        expect(selection.closed).toBe(closed);
        // Open: every hand-written tool listed and every endpoint reachable, as before 0.7.0.
        expect(listsHandWritten(selection, probe)).toBe(!closed || selection.names.has(probe));
        expect(reaches(selection, probe)).toBe(
          !closed || selection.names.has(probe) || OO_REACHABLE.includes(probe),
        );
        // Whatever a closed selection lists, it reaches.
        if (selects(selection, probe)) expect(reaches(selection, probe)).toBe(true);
      }),
    );
  });

  it("the oo tier reaches nothing that draws, whatever is added to it but a drawing name", () => {
    const DRAWING = [
      "build_diagram",
      "create_element_with_view",
      "create_edge_with_view",
      "create_view_of",
      "layout_diagram",
      "route_edges",
      "move_views",
      "resize_node",
      "set_view_style",
      "set_z_order",
      "divide_fragment",
      "apply_theme",
      "set_style_profile",
      "batch",
      "execute_command",
    ];
    fc.assert(
      fc.property(fc.array(NAME, { maxLength: 4 }), (extra) => {
        const selection = parseToolSelection(["oo", ...extra].join(","));
        for (const name of DRAWING) {
          expect(reaches(selection, name), name).toBe(extra.includes(name));
        }
      }),
    );
  });

  it("puts every name in exactly one known group", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        expect(ENDPOINT_GROUPS).toContain(endpointGroup(name));
      }),
    );
  });
});

const OP_NAME = fc.stringMatching(/^[A-Za-z_][\w-]{0,8}$/);
/** Path segments the extension resolves: attribute names and list indexes. */
const SEGMENTS = fc.array(
  fc.oneof(fc.stringMatching(/^[A-Za-z_$][\w$]{0,6}$/), fc.nat(20).map(String)),
  {
    maxLength: 3,
  },
);
const ref = (name: string, segments: string[]) => [`$${name}`, ...segments].join(".");
const tools = bundledCatalog().compiled.tools;

function rejection(ops: Parameters<typeof checkBatch>[1]): string | undefined {
  try {
    checkBatch(tools, ops);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolInputError);
    return (error as ToolInputError).message;
  }
}

describe("batch references", () => {
  it("rejects a reference to the op itself or a later one", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(OP_NAME, { minLength: 1, maxLength: 5 }),
        fc.nat(),
        SEGMENTS,
        (names, pick, segments) => {
          const at = pick % names.length;
          const ops = names.map((name, i) => ({
            path: "/get_element_by_id",
            as: name,
            body: { id: i === at ? ref(names[at + (pick % (names.length - at))]!, segments) : "X" },
          }));
          expect(rejection(ops)).toMatch(
            new RegExp(`^ops\\.${at}\\.body\\.id: .* names no earlier op$`),
          );
        },
      ),
    );
  });

  it("accepts a reference with any path to an earlier op, wherever it sits in the body", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(OP_NAME, { minLength: 2, maxLength: 5 }),
        SEGMENTS,
        (names, segments) => {
          const last = names.length - 1;
          const ops = names.map((name, i) => ({
            path: "/set_documentation",
            as: name,
            body: { elementId: i === last ? ref(names[0]!, segments) : "X", documentation: "d" },
          }));
          expect(rejection(ops)).toBeUndefined();
        },
      ),
    );
  });

  it("never reads a $$-escaped string as a reference, and leaves the ops unchanged", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (id, text) => {
        const ops = [
          {
            path: "/set_documentation",
            body: { elementId: `$$${id}`, documentation: `$$${text}` },
          },
        ];
        const before = structuredClone(ops);
        expect(rejection(ops)).toBeUndefined();
        expect(ops).toEqual(before);
      }),
    );
  });
});

describe("paths and URIs", () => {
  it("diagram resource URIs carry any id through percent-encoding and back", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        for (const [uri, ext] of [
          [diagramImageUri(id), "png"],
          [diagramTextUri(id, "mermaid"), "mmd"],
          [diagramTextUri(id, "plantuml"), "puml"],
        ] as const) {
          const match = new RegExp(`^staruml://diagram/([^/]+)\\.${ext}$`).exec(uri);
          expect(match).not.toBeNull();
          expect(decodeURIComponent(match![1]!)).toBe(id);
        }
      }),
    );
  });

  it("terseDescription is one line of at most 100 characters, and a fixed point", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const short = terseDescription(text);
        expect(short.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
        expect(short).not.toMatch(/\n/);
      }),
    );
  });

  it("isLoopback accepts every 127/8 address and no name with a suffix", () => {
    const octet = fc.nat(255);
    fc.assert(
      fc.property(octet, octet, octet, fc.domain(), (a, b, c, domain) => {
        expect(isLoopback(`127.${a}.${b}.${c}`)).toBe(true);
        expect(isLoopback(`localhost.${domain}`)).toBe(false);
      }),
    );
  });
});

/**
 * Extension 0.3.0 takes an id or a path wherever it takes an element (src/refs.ts there) and keeps
 * the old field names as aliases marked x-alias-of. The listings show canonical names only, and a
 * path is an ordinary string to every check this server makes.
 */
describe("path references and aliases", () => {
  const entries = BUNDLED_MANIFEST.endpoints;
  const tools = compileManifest(BUNDLED_MANIFEST).tools;
  const withAliases = tools.filter((t) => Object.keys(t.aliases).length > 0);
  type Schema = Record<string, unknown>;
  const propertiesOf = (schema: Schema) => (schema.properties ?? {}) as Record<string, Schema>;
  /** Fields documented as taking an id or a path, by endpoint. */
  const refFields = entries.flatMap((entry) =>
    Object.entries(propertiesOf(entry.request))
      .filter(
        ([, p]) => p[ALIAS_OF] === undefined && /\b[Ii]d or path\b/.test(String(p.description)),
      )
      .map(([field, p]) => ({ entry, field, array: p.type === "array" })),
  );
  /** Strings over the path alphabet: names, the separators, escapes and the @ forms. */
  const path = fc
    .array(
      fc.oneof(
        fc.stringMatching(/^[A-Za-z][\w ]{0,6}$/),
        fc.constantFrom("/", ".", "#", "@", "(", ")", ",", "\\", "@current", "@project", "()"),
      ),
      { minLength: 1, maxLength: 8 },
    )
    .map((parts) => parts.join(""));

  it("the manifest has aliases and path fields to check", () => {
    expect(withAliases.length).toBeGreaterThan(30);
    expect(refFields.length).toBeGreaterThan(50);
  });

  it("no listed schema shows an alias, and every alias's canonical field is listed", () => {
    for (const entry of entries) {
      const listed = propertiesOf(listedRequestSchema(entry).schema);
      for (const [alias, canonical] of Object.entries(aliasesOf(entry))) {
        expect(listed, `${entry.path} ${alias}`).not.toHaveProperty(alias);
        expect(listed, `${entry.path} ${canonical}`).toHaveProperty(canonical);
      }
    }
  });

  it("canonicalBody renames each alias to its field, keeps every value and is idempotent", () => {
    const body = fc
      .constantFrom(...withAliases)
      .chain((tool) =>
        fc.tuple(
          fc.constant(tool),
          fc.dictionary(
            fc.constantFrom(...Object.keys(tool.aliases), ...Object.values(tool.aliases), "other"),
            fc.jsonValue({ maxDepth: 1 }),
          ),
        ),
      );
    fc.assert(
      fc.property(body, ([tool, input]) => {
        // Two spellings of one field, an alias and its field or two aliases of it (/diff_diagram
        // has diagramId and id for diagram), are refused as the extension refuses them.
        const fields = Object.keys(input).map((key) => tool.aliases[key] ?? key);
        const clash = new Set(fields).size < fields.length;
        if (clash) {
          expect(() => canonicalBody(tool, input)).toThrow(ToolInputError);
          return;
        }
        const { body: out, used } = canonicalBody(tool, input);
        expect(Object.keys(out).some((k) => k in tool.aliases)).toBe(false);
        expect(Object.keys(out)).toHaveLength(Object.keys(input).length);
        for (const [key, value] of Object.entries(input)) {
          const renamed = tool.aliases[key] ?? key;
          expect(out[renamed]).toEqual(value);
          if (renamed !== key) expect(used.get(renamed)).toBe(key);
        }
        expect(canonicalBody(tool, out).body).toEqual(out);
      }),
    );
  });

  it("every field that takes an id or a path accepts any non-empty path string", () => {
    const strict = new Map(tools.map((t) => [t.path, t.requestSchema]));
    fc.assert(
      fc.property(fc.constantFrom(...refFields), path, ({ entry, field, array }, ref) => {
        const body = { ...sampleArgs(entry.request), [field]: array ? [ref] : ref };
        const parsed = strict.get(entry.path)!.safeParse(body);
        const issues = parsed.success ? [] : parsed.error.issues;
        expect(issues.filter((i) => i.path[0] === field)).toEqual([]);
      }),
    );
  });
});

/**
 * Extension #30's apply_pattern bindings and #23's build_model spec, the two schemas the core
 * tier lists in brief and checks against the whole request schema before sending.
 */
describe("pattern bindings, model specs and their answers", () => {
  const tools = compileManifest(BUNDLED_MANIFEST).tools;
  const schema = (name: string) => tools.find((t) => t.name === name)!.requestSchema;
  const name = fc.string({ minLength: 1, maxLength: 12 });
  const target = fc.oneof(
    name,
    name.map((n) => ({ new: { name: n } })),
  );
  const binding = fc.oneof(target, fc.array(target, { maxLength: 4 }));
  // Role names are any string: the pattern decides which it knows, after the schema check.
  const bindings = fc.dictionary(fc.string({ maxLength: 12 }), binding, { maxKeys: 6 });

  it("accepts every binding of a path, a name, {new: {name}} or a list of those", () => {
    fc.assert(
      fc.property(bindings, (b) => {
        expect(
          schema("apply_pattern").safeParse({ pattern: "Strategy", bindings: b }).success,
        ).toBe(true);
      }),
    );
  });

  it("refuses an empty name, a number or a new element without a name anywhere in a binding", () => {
    const bad = fc.constantFrom<unknown>(
      "",
      7,
      { new: {} },
      { new: { name: "" } },
      [""],
      [7],
      null,
    );
    // zod's record skips a "__proto__" key (found here): such a binding is ignored, not refused,
    // on both sides, since the extension checks with zod too.
    const roleName = fc.string({ maxLength: 12 }).filter((r) => r !== "__proto__");
    fc.assert(
      fc.property(bindings, roleName, bad, (b, role, value) => {
        const parsed = schema("apply_pattern").safeParse({
          pattern: "Strategy",
          bindings: { ...b, [role]: value },
        });
        expect(parsed.success).toBe(false);
      }),
    );
  });

  // Since extension #33 the spec is strict (additionalProperties: false, issue #17's third
  // enforcement layer): a spec that tries to draw fails here, before anything is sent.
  const SPEC_KEYS = new Set(
    Object.keys(
      (
        BUNDLED_MANIFEST.endpoints.find((e) => e.path === "/build_model")!.request.properties as {
          spec: { properties: object };
        }
      ).spec.properties,
    ),
  );
  const GEOMETRY = ["x", "y", "left", "top", "width", "height", "fillColor", "lineColor", "font"];

  it("refuses a build_model spec with any key outside the object vocabulary", () => {
    const stray = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((k) => !SPEC_KEYS.has(k) && k !== "__proto__");
    fc.assert(
      fc.property(stray, fc.jsonValue({ maxDepth: 2 }), (key, value) => {
        expect(schema("build_model").safeParse({ spec: { [key]: value } }).success).toBe(false);
      }),
    );
  });

  it("refuses geometry and colour on a spec and on its classes, and takes the plain spec", () => {
    fc.assert(
      fc.property(fc.constantFrom(...GEOMETRY), fc.jsonValue({ maxDepth: 1 }), (key, value) => {
        const check = (spec: unknown) => schema("build_model").safeParse({ spec }).success;
        expect(check({ classes: [{ name: "Order", [key]: value }] })).toBe(false);
        expect(check({ system: "Shop", [key]: value })).toBe(false);
      }),
    );
    expect(
      schema("build_model").safeParse({ spec: { system: "Shop", classes: [{ name: "Order" }] } })
        .success,
    ).toBe(true);
    expect(schema("build_model").safeParse({ spec: [] }).success).toBe(false);
  });

  it("improve_diagram takes an integer target 0-100 and a preset of the eight, nothing else", () => {
    const PRESETS = ["flow", "hierarchy"].flatMap((p) =>
      ["down", "up", "right", "left"].map((d) => `${p}-${d}`),
    );
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: -50, max: 150 }), fc.double(), fc.string()),
        fc.oneof(fc.constantFrom(...PRESETS), fc.string({ maxLength: 16 })),
        (target, preset) => {
          const valid =
            Number.isInteger(target) &&
            (target as number) >= 0 &&
            (target as number) <= 100 &&
            PRESETS.includes(preset);
          expect(schema("improve_diagram").safeParse({ target, preset }).success).toBe(valid);
        },
      ),
    );
  });

  it("diagram_quality takes only a diagram reference", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 1 }), (key, value) => {
        const parsed = schema("diagram_quality").safeParse({ [key]: value });
        // `ref` (a non-empty string) only; the aliases are renamed before this check.
        const valid = key === "ref" && typeof value === "string" && value !== "";
        expect(parsed.success, `${key}=${JSON.stringify(value)}`).toBe(
          valid || key === "__proto__",
        );
      }),
    );
  });

  it("counts a dry run's ops and leaves no placeholder id, keeping every other value", () => {
    const placeholder = fc.string({ maxLength: 4 }).map((s) => `$${s}`);
    const element = fc.record({ _id: fc.oneof(placeholder, name), path: name });
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue({ maxDepth: 1 }), { maxLength: 5 }),
        fc.dictionary(fc.string({ maxLength: 6 }), fc.array(element, { maxLength: 3 })),
        (ops, roles) => {
          const out = countedPlan({ dryRun: true, roles, plan: { ops } }) as {
            roles: Record<string, { _id?: string; path: string }[]>;
            plan: { ops: number };
          };
          expect(out.plan.ops).toBe(ops.length);
          for (const [role, list] of Object.entries(roles)) {
            list.forEach((e, i) => {
              const kept = out.roles[role]![i]!;
              expect(kept.path).toBe(e.path);
              expect(kept._id).toBe(e._id.startsWith("$") ? undefined : e._id);
            });
          }
        },
      ),
    );
  });

  it("answers every property set exactly once, grouped by path, the last value of a field winning", () => {
    const property = fc.record({
      path: fc.constantFrom("A", "A.end1", "B#op()", "__proto__"),
      field: fc.constantFrom("name", "navigable", "isAbstract", "__proto__"),
      value: fc.jsonValue({ maxDepth: 1 }),
    });
    fc.assert(
      fc.property(fc.array(property, { maxLength: 12 }), (properties) => {
        const { content } = patternResult({ pattern: "P", properties }, {});
        const text = (content[0] as { text: string }).text;
        const grouped =
          text === OK
            ? {}
            : ((JSON.parse(text) as { properties?: Record<string, Record<string, unknown>> })
                .properties ?? {});
        const last = new Map(properties.map((p) => [`${p.path} ${p.field}`, p.value]));
        for (const [key, value] of last) {
          const [path, field] = key.split(" ") as [string, string];
          // serialize prunes null and empty values, as for every answer.
          if (prune({ v: value }) && JSON.stringify(prune({ v: value })) === "{}") continue;
          expect(Object.hasOwn(grouped, path)).toBe(true);
          // Through JSON, as the answer travels: -0 is written as 0 (found here).
          expect(grouped[path]![field]).toEqual(JSON.parse(JSON.stringify(prune(value))));
        }
      }),
    );
  });

  it("pattern resource URIs carry any name through percent-encoding and back", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (patternName) => {
        const match = /^staruml:\/\/pattern\/([^/]+)$/.exec(patternUri(patternName));
        expect(match).not.toBeNull();
        expect(decodeURIComponent(match![1]!)).toBe(patternName);
      }),
    );
  });
});
