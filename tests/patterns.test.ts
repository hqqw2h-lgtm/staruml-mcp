/**
 * build_model (core) and apply_pattern (listed by name since 0.8.0), and the shapes of the pattern, preset, theme and sync
 * answers reached through call_endpoint. Answers are what extension #23 and #30 gave StarUML
 * 7.1.1 for a Strategy over a three-class "Shipping" model.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BUILD_MODEL_DESCRIPTION, countedPlan, modelResult } from "../src/model.js";
import { APPLY_PATTERN_DESCRIPTION, detectResult, patternResult } from "../src/patterns.js";
import { CatalogState } from "../src/extension-tools.js";
import { parseToolSelection } from "../src/tiers.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  mcp = await connect({
    apiHost: "http://127.0.0.1",
    apiPort: builtin.port,
    extPort: extension.port,
    catalog: new CatalogState(undefined, parseToolSelection("core,apply_pattern")),
  });
});

afterEach(() => {
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await mcp.close();
  await Promise.all([builtin.stop(), extension.stop()]);
});

const ok = (data: unknown) => ({ body: { success: true, data } });
const json = (result: Parameters<typeof text>[0]) => JSON.parse(text(result)) as unknown;

const SPEC = {
  system: "Shipping",
  classes: [
    { name: "Order", responsibility: "Prices and ships a purchase" },
    { name: "FlatRate" },
    { name: "ByWeight" },
  ],
  relationships: [{ from: "Order", to: "FlatRate", type: "uses" }],
};

const BUILT = {
  model: { _id: "M1", name: "Shipping", path: "Shipping" },
  upserted: false,
  counts: { created: { UMLModel: 1, UMLClass: 3 }, updated: {}, unchanged: 0 },
};

const OP = { path: "/create_element", body: { parent: "@project", type: "UMLModel" }, as: "m0" };
const STEP = { op: "/create_element", target: "@project", as: "m0", type: "UMLModel" };

const BUILD_DRY_RUN = {
  model: { _id: "$m0", name: "Shipping", path: "Shipping" },
  upserted: false,
  counts: { created: { UMLModel: 1 }, updated: {}, unchanged: 0 },
  changes: { created: [{ path: "Shipping", type: "UMLModel" }], updated: [] },
  dryRun: true,
  plan: { ops: [OP, OP], creates: [STEP], updates: [], deletes: [] },
};

const BINDINGS = {
  Context: "Shipping/Order",
  Strategy: "ShippingPolicy",
  ConcreteStrategy: ["Shipping/FlatRate", { new: { name: "ByWeight" } }],
};

const APPLIED = {
  pattern: "Strategy",
  roles: {
    Context: [{ _id: "C1", path: "Shipping/Order", created: false }],
    Strategy: [{ _id: "S1", path: "Shipping/ShippingPolicy", created: true }],
    ConcreteStrategy: [
      { _id: "F1", path: "Shipping/FlatRate", created: false },
      { _id: "B1", path: "Shipping/ByWeight", created: true },
    ],
  },
  created: 4,
  updated: 1,
  unchanged: 0,
  changes: {
    created: [
      { path: "Shipping/ShippingPolicy", type: "UMLInterface" },
      { path: "Shipping/ShippingPolicy#execute()", type: "UMLOperation" },
      { path: "Shipping/Order -> Shipping/ShippingPolicy", type: "UMLAssociation" },
    ],
    updated: [{ path: "Shipping/Order", type: "UMLClass", fields: ["documentation"] }],
  },
  properties: [
    { path: "Shipping/ShippingPolicy#execute()", field: "isAbstract", value: true },
    {
      path: "Shipping/Order -> Shipping/ShippingPolicy.end1",
      field: "aggregation",
      value: "shared",
    },
    { path: "Shipping/Order -> Shipping/ShippingPolicy.end2", field: "name", value: "strategy" },
    { path: "Shipping/Order -> Shipping/ShippingPolicy.end2", field: "multiplicity", value: "1" },
    { path: "Shipping/Order#setStrategy().strategy", field: "type", value: { $ref: "S1" } },
  ],
  diagram: "D1",
};

/** What the model reads for {@link APPLIED}. */
const APPLIED_SHOWN = {
  pattern: "Strategy",
  created: 4,
  updated: 1,
  unchanged: 0,
  diagram: "D1",
  roles: {
    Context: ["Shipping/Order"],
    Strategy: ["Shipping/ShippingPolicy"],
    ConcreteStrategy: ["Shipping/FlatRate", "Shipping/ByWeight"],
  },
  changes: {
    created: {
      "Shipping/ShippingPolicy": "UMLInterface",
      "Shipping/ShippingPolicy#execute()": "UMLOperation",
      "Shipping/Order -> Shipping/ShippingPolicy": "UMLAssociation",
    },
    updated: { "Shipping/Order": ["documentation"] },
  },
  properties: {
    "Shipping/ShippingPolicy#execute()": { isAbstract: true },
    "Shipping/Order -> Shipping/ShippingPolicy.end1": { aggregation: "shared" },
    "Shipping/Order -> Shipping/ShippingPolicy.end2": { name: "strategy", multiplicity: "1" },
    "Shipping/Order#setStrategy().strategy": { type: { $ref: "S1" } },
  },
};

describe("build_model tool (extension #23)", () => {
  it("is listed in the core tier with spec, upsert and dryRun", async () => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === "build_model")!;

    expect(tool.description).toBe(BUILD_MODEL_DESCRIPTION);
    expect(BUILD_MODEL_DESCRIPTION.length).toBeLessThanOrEqual(100);
    expect(Object.keys(tool.inputSchema.properties!)).toEqual(["spec", "upsert", "dryRun"]);
    expect(tool.inputSchema.required).toEqual(["spec"]);
    const spec = (tool.inputSchema.properties as { spec: Record<string, string> }).spec;
    // Every relationship verb of the manifest's spec description, with no type keyword.
    for (const verb of ["owns", "has", "uses", "isA", "implements", "knows"]) {
      expect(spec.description).toContain(verb);
    }
    expect(spec).not.toHaveProperty("type");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("sends the spec as written, with the unlisted parent and result, and answers the counts", async () => {
    extension.reply("/build_model", ok(BUILT));

    const result = await mcp.call("build_model", {
      spec: SPEC,
      upsert: true,
      parent: "@project",
      result: "terse",
    });

    expect(extension.requests).toEqual([
      {
        method: "POST",
        path: "/build_model",
        body: { spec: SPEC, upsert: true, parent: "@project", result: "terse" },
      },
    ]);
    expect(json(result)).toEqual({
      model: BUILT.model,
      upserted: false,
      counts: { created: { UMLModel: 1, UMLClass: 3 }, unchanged: 0 },
    });
  });

  it("answers a dry run with its ops counted and without the placeholder id", async () => {
    extension.reply("/build_model", ok(BUILD_DRY_RUN));

    const result = await mcp.call("build_model", { spec: SPEC, dryRun: true });

    expect(json(result)).toEqual({
      model: { name: "Shipping", path: "Shipping" },
      upserted: false,
      counts: { created: { UMLModel: 1 }, unchanged: 0 },
      changes: { created: [{ path: "Shipping", type: "UMLModel" }] },
      // changes names each step, so the plan's own step lists are dropped.
      plan: { ops: 2 },
    });
  });

  it.each([
    ["a spec that is not an object", { spec: [1] }, /^spec: /],
    ["an unknown key", { spec: SPEC, prune: true }, /Unrecognized key: "prune"/],
    ["a result mode it lacks", { spec: SPEC, result: "all" }, /^result: /],
  ])("refuses %s before sending", async (_, args, message) => {
    const result = await mcp.call("build_model", args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "INVALID_ARGUMENT", endpoint: "/build_model", message },
    });
    expect(extension.requests).toEqual([]);
  });
});

describe("apply_pattern tool (extension #30)", () => {
  it("is reached through call_endpoint under the core tier and shaped the same way", async () => {
    const core = await connect({
      apiHost: "http://127.0.0.1",
      apiPort: builtin.port,
      extPort: extension.port,
    });
    try {
      const { tools } = await core.client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("apply_pattern");
      extension.reply("/apply_pattern", ok(APPLIED));

      const result = await core.call("call_endpoint", {
        name: "apply_pattern",
        body: { pattern: "Strategy", bindings: BINDINGS },
      });

      expect(text(result)).toBe(text(patternResult(APPLIED, { pattern: "Strategy" })));
    } finally {
      await core.close();
    }
  });

  it("is listed by name with pattern, bindings, diagram and dryRun", async () => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === "apply_pattern")!;

    expect(tool.description).toBe(APPLY_PATTERN_DESCRIPTION);
    expect(Object.keys(tool.inputSchema.properties!)).toEqual([
      "pattern",
      "bindings",
      "diagram",
      "dryRun",
    ]);
    expect(tool.inputSchema.required).toEqual(["pattern"]);
    expect(JSON.stringify(tool.inputSchema)).not.toContain("anyOf");
  });

  it("sends bindings by path as written and answers roles, changes and properties by path", async () => {
    extension.reply("/apply_pattern", ok(APPLIED));
    const args = {
      pattern: "Strategy",
      bindings: BINDINGS,
      diagram: "Shipping strategy",
      parent: "Shipping",
      variant: "abstract-class",
      sequence: false,
      upsert: true,
    };

    const result = await mcp.call("apply_pattern", args);

    expect(extension.requests).toEqual([{ method: "POST", path: "/apply_pattern", body: args }]);
    // pattern echoes the argument, so it is dropped like every echo.
    const { pattern: _echo, ...shown } = APPLIED_SHOWN;
    expect(json(result)).toEqual(shown);
  });

  it("answers a dry run with its ops counted, placeholder ids dropped and paths kept", async () => {
    const roles = { Strategy: [{ _id: "$m0", path: "Shipping/ShippingPolicy", created: true }] };
    extension.reply(
      "/apply_pattern",
      ok({ ...APPLIED, roles, dryRun: true, plan: { ops: [OP, OP, OP], creates: [STEP] } }),
    );

    const result = await mcp.call("apply_pattern", { pattern: "Strategy", dryRun: true });

    // dryRun echoes the argument and is dropped like every echo.
    expect(json(result)).toMatchObject({
      roles: { Strategy: ["Shipping/ShippingPolicy"] },
      plan: { ops: 3 },
    });
  });

  it.each([
    ["an empty path", { Context: "" }],
    ["a number", { Context: 7 }],
    ["a new element without a name", { Strategy: { new: {} } }],
    ["a list with a bad item", { ConcreteStrategy: ["Shipping/FlatRate", 3] }],
  ])("refuses a binding to %s before sending", async (_, bindings) => {
    const result = await mcp.call("apply_pattern", { pattern: "Strategy", bindings });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "INVALID_ARGUMENT", endpoint: "/apply_pattern" },
    });
    expect(text(result)).toMatch(/^Failed to apply pattern: bindings\./);
    expect(extension.requests).toEqual([]);
  });

  it("passes the extension's refusal of an unknown pattern through", async () => {
    extension.reply("/apply_pattern", {
      status: 404,
      body: { success: false, code: "NOT_FOUND", error: "No pattern Stratgy; see /list_patterns" },
    });

    const result = await mcp.call("apply_pattern", { pattern: "Stratgy" });

    expect(text(result)).toBe(
      "Failed to apply pattern: No pattern Stratgy; see /list_patterns [NOT_FOUND, /apply_pattern, HTTP 404]",
    );
  });
});

describe("pattern, preset, theme and sync answers through call_endpoint", () => {
  const call = (name: string, body: Record<string, unknown>) =>
    mcp.call("call_endpoint", { name, body });

  it("answers detect_patterns with each role's elements as paths, an id where none", async () => {
    const detections = [
      {
        pattern: "Strategy",
        confidence: 1,
        roles: {
          Context: [{ _id: "C1", path: "Shipping/Order" }],
          Strategy: [{ _id: "S1", path: null }],
        },
        missing: [],
      },
    ];
    extension.reply("/detect_patterns", ok({ count: 1, detections }));

    const result = await call("detect_patterns", { scope: "Shipping", patterns: ["Strategy"] });

    expect(json(result)).toEqual({
      count: 1,
      detections: [
        {
          pattern: "Strategy",
          confidence: 1,
          roles: { Context: ["Shipping/Order"], Strategy: ["S1"] },
        },
      ],
    });
  });

  it("answers apply_preset with the element as its path and the properties grouped", async () => {
    const preset = {
      element: { _id: "F1", path: "Shipping/FlatRate" },
      preset: "immutable",
      changes: {
        created: [],
        updated: [{ path: "Shipping/FlatRate", type: "UMLClass", fields: ["isLeaf"] }],
      },
      properties: [{ path: "Shipping/FlatRate", field: "isLeaf", value: true }],
      dryRun: true,
      plan: { ops: [OP], creates: [], updates: [STEP], deletes: [] },
    };
    extension.reply("/apply_preset", ok(preset));

    const result = await call("apply_preset", {
      ref: "Shipping/FlatRate",
      preset: "immutable",
      dryRun: true,
    });

    expect(json(result)).toEqual({
      element: "Shipping/FlatRate",
      changes: { updated: { "Shipping/FlatRate": ["isLeaf"] } },
      properties: { "Shipping/FlatRate": { isLeaf: true } },
      plan: { ops: 1 },
    });
  });

  it.each(["apply_theme", "sync_operations"])("counts the ops of a %s dry run", async (name) => {
    extension.reply(`/${name}`, ok({ diagram: "D1", dryRun: true, plan: { ops: [OP, OP] } }));
    const body =
      name === "apply_theme"
        ? { ref: "D1", theme: "blueprint", dryRun: true }
        : { diagram: "D1", dryRun: true };

    expect(json(await call(name, { ...body, dryRun: false }))).toMatchObject({ plan: { ops: 2 } });
    // Without changes beside it, the plan keeps its steps.
    extension.reply(`/${name}`, ok({ dryRun: true, plan: { ops: [OP], updates: [STEP] } }));
    expect(json(await call(name, body))).toEqual({ plan: { ops: 1, updates: [STEP] } });
    extension.reply(`/${name}`, ok({ diagram: "D1", dryRun: true, plan: { ops: [OP, OP] } }));
    expect(json(await call(name, body))).toEqual(
      name === "apply_theme" ? { diagram: "D1", plan: { ops: 2 } } : { plan: { ops: 2 } },
    );
  });

  it("refuses an unknown theme before sending", async () => {
    const result = await call("apply_theme", { ref: "D1", theme: "neon" });

    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    expect(extension.requests).toEqual([]);
  });
});

describe("answer shapes", () => {
  it("leave anything not shaped like the extension's answer as compact JSON", () => {
    const plain = (result: ReturnType<typeof patternResult>) => text(result);

    expect(plain(patternResult(null, {}))).toBe("null");
    expect(plain(detectResult(null, {}))).toBe("null");
    expect(plain(detectResult({ detections: [7, { pattern: "P" }] }, {}))).toBe(
      '{"detections":[7,{"pattern":"P"}]}',
    );
    expect(plain(modelResult({ dryRun: true, plan: { ops: 3 } }, {}))).toBe(
      '{"dryRun":true,"plan":{"ops":3}}',
    );
    expect(
      json(
        patternResult(
          {
            roles: { A: "x", B: [{ _id: "I1" }] },
            element: { _id: "E1" },
            changes: { created: [{ type: "T" }], updated: "u" },
            properties: [{ path: "A", value: 1 }],
          },
          {},
        ),
      ),
    ).toEqual({
      roles: { A: "x", B: ["I1"] },
      element: "E1",
      changes: { created: [{ type: "T" }], updated: "u" },
      properties: [{ path: "A", value: 1 }],
    });
    expect(json(patternResult({ roles: 5, changes: {} }, {}))).toEqual({ roles: 5, changes: {} });
  });

  it("keep a real run's ids and a dry run's ids of existing elements", () => {
    const data = { dryRun: true, roles: { A: [{ _id: "I1", path: "P" }] }, plan: { ops: [] } };

    expect(countedPlan({ roles: { A: [{ _id: "$m0" }] } })).toEqual({
      roles: { A: [{ _id: "$m0" }] },
    });
    expect(countedPlan(data)).toEqual({ ...data, plan: { ops: 0 } });
    expect(countedPlan(null)).toBeNull();
  });
});
