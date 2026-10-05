import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  annotationsOf,
  BUNDLED_MANIFEST,
  compatibleRange,
  compileManifest,
  inputSchema,
  isCompatibleVersion,
  listedRequestSchema,
  MAX_DESCRIPTION_LENGTH,
  parseManifest,
  shortInput,
  strictRequestSchema,
  terseDescription,
  toolName,
  unstamped,
  untrivial,
  withoutTrivialKeywords,
  type Manifest,
  type ManifestEntry,
} from "../src/manifest.js";

const entry = (overrides: Partial<ManifestEntry> = {}): ManifestEntry => ({
  path: "/do_it",
  description: "Do it.",
  readOnly: false,
  destructive: false,
  request: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  response: {},
  ...overrides,
});

const manifest = (endpoints: ManifestEntry[]): Manifest => ({ ...BUNDLED_MANIFEST, endpoints });

describe("bundled manifest", () => {
  it("is the endpoint section of the extension's recorded 0.3.0 /introspect", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../src/extension-manifest.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    expect(Object.keys(raw)).toEqual(["staruml", "extension", "endpoints"]);
    expect(BUNDLED_MANIFEST.extension).toEqual({
      name: "staruml-mcp-extension",
      version: "0.3.0",
    });
    expect(BUNDLED_MANIFEST.staruml.version).toBe("7.1.1");
  });

  it("compiles every endpoint into a tool", () => {
    const compiled = compileManifest(BUNDLED_MANIFEST);

    expect(compiled.skipped).toEqual([]);
    expect(compiled.tools.map((t) => t.path)).toEqual(
      BUNDLED_MANIFEST.endpoints.map((e) => e.path),
    );
  });
});

describe("parseManifest", () => {
  it("rejects a response without an endpoint list in one line", () => {
    expect(() =>
      parseManifest({ staruml: BUNDLED_MANIFEST.staruml, extension: BUNDLED_MANIFEST.extension }),
    ).toThrow("invalid manifest: endpoints: Invalid input: expected array, received undefined");
  });

  it("names the root when the response is not an object", () => {
    expect(() => parseManifest(null)).toThrow(/^invalid manifest: \(root\): /);
  });

  it("rejects a path that cannot become a tool name", () => {
    expect(() => parseManifest(manifest([entry({ path: "/Bad Path" })]))).toThrow();
  });
});

describe("terseDescription", () => {
  it("keeps a short description as it is", () => {
    expect(terseDescription("Read one element by id.")).toBe("Read one element by id.");
  });

  it("flattens whitespace and line breaks", () => {
    expect(terseDescription("  Read one\n  element. ")).toBe("Read one element.");
  });

  it("keeps whole sentences while they fit", () => {
    expect(terseDescription("Open a diagram. Its tab is focused. " + "x".repeat(80))).toBe(
      "Open a diagram. Its tab is focused.",
    );
  });

  it("does not end a sentence at e.g. or i.e.", () => {
    const text = `Create a model element, e.g. a UMLClass, i.e. a type. Then ${"more ".repeat(20)}.`;
    expect(terseDescription(text)).toBe("Create a model element, e.g. a UMLClass, i.e. a type.");
  });

  it("cuts a long first sentence at a late clause boundary with an ellipsis", () => {
    const text = `Create a relationship between two elements with its ends set: ${"source ".repeat(20)}.`;
    expect(terseDescription(text)).toBe(
      "Create a relationship between two elements with its ends set…",
    );
  });

  it("cuts at a word when no clause boundary is late enough", () => {
    const text = `Short, then ${"word ".repeat(40)}end.`;
    const out = terseDescription(text);

    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(out).toMatch(/word…$/);
  });

  it("cuts mid-word when the sentence has no spaces", () => {
    expect(terseDescription("x".repeat(150))).toBe(`${"x".repeat(99)}…`);
  });
});

describe("listedRequestSchema", () => {
  const request = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      id: { type: "string", description: "Element id." },
      properties: { type: "object", description: "A long explanation of initial values." },
      summary: { type: "boolean", description: "A long explanation." },
      fields: { type: "array", items: { type: "string" }, description: "Long." },
      depth: { type: "integer", minimum: 0, maximum: 8, description: "Long." },
    },
    required: ["id"],
  };
  const shortProperties = {
    type: "object",
    description: "Initial attribute values by name; references as an id or {$ref: id}.",
  };

  it.each([
    ["a writing", false],
    ["a read-only", true],
  ])("leaves the projection of %s endpoint unlisted but passed through", (_, readOnly) => {
    expect(listedRequestSchema(entry({ readOnly, request }))).toEqual({
      passthrough: true,
      schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Element id." },
          properties: shortProperties,
        },
        required: ["id"],
      },
    });
  });

  it("leaves a schema without properties alone", () => {
    expect(listedRequestSchema(entry({ request: { type: "object" } }))).toEqual({
      passthrough: false,
      schema: { type: "object" },
    });
  });
});

describe("inputSchema", () => {
  const schema = entry().request;

  it("strips unknown arguments when everything is listed", () => {
    expect(inputSchema({ schema, passthrough: false }).parse({ id: "a", x: 1 })).toEqual({
      id: "a",
    });
  });

  it("keeps unknown arguments when parameters were left out of the listing", () => {
    expect(inputSchema({ schema, passthrough: true }).parse({ id: "a", depth: 1 })).toEqual({
      id: "a",
      depth: 1,
    });
  });

  it("rejects a schema that is not an object", () => {
    expect(() => inputSchema({ schema: { type: "string" }, passthrough: false })).toThrow(
      "request schema is not an object schema",
    );
  });
});

describe("strictRequestSchema", () => {
  const request = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { id: { type: "string" }, fields: { type: "array", items: { type: "string" } } },
    required: ["id"],
  };

  it("accepts every manifest parameter, the projection of a writing endpoint included", () => {
    expect(strictRequestSchema(entry({ request })).parse({ id: "a", fields: ["name"] })).toEqual({
      id: "a",
      fields: ["name"],
    });
  });

  it("rejects keys the manifest does not define", () => {
    const parsed = strictRequestSchema(entry({ request })).safeParse({ id: "a", Id: "b" });

    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["Id"] });
  });
});

describe("unstamped", () => {
  it("lists without $schema", () => {
    const schema = unstamped(z.object({ id: z.string() }));

    expect(z.toJSONSchema(schema, { target: "draft-7" })).toEqual({
      $schema: undefined,
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
    expect(JSON.stringify(z.toJSONSchema(schema))).not.toContain("$schema");
  });
});

describe("untrivial", () => {
  it("lists a loose object and a record without keywords every object meets", () => {
    const schema = z.looseObject({ body: untrivial(z.record(z.string(), z.unknown())) });

    expect(z.toJSONSchema(untrivial(schema), { io: "input" })).toMatchObject({
      properties: { body: { type: "object" } },
    });
    expect(JSON.stringify(z.toJSONSchema(untrivial(schema), { io: "input" }))).not.toMatch(
      /additionalProperties|propertyNames/,
    );
    expect(untrivial(schema).parse({ body: { a: 1 }, extra: true })).toEqual({
      body: { a: 1 },
      extra: true,
    });
  });
});

describe("shortInput", () => {
  const request = {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, description: "Long." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Long." },
      other: { type: "string" },
    },
    required: ["id", "other"],
  };

  it("lists the described properties, drops string lengths and keeps listed requirements", () => {
    const schema = shortInput(
      entry({ request }),
      { id: "Element _id.", limit: "Default 10.", gone: "Not in the entry." },
      new Set(["limit"]),
    );

    expect(z.toJSONSchema(schema, { io: "input" })).toEqual({
      type: "object",
      properties: {
        id: { type: "string", description: "Element _id." },
        limit: { description: "Default 10." },
      },
      required: ["id"],
    });
    expect(schema.parse({ id: "", other: 1 })).toEqual({ id: "", other: 1 });
  });

  it("lists no required array when nothing listed is required", () => {
    const schema = shortInput(entry({ request }), { limit: "Default 10." });

    expect(z.toJSONSchema(schema, { io: "input" })).not.toHaveProperty("required");
  });
});

describe("withoutTrivialKeywords", () => {
  it("drops string propertyNames and empty additionalProperties at any depth", () => {
    expect(
      withoutTrivialKeywords({
        type: "object",
        properties: {
          props: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
          list: { type: "array", items: [{ type: "object", additionalProperties: {} }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        props: { type: "object" },
        list: { type: "array", items: [{ type: "object" }] },
      },
    });
  });

  it("keeps constraining forms of both keywords", () => {
    const schema = {
      type: "object",
      propertyNames: { pattern: "^[a-z]+$" },
      additionalProperties: false,
    };

    expect(withoutTrivialKeywords(schema)).toEqual(schema);
  });
});

describe("annotationsOf", () => {
  it("marks read-only endpoints", () => {
    expect(annotationsOf(entry({ readOnly: true }))).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it("states destructiveHint for every writing endpoint", () => {
    expect(annotationsOf(entry({ destructive: true }))).toMatchObject({ destructiveHint: true });
    expect(annotationsOf(entry())).toMatchObject({ destructiveHint: false });
  });
});

describe("compileManifest", () => {
  it("names tools after their path", () => {
    expect(toolName("/find_elements")).toBe("find_elements");
  });

  it("leaves names of hand-written tools to them", () => {
    const compiled = compileManifest(manifest([entry({ path: "/doctor" })]), new Set(["doctor"]));

    expect(compiled.tools).toEqual([]);
    expect(compiled.skipped).toEqual([
      { path: "/doctor", reason: "name taken by a built-in tool" },
    ]);
  });

  it("skips an endpoint whose schema cannot be converted and keeps the rest", () => {
    const compiled = compileManifest(
      manifest([
        entry({ path: "/broken", request: { type: "object", properties: { a: { type: "foo" } } } }),
        entry({ path: "/scalar", request: { type: "string" } }),
        entry({ path: "/fine" }),
      ]),
    );

    expect(compiled.tools.map((t) => t.name)).toEqual(["fine"]);
    expect(compiled.skipped).toEqual([
      { path: "/broken", reason: expect.stringContaining("foo") },
      { path: "/scalar", reason: "request schema is not an object schema" },
    ]);
  });

  it("reports a non-Error thrown during conversion", async () => {
    const throwing = entry({ path: "/odd" });
    Object.defineProperty(throwing, "request", {
      get: () => {
        throw "odd";
      },
    });

    expect(compileManifest(manifest([throwing])).skipped).toEqual([
      { path: "/odd", reason: "odd" },
    ]);
  });

  it("gives equal entries equal fingerprints", () => {
    const [a] = compileManifest(manifest([entry()])).tools;
    const [b] = compileManifest(manifest([entry()])).tools;
    const [c] = compileManifest(manifest([entry({ description: "Changed." })])).tools;

    expect(a!.fingerprint).toBe(b!.fingerprint);
    expect(a!.fingerprint).not.toBe(c!.fingerprint);
  });
});

describe("version compatibility", () => {
  it.each([
    ["0.3.0", "0.3.0", true],
    ["0.3.7", "0.3.0", true],
    ["v0.3.1-beta.1", "0.3.0", true],
    ["0.2.2", "0.3.0", false],
    ["0.4.0", "0.3.0", false],
    ["1.4.0", "1.0.0", true],
    ["2.0.0", "1.0.0", false],
    ["unknown version", "0.3.0", false],
    ["0.3.0", "garbage", false],
  ])("%s against %s is %s", (actual, expected, compatible) => {
    expect(isCompatibleVersion(actual, expected)).toBe(compatible);
  });

  it.each([
    ["0.3.0", "0.3.x"],
    ["1.2.0", "1.x"],
    ["garbage", "garbage"],
  ])("describes the range of %s as %s", (expected, range) => {
    expect(compatibleRange(expected)).toBe(range);
  });
});
