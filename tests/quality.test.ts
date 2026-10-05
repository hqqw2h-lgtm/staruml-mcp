import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST } from "../src/manifest.js";
import {
  DIAGRAM_QUALITY_DESCRIPTION,
  findingsResult,
  IMPROVE_DIAGRAM_DESCRIPTION,
  improveResult,
  LINT_DIAGRAM_DESCRIPTION,
  lintDiagramInput,
  qualityResult,
} from "../src/quality.js";
import { parseToolSelection } from "../src/tiers.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  // lint_diagram left the core tier in 0.7.0; improve_diagram runs its autofixes.
  mcp = await connect({
    apiHost: HOST,
    apiPort: builtin.port,
    extPort: extension.port,
    catalog: new CatalogState(undefined, parseToolSelection("core,lint_diagram")),
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

const entry = BUNDLED_MANIFEST.endpoints.find((e) => e.path === "/lint_diagram")!;

const DIAGRAM = {
  _id: "D1",
  _type: "UMLClassDiagram",
  name: "Main",
  _parent: "P1",
  path: "Shop/Main",
};

/** Two findings as extension 0.3.0 answers them (src/handlers/lint.ts there). */
const overflow = {
  rule: "L005",
  name: "label-overflow",
  severity: "warning",
  message: 'The name of "Order" needs about 104px and its box is 95px wide',
  ids: ["V1"],
  paths: ["Shop/Order@Shop/Main"],
  fix: "Widen it to 104.",
  autofix: { path: "/resize_node", body: { ref: "V1", width: 104, height: 45 } },
};
const overlap = {
  rule: "L002",
  name: "overlap",
  severity: "error",
  message: "Two views overlap",
  ids: ["V2", "V3"],
  paths: ["Shop/A@Shop/Main", null],
  fix: "Move one of them.",
  autofix: { path: "/move_views", body: { refs: ["V3"], dx: 120, dy: 0 } },
};
const lint = {
  diagram: DIAGRAM,
  count: 2,
  counts: { error: 1, warning: 1, info: 0 },
  truncated: false,
  findings: [overlap, overflow],
};

describe("lint_diagram", () => {
  it("is listed when named, with a one-line description and the diagram and rules", async () => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === "lint_diagram")!;

    expect(tool.description).toBe(LINT_DIAGRAM_DESCRIPTION);
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        diagram: { type: "string", description: "Id or path; default the current one." },
        rules: { description: "Rule ids or names; default all." },
      },
    });
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });

  it("lints a diagram named by path and answers each finding without the ids its paths name", async () => {
    extension.reply("/lint_diagram", { body: { success: true, data: lint } });

    const result = await mcp.call("lint_diagram", { diagram: "D1", rules: ["overlap", "L005"] });

    expect(extension.requests[0]!.body).toEqual({ diagram: "D1", rules: ["overlap", "L005"] });
    const { ids: _ids, ...overflowShown } = overflow;
    expect(JSON.parse(text(result))).toEqual({
      diagram: "Shop/Main",
      count: 2,
      counts: { error: 1, warning: 1, info: 0 },
      // A view of no model has no path, so that finding keeps its ids.
      findings: [overlap, overflowShown],
    });
  });

  it("leaves out the diagram the caller named by its path", async () => {
    extension.reply("/lint_diagram", {
      body: { success: true, data: { ...lint, count: 0, findings: [], truncated: true } },
    });

    const result = await mcp.call("lint_diagram", { diagram: "Shop/Main", limit: 1 });

    expect(JSON.parse(text(result))).toEqual({ count: 0, counts: lint.counts, truncated: true });
  });

  it("checks rules against the whole request schema before sending", async () => {
    const result = await mcp.call("lint_diagram", { rules: "overlap" });

    expect(result.structuredContent).toMatchObject({
      error: { code: "INVALID_ARGUMENT", endpoint: "/lint_diagram" },
    });
    expect(extension.requests).toEqual([]);
  });

  it("sends every autofix of an answer as one batch the server accepts", async () => {
    extension.reply("/batch", { body: { success: true, data: { succeeded: 2, results: [] } } });

    const result = await mcp.call("batch", { ops: lint.findings.map((f) => f.autofix) });

    expect(result.isError).toBeFalsy();
    expect(extension.requests[0]!.body).toEqual({
      ops: [overlap.autofix, overflow.autofix],
    });
  });

  it("lists only the parameters the entry has", () => {
    const schema = z.toJSONSchema(lintDiagramInput({ ...entry, request: { type: "object" } })) as {
      properties: object;
    };

    expect(schema.properties).toEqual({});
  });
});

describe("uml_lint and diff_diagram", () => {
  it("answer through call_endpoint with paths in place of ids", async () => {
    const finding = {
      rule: "U001",
      name: "multiplicity",
      severity: "warning",
      message: "Association end without multiplicity",
      id: "E1",
      path: "Shop/Order.items",
      fix: "Set the multiplicity of the end.",
    };
    extension.reply("/uml_lint", {
      body: {
        success: true,
        data: {
          count: 2,
          counts: { error: 0, warning: 2, info: 0 },
          truncated: false,
          findings: [finding, { ...finding, id: "E2", path: null }],
        },
      },
    });

    const result = await mcp.call("call_endpoint", { name: "uml_lint", body: { scope: "Shop" } });

    const { id: _id, path: _path, ...rest } = finding;
    // The null path is pruned, so that finding keeps its id.
    expect(JSON.parse(text(result))).toMatchObject({
      findings: [
        { ...rest, path: finding.path },
        { ...rest, id: "E2" },
      ],
    });
  });

  it("names the compared diagram by path", async () => {
    const diff = {
      diagram: DIAGRAM,
      kind: "class",
      identical: false,
      added: { nodes: ["Loan"], edges: [] },
      removed: [],
      changed: [],
      unchanged: 2,
    };
    extension.reply("/diff_diagram", { body: { success: true, data: diff } });
    const all = await connect({
      apiHost: HOST,
      apiPort: builtin.port,
      extPort: extension.port,
      catalog: new CatalogState(undefined, parseToolSelection("core,diff_diagram")),
    });
    try {
      const result = await all.call("diff_diagram", {
        diagram: "D1",
        kind: "class",
        spec: { classes: [{ name: "Loan" }] },
      });

      // kind echoes the argument and is dropped.
      expect(JSON.parse(text(result))).toEqual({
        diagram: "Shop/Main",
        identical: false,
        added: { nodes: ["Loan"] },
        unchanged: 2,
      });
    } finally {
      await all.close();
    }
  });
});

describe("findingsResult", () => {
  it("passes answers it does not know as compact JSON", () => {
    expect(text(findingsResult(null, {}))).toBe("null");
    expect(text(findingsResult({ count: 0 }, {}))).toBe('{"count":0}');
  });

  it("keeps a diagram without a path as its id, and ids beside an empty path list", () => {
    const shown = findingsResult(
      {
        diagram: { _id: "D1", _type: "UMLClassDiagram" },
        findings: [{ rule: "L007", ids: ["V1"], paths: [] }, { rule: "U003" }],
      },
      {},
    );

    expect(JSON.parse(text(shown))).toEqual({
      diagram: "D1",
      findings: [{ rule: "L007", ids: ["V1"] }, { rule: "U003" }],
    });
  });
});

/** A /diagram_quality answer of the extension's phase 1h build for a messy class diagram. */
const SCORED = {
  diagram: { _id: "D1", name: "Billing jobs", _type: "UMLClassDiagram" },
  kind: "class",
  score: 41,
  rating: 2,
  target: 80,
  passes: false,
  metrics: { nodes: 5, edges: 4, overlapArea: 15400, overlapPairs: 4, edgeCrossings: 1 },
  penalties: { overlap: 30, nodeEdge: 12.5, edgeEdge: 4, length: 0, bends: 0, whitespace: 2.5 },
  findings: [
    { rule: "L001", name: "stacked", severity: "error", count: 3 },
    { rule: "L002", name: "overlap", severity: "error", count: 1 },
  ],
};

const IMPROVED = {
  diagram: { _id: "D1", name: "Billing jobs", _type: "UMLClassDiagram" },
  kind: "class",
  quality: {
    score: 88,
    rating: 5,
    before: 41,
    target: 80,
    passes: true,
    iterations: 2,
    steps: ["layout hierarchy-down", "overlap removal", "snap", "trim"],
    findings: [{ rule: "L005", name: "label-overflow", severity: "warning", count: 1 }],
  },
};

describe("diagram_quality and improve_diagram", () => {
  let core: ConnectedClient;
  beforeAll(async () => {
    core = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
  });
  afterAll(async () => {
    await core.close();
  });

  it("are core tools listing the diagram, and the dry run for the loop", async () => {
    const { tools } = await core.client.listTools();
    const byName = (name: string) => tools.find((t) => t.name === name)!;

    expect(tools.map((t) => t.name)).not.toContain("lint_diagram");
    expect(byName("diagram_quality")).toMatchObject({
      description: DIAGRAM_QUALITY_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Id or path; default the current one." },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
    expect(byName("improve_diagram")).toMatchObject({
      description: IMPROVE_DIAGRAM_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Id or path; default the current one." },
          dryRun: { description: "Change nothing; answer the score it would reach." },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    });
  });

  it("scores a diagram: the score against its target, the penalties that cost, findings by rule", async () => {
    extension.reply("/diagram_quality", { body: { success: true, data: SCORED } });

    const result = await core.call("diagram_quality", { ref: "Billing jobs" });

    expect(extension.requests[0]!.body).toEqual({ ref: "Billing jobs" });
    expect(JSON.parse(text(result))).toEqual({
      diagram: "Billing jobs",
      kind: "class",
      score: 41,
      target: 80,
      penalties: { overlap: 30, nodeEdge: 12.5, edgeEdge: 4, whitespace: 2.5 },
      findings: { stacked: 3, overlap: 1 },
    });
    expect(Object.keys(JSON.parse(text(result)).penalties)).toEqual([
      "overlap",
      "nodeEdge",
      "edgeEdge",
      "whitespace",
    ]);
  });

  it("renames the old diagram aliases to ref before sending", async () => {
    extension.reply("/diagram_quality", { body: { success: true, data: SCORED } });

    await core.call("diagram_quality", { diagram: "D1" });

    expect(extension.requests[0]!.body).toEqual({ ref: "D1" });
  });

  it("runs the loop and answers the score reached, the unlisted preset passing through", async () => {
    extension.reply("/improve_diagram", { body: { success: true, data: IMPROVED } });

    const result = await core.call("improve_diagram", { ref: "D1", preset: "hierarchy-right" });

    expect(extension.requests[0]!.body).toEqual({ ref: "D1", preset: "hierarchy-right" });
    expect(JSON.parse(text(result))).toEqual({
      diagram: "Billing jobs",
      kind: "class",
      quality: { score: 88, target: 80, iterations: 2, findings: { "label-overflow": 1 } },
    });
  });

  it("refuses a preset or target the request schema does not take", async () => {
    const bad = await core.call("improve_diagram", { preset: "spiral" });
    const far = await core.call("improve_diagram", { target: 101 });

    expect(bad.structuredContent).toMatchObject({
      error: { code: "INVALID_ARGUMENT", endpoint: "/improve_diagram" },
    });
    expect(far.structuredContent).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    expect(extension.requests).toEqual([]);
  });

  it("names an unnamed diagram by its id and passes other answers as JSON", () => {
    const unnamed = { ...SCORED, diagram: { _id: "D2", name: null } };
    expect(JSON.parse(text(qualityResult(unnamed, {}))).diagram).toBe("D2");
    expect(text(qualityResult({ count: 0 }, {}))).toBe('{"count":0}');
    expect(text(qualityResult(null, {}))).toBe("null");
    expect(JSON.parse(text(qualityResult({ score: 90 }, {})))).toEqual({ score: 90 });
    expect(text(improveResult(null, {}))).toBe("null");
    expect(text(improveResult({ quality: { score: 1 } }, {}))).toBe('{"quality":{"score":1}}');
  });
});

describe("model_lint", () => {
  it("answers through call_endpoint without the ids its paths name", async () => {
    const finding = {
      rule: "M004",
      name: "anaemic-entity",
      severity: "info",
      message: "Payment holds data but no behaviour",
      id: "C1",
      path: "Shop/Payment",
      fix: "Move the operations that use its data into it.",
    };
    extension.reply("/model_lint", {
      body: {
        success: true,
        data: {
          count: 1,
          counts: { error: 0, warning: 0, info: 1 },
          truncated: false,
          findings: [finding],
        },
      },
    });

    const result = await mcp.call("call_endpoint", { name: "model_lint", body: { scope: "Shop" } });

    const { id: _id, ...shown } = finding;
    expect(JSON.parse(text(result))).toEqual({
      count: 1,
      counts: { error: 0, warning: 0, info: 1 },
      findings: [shown],
    });
  });
});
