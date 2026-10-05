#!/usr/bin/env node
// Records what a running StarUML answers while a messy class diagram is fixed, for the "fix a
// messy diagram" part of scripts/token-benchmark.mjs. The diagram is drawn the way an agent
// placing views by hand leaves it: five classes with long names, three stacked at one point, two
// overlapping, and four associations. Then both ways of fixing it run from the same start:
//
// - by eye: Format > Layout through /layout_diagram, the PNG before and after;
// - the lint loop (#13): /lint_diagram, every finding's autofix in one /batch, /lint_diagram
//   again, the PNG once;
// - the quality loop (#16, extension #32): /diagram_quality, /improve_diagram, the PNG once.
//
// /diagram_quality scores the result of each way, so the benchmark can say which reaches the
// profile's target (80 in every built-in profile).
//
// /lint_diagram also runs after the layout, to record what looking at the picture left. Each way
// is one undo step and is undone before the next starts (the phase 1h build answers
// SNAPSHOT_STALE to a /restore_snapshot past /layout_diagram's quality step), and the capture's
// model is deleted at the end.
//
// Usage: node scripts/capture-messy-diagram.mjs [--url http://localhost] (needs StarUML 7 with its
// API server on 58321 and staruml-mcp-extension 0.3 with /lint_diagram on 58322; STARUML_EXT_TOKEN
// is sent when set).

import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { url: { type: "string", default: "http://localhost" } },
});

async function post(port, path, body) {
  const res = await fetch(`${args.url}:${port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(port === 58322 && process.env.STARUML_EXT_TOKEN
        ? { Authorization: `Bearer ${process.env.STARUML_EXT_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.success !== true) {
    throw new Error(`${path} answered HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json.data;
}

const ext = (path, body = {}) => post(58322, path, body);

/** Width and height from a PNG's IHDR chunk (PNG spec 11.2.2: bytes 16-23, big-endian). */
function pngSize(base64) {
  const bytes = Buffer.from(base64, "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

/** Name and position of each class: three at one point, two overlapping that stack. */
const NODES = [
  ["SubscriptionRenewalScheduler", 120, 120],
  ["InvoiceNumberingPolicy", 120, 120],
  ["CustomerNotificationGateway", 120, 120],
  ["PaymentRetryStrategy", 420, 140],
  ["LedgerPostingService", 460, 170],
];
const EDGES = [
  [0, 1],
  [0, 2],
  [0, 3],
  [3, 4],
];

let model;
try {
  const parent = (await ext("/get_project_info")).project._id;
  const ops = [
    { path: "/create_element", body: { type: "UMLModel", parent, name: "Messy capture" }, as: "m" },
    {
      path: "/create_diagram",
      body: { type: "UMLClassDiagram", parent: "$m", name: "Billing jobs" },
      as: "d",
    },
    ...NODES.map(([name, x, y], i) => ({
      path: "/create_element_with_view",
      body: { type: "UMLClass", parent: "$m", diagram: "$d", name, x, y },
      as: `n${i}`,
    })),
    ...EDGES.map(([tail, head]) => ({
      path: "/create_edge_with_view",
      body: {
        type: "UMLAssociation",
        diagram: "$d",
        tail: `$n${tail}.view`,
        head: `$n${head}.view`,
      },
    })),
  ];
  // result: "full" asks a newer /batch for every op's answer, which 0.3.0 gives unasked; 0.3.0
  // drops the unknown key.
  const drawn = await ext("/batch", { ops, result: "full" });
  model = drawn.results[0].data._id;
  const diagramId = drawn.results[1].data._id;
  const png = async () => pngSize(await post(58321, "/get_diagram_image_by_id", { diagramId }));
  const lint = () => ext("/lint_diagram", { diagram: diagramId });
  const score = () => ext("/diagram_quality", { ref: diagramId });

  const before = { png: await png(), lint: await lint(), quality: await score() };

  const layout = await ext("/layout_diagram", { diagram: diagramId });
  const byEye = { layout, png: await png(), lint: await lint(), quality: await score() };
  await ext("/undo");

  const fixes = before.lint.findings.flatMap((f) => (f.autofix ? [f.autofix] : []));
  // The answer as the batch tool gets it: terse by default since the extension's phase 1g.
  const batch = await ext("/batch", { ops: fixes });
  const loop = { fixes, batch, lint: await lint(), png: await png(), quality: await score() };
  await ext("/undo");

  const improved = await ext("/improve_diagram", { ref: diagramId });
  const quality = { improved, png: await png(), lint: await lint(), after: await score() };

  const versions = await ext("/introspect", { include: [] });
  const out = new URL("benchmark-data/messy-diagram-7.1.1.json", import.meta.url);
  writeFileSync(
    out,
    `${JSON.stringify({ versions, nodes: NODES, edges: EDGES, diagramId, before, byEye, loop, quality }, null, 2)}\n`,
  );
  console.log(
    `Wrote ${out.pathname}: ${before.lint.count} findings before, ${byEye.lint.count} after the ` +
      `layout, ${loop.lint.count} after ${fixes.length} autofixes; score ${before.quality.score} ` +
      `before, ${byEye.quality.score} after the layout, ${loop.quality.score} after the autofixes, ` +
      `${quality.after.score} after improve_diagram.`,
  );
} finally {
  // A failed clean-up must not hide the error that got here.
  if (model !== undefined) {
    await ext("/delete_element", { ref: model }).catch((error) =>
      console.error(`Could not delete the capture's model ${model}: ${error.message}`),
    );
  }
}
