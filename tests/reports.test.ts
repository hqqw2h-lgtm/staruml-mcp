import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compactQuality, compactStyle, countsByRule, withReports } from "../src/reports.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  mcp = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
});

afterEach(() => {
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await mcp.close();
  await Promise.all([builtin.stop(), extension.stop()]);
});

/** The loop's report as extension #32 attaches it (src/quality/loop.ts `qualitySchema`). */
const QUALITY = {
  score: 91,
  rating: 5,
  before: 64,
  target: 80,
  passes: true,
  iterations: 2,
  steps: ["layout hierarchy-down", "snap", "trim"],
  findings: [{ rule: "L005", name: "label-overflow", severity: "warning", count: 1 }],
};

const STYLE = {
  profile: "uml-standard",
  renamed: [{ kind: "classifier", from: "order_line", to: "OrderLine" }],
  styled: 3,
};

describe("countsByRule", () => {
  it("counts findings by rule name", () => {
    expect(
      countsByRule([
        { rule: "L005", name: "label-overflow", severity: "warning", count: 2 },
        { rule: "L002", name: "overlap", severity: "error", count: 1 },
      ]),
    ).toEqual({ "label-overflow": 2, overlap: 1 });
  });

  it.each([[undefined], ["x"], [[{ rule: "L005" }]], [[null]], [[{ name: "a", count: "2" }]]])(
    "passes %j as it is",
    (findings) => {
      expect(countsByRule(findings)).toBe(findings);
    },
  );
});

describe("compactQuality", () => {
  it("keeps the score, target, iterations and the findings left by rule", () => {
    expect(compactQuality(QUALITY)).toEqual({
      score: 91,
      target: 80,
      iterations: 2,
      findings: { "label-overflow": 1 },
    });
  });

  it("leaves out what the report lacks", () => {
    expect(compactQuality({ score: 70 })).toEqual({ score: 70 });
  });

  it("keeps the hard limits a failing diagram broke, and drops an empty list (#38)", () => {
    const failures = ["aspect 3.14 > 3", "61 boxes > 60"];
    expect(compactQuality({ ...QUALITY, score: 59, failures })).toMatchObject({
      score: 59,
      failures,
    });
    expect(compactQuality({ score: 90, failures: [] })).toEqual({ score: 90 });
    expect(compactQuality({ score: 90, failures: "none" })).toEqual({ score: 90 });
  });

  it.each([[null], [7], [{ min: 82, mean: 90, passing: 25, failing: [] }]])(
    "passes %j, which is not the loop's report, as it is",
    (value) => {
      expect(compactQuality(value)).toBe(value);
    },
  );
});

describe("compactStyle", () => {
  it("writes each rename as from: to", () => {
    expect(compactStyle(STYLE)).toEqual({
      profile: "uml-standard",
      renamed: { order_line: "OrderLine" },
      styled: 3,
    });
  });

  it.each([
    [{ profile: "minimal" }],
    [{ profile: "minimal", renamed: [{ from: "a" }] }],
    [{ name: "uml-standard", strict: true }],
    [null],
  ])("passes %j as it is", (value) => {
    expect(compactStyle(value)).toBe(value);
  });
});

describe("withReports", () => {
  it("compacts the top-level reports and keeps every other field", () => {
    expect(withReports({ created: 3, quality: QUALITY, style: STYLE })).toEqual({
      created: 3,
      quality: { score: 91, target: 80, iterations: 2, findings: { "label-overflow": 1 } },
      style: { profile: "uml-standard", renamed: { order_line: "OrderLine" }, styled: 3 },
    });
    expect(withReports({ quality: QUALITY })).not.toHaveProperty("style");
    expect(withReports({ style: STYLE })).not.toHaveProperty("quality");
  });

  it.each([[null], ["ok"], [[1]], [{ created: 1 }]])("passes %j as it is", (value) => {
    expect(withReports(value)).toBe(value);
  });
});

describe("authoring answers", () => {
  it("build_diagram answers its style and quality reports compacted", async () => {
    extension.reply("/build_diagram", {
      body: {
        success: true,
        data: {
          diagram: { _id: "D1", _type: "UMLClassDiagram", name: "Mess" },
          kind: "class",
          created: 3,
          style: STYLE,
          quality: QUALITY,
        },
      },
    });

    const result = await mcp.call("build_diagram", {
      kind: "class",
      name: "Mess",
      spec: { classes: [{ name: "Order" }] },
    });

    expect(JSON.parse(text(result))).toEqual({
      diagram: { _id: "D1", _type: "UMLClassDiagram", name: "Mess" },
      created: 3,
      style: { profile: "uml-standard", renamed: { order_line: "OrderLine" }, styled: 3 },
      quality: { score: 91, target: 80, iterations: 2, findings: { "label-overflow": 1 } },
    });
  });

  it("an endpoint without a shape of its own, through call_endpoint, too", async () => {
    extension.reply("/layout_diagram", {
      body: { success: true, data: { _id: "D1", quality: { ...QUALITY, findings: [] } } },
    });

    const result = await mcp.call("call_endpoint", {
      name: "layout_diagram",
      body: { diagram: "D1" },
    });

    expect(JSON.parse(text(result))).toEqual({
      _id: "D1",
      quality: { score: 91, target: 80, iterations: 2 },
    });
  });
});
