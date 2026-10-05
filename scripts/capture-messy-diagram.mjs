#!/usr/bin/env node
// Records what a running StarUML answers while a messy class diagram is fixed, for the "fix a
// messy diagram" part of scripts/token-benchmark.mjs. The diagram is drawn the way an agent
// placing views by hand leaves it: five classes with long names, three stacked at one point, two
// overlapping, and four associations. Then both ways of fixing it run from the same start:
//
// - by eye: Format > Layout through /layout_diagram, the PNG before and after;
// - the lint loop (#13): /lint_diagram, every finding's autofix in one /batch, /lint_diagram
//   again, the PNG once.
//
// /lint_diagram also runs after the layout, to record what looking at the picture left. Snapshots
// put the project back: the diagram is gone afterwards.
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

const start = await ext("/snapshot", { label: "capture-messy-start" });
try {
  const parent = (await ext("/get_project_info")).project._id;
  const ops = [
    { path: "/create_element", body: { type: "UMLModel", parent, name: "Billing" }, as: "m" },
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
  const diagramId = drawn.results[1].data._id;
  const png = async () => pngSize(await post(58321, "/get_diagram_image_by_id", { diagramId }));
  const lint = () => ext("/lint_diagram", { diagram: diagramId });

  const before = { png: await png(), lint: await lint() };

  await ext("/snapshot", { label: "capture-messy-drawn" });
  const layout = await ext("/layout_diagram", { diagram: diagramId });
  const byEye = { layout, png: await png(), lint: await lint() };
  await ext("/restore_snapshot", { snapshot: "capture-messy-drawn" });

  const fixes = before.lint.findings.flatMap((f) => (f.autofix ? [f.autofix] : []));
  const batch = await ext("/batch", { ops: fixes, result: "full" });
  const loop = { fixes, batch, lint: await lint(), png: await png() };

  const versions = await ext("/introspect", { include: [] });
  const out = new URL("benchmark-data/messy-diagram-7.1.1.json", import.meta.url);
  writeFileSync(
    out,
    `${JSON.stringify({ versions, nodes: NODES, edges: EDGES, diagramId, before, byEye, loop }, null, 2)}\n`,
  );
  console.log(
    `Wrote ${out.pathname}: ${before.lint.count} findings before, ${byEye.lint.count} after the ` +
      `layout, ${loop.lint.count} after ${fixes.length} autofixes.`,
  );
} finally {
  await ext("/restore_snapshot", { snapshot: start.label });
}
