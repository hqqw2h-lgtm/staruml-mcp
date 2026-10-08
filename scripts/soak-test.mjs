#!/usr/bin/env node
// Soak test over stdio: starts the built server (dist/index.js) against an in-process stub of both
// StarUML ports, sends tool calls one after another through the MCP SDK client (a rotation of
// get_all_diagrams_info, quick_find, get_preference and performance_stats through call_endpoint,
// call_endpoint find_elements, batch, build_diagram, lint_diagram through
// call_endpoint, diagram_quality, and dry runs of improve_diagram, build_model, and of
// apply_pattern and derive_diagrams through call_endpoint),
// and compares the first and the last --window of --calls
// measured calls. The server's resident set
// size is sampled with ps every --sample calls, and its live heap after a full GC is read at the
// end of both windows. Exits non-zero when any call failed, or when the mean RSS, the live heap or the p99
// latency of the last window exceeds the first by more than --max-growth percent: a leak or a
// slowdown that builds up over a session.
//
// --warmup calls run first and are not measured. Without them the first window is the cold start:
// RSS rises from about 95 to 165 MB over the first 2000 calls while the live heap after GC stays at
// 19-22 MB, flat over 20,000 calls (V8 sizing its spaces, not a leak), so a cold window measures
// startup rather than the session.
//
// Usage: npm run build && node scripts/soak-test.mjs
//          [--calls 2000] [--warmup 2000] [--window 200] [--sample 10] [--max-growth 25]
//          [--p99-floor-ms 2]
// The p99 of 200 calls is their second slowest, around 1-2 ms against the stub, so one scheduler
// stall on a busy machine doubles it; p99 growth fails only when it also exceeds --p99-floor-ms.
// Needs `ps` and SIGUSR2 (macOS, Linux).

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values: args } = parseArgs({
  options: {
    calls: { type: "string", default: "2000" },
    warmup: { type: "string", default: "2000" },
    window: { type: "string", default: "200" },
    sample: { type: "string", default: "10" },
    "max-growth": { type: "string", default: "25" },
    "p99-floor-ms": { type: "string", default: "2" },
  },
});
const calls = Number(args.calls);
const warmup = Number(args.warmup);
const window = Number(args.window);
const every = Number(args.sample);
const maxGrowth = Number(args["max-growth"]);
const p99Floor = Number(args["p99-floor-ms"]);
const entry = new URL("../dist/index.js", import.meta.url);

if (!existsSync(entry)) {
  console.error("dist/index.js is missing; run `npm run build` first.");
  process.exit(2);
}

const HEAP_HOOK = `process.on("SIGUSR2", () => {
  globalThis.gc();
  process.stderr.write("[soak] heap " + process.memoryUsage().heapUsed + "\\n");
});`;

const ROTATION = [
  { name: "get_all_diagrams_info", arguments: {} },
  { name: "quick_find", arguments: { text: "order" } },
  {
    name: "call_endpoint",
    arguments: { name: "get_preference", body: { key: "diagramEditor.showGrid" } },
  },
  { name: "call_endpoint", arguments: { name: "performance_stats" } },
  {
    name: "call_endpoint",
    arguments: { name: "find_elements", body: { type: "UMLClass", limit: 10 } },
  },
  {
    name: "batch",
    arguments: {
      ops: [
        { path: "/get_project_info", as: "p" },
        { path: "/get_element_by_id", body: { ref: "$p.project" } },
      ],
    },
  },
  {
    name: "build_diagram",
    arguments: { mermaid: "classDiagram\n  Order --> Line", name: "soak", upsert: true },
  },
  { name: "call_endpoint", arguments: { name: "lint_diagram", body: { diagram: "soak" } } },
  { name: "diagram_quality", arguments: { ref: "soak" } },
  { name: "improve_diagram", arguments: { ref: "soak", dryRun: true } },
  {
    name: "call_endpoint",
    arguments: { name: "derive_diagrams", body: { scope: "Soak", dryRun: true } },
  },
  {
    name: "build_model",
    arguments: { spec: { system: "Soak", classes: [{ name: "Order" }] }, dryRun: true },
  },
  // Issue #20: an intent's view and the template list, both shaped by this server.
  {
    name: "call_endpoint",
    arguments: {
      name: "request_diagram",
      body: { intent: "which states can an order be in", scope: "Soak", dryRun: true },
    },
  },
  { name: "call_endpoint", arguments: { name: "list_templates" } },
  {
    name: "call_endpoint",
    arguments: {
      name: "apply_pattern",
      body: { pattern: "Strategy", bindings: { Context: "Order" }, dryRun: true },
    },
  },
];

const stub = await startStub();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    // SIGUSR2 makes the server collect garbage and report its live heap on stderr.
    "--expose-gc",
    "--import",
    `data:text/javascript,${encodeURIComponent(HEAP_HOOK)}`,
    fileURLToPath(entry),
    "--api-host",
    "http://127.0.0.1",
    "--api-port",
    String(stub.port),
    "--ext-port",
    String(stub.port),
  ],
  stderr: "pipe",
});
const client = new Client({ name: "soak-test", version: "0" });
await client.connect(transport);
const pid = transport.pid;
let stderr = "";
transport.stderr.setEncoding("utf8");
transport.stderr.on("data", (chunk) => (stderr += chunk));

const latencies = [];
const rss = [];
const heap = [];
let errors = 0;
let firstError;
try {
  for (let i = 0; i < warmup; i++) await client.callTool(ROTATION[i % ROTATION.length]);
  for (let i = 0; i < calls; i++) {
    const t0 = performance.now();
    const result = await client.callTool(ROTATION[i % ROTATION.length]);
    latencies.push(performance.now() - t0);
    if (result.isError) {
      errors++;
      firstError ??= JSON.stringify(result.content);
    }
    if (i % every === 0 || i === calls - 1) rss.push({ at: i, kb: residentKb(pid) });
    if (i === window - 1 || i === calls - 1) heap.push(await liveHeapMb());
  }
} finally {
  await client.close();
  stub.server.close();
  stub.server.closeAllConnections();
}

const first = summary(0, window);
const last = summary(calls - window, calls);
const growth = (a, b) => ((b - a) / a) * 100;
const rssGrowth = growth(first.rssMb, last.rssMb);
const heapGrowth = growth(heap[0], heap[1]);
const p99Growth = growth(first.p99, last.p99);
console.log(
  `soak: ${calls} calls after ${warmup} warm-up calls over stdio, stub upstream, node ${process.version}`,
);
console.log("window          RSS MB  heap MB   p50 ms   p99 ms");
for (const [label, w, h] of [
  [`first ${window}`, first, heap[0]],
  [`last ${window}`, last, heap[1]],
]) {
  console.log(
    `${label.padEnd(14)} ${w.rssMb.toFixed(1).padStart(7)} ${h.toFixed(1).padStart(8)} ${w.p50.toFixed(2).padStart(8)} ${w.p99.toFixed(2).padStart(8)}`,
  );
}
console.log(
  `growth         ${pct(rssGrowth).padStart(7)} ${pct(heapGrowth).padStart(8)} ${"".padStart(8)} ${pct(p99Growth).padStart(8)}   errors ${errors}`,
);

let failed = false;
if (errors > 0) {
  failed = true;
  console.error(`  ${errors} calls failed; first: ${firstError}`);
}
if (rssGrowth > maxGrowth) {
  failed = true;
  console.error(`  RSS grew ${rssGrowth.toFixed(1)}%, budget ${maxGrowth}%`);
}
if (heapGrowth > maxGrowth) {
  failed = true;
  console.error(`  live heap grew ${heapGrowth.toFixed(1)}%, budget ${maxGrowth}%`);
}
if (p99Growth > maxGrowth && last.p99 - first.p99 > p99Floor) {
  failed = true;
  console.error(
    `  p99 grew ${p99Growth.toFixed(1)}% (${(last.p99 - first.p99).toFixed(2)} ms), budget ${maxGrowth}% and ${p99Floor} ms`,
  );
}
process.exit(failed ? 1 : 0);

function summary(from, to) {
  const sorted = latencies.slice(from, to).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const samples = rss.filter((s) => s.at >= from && s.at < to).map((s) => s.kb);
  const rssMb = samples.reduce((a, b) => a + b, 0) / samples.length / 1024;
  return { p50: pct(0.5), p99: pct(0.99), rssMb };
}

function pct(value) {
  return `${value.toFixed(1)}%`;
}

/** The server's heap after a full GC, reported by the hook on SIGUSR2. */
async function liveHeapMb() {
  const seen = stderr.length;
  process.kill(pid, "SIGUSR2");
  for (;;) {
    const match = /\[soak\] heap (\d+)\n/.exec(stderr.slice(seen));
    if (match) return Number(match[1]) / 1048576;
    await sleep(10);
  }
}

function residentKb(processId) {
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(processId)], { encoding: "utf8" }));
}

/** Both StarUML ports: the bundled manifest, and fixed answers for the rotation's endpoints. */
async function startStub() {
  const manifest = JSON.parse(
    readFileSync(new URL("../src/extension-manifest.json", import.meta.url), "utf8"),
  );
  const project = { _id: "P1", _type: "Project", name: "Untitled" };
  const page = { count: 1, elements: [{ _id: "C1", _type: "UMLClass", name: "Order" }] };
  const ok = (data) => JSON.stringify({ success: true, data });
  const replies = {
    "GET /": JSON.stringify(manifest.extension),
    "POST /introspect": ok(manifest),
    "POST /find_elements": ok(page),
    "POST /quick_find": ok({
      matches: [
        { element: { _id: "C1", _type: "UMLClass", name: "Order" }, field: "name", text: "Order" },
      ],
      total: 1,
      truncated: false,
    }),
    "POST /get_preference": ok({
      key: "diagramEditor.showGrid",
      value: true,
      default: true,
      type: "check",
      settable: true,
    }),
    "POST /performance_stats": ok({
      listeners: { operationExecuted: 15, created: 2, updated: 4, deleted: 2 },
      undo: 3,
      redo: 0,
      elements: 12,
      workingDiagrams: 1,
      explorerAnimations: 0,
      heapUsedMiB: 70.6,
      quiet: false,
    }),
    "POST /batch": ok({
      atomic: true,
      succeeded: 2,
      failed: 0,
      results: [
        { path: "/get_project_info", as: "p", success: true, data: { project } },
        { path: "/get_element_by_id", success: true, data: project },
      ],
    }),
    "POST /build_diagram": ok({
      diagram: { _id: "D1", _type: "UMLClassDiagram", name: "soak" },
      kind: "class",
      upserted: true,
      created: 0,
      updated: 0,
      unchanged: 3,
    }),
    "POST /build_model": ok({
      model: { _id: "$m0", name: "Soak", path: "Soak" },
      upserted: false,
      counts: { created: { UMLModel: 1, UMLClass: 1 }, updated: {}, unchanged: 0 },
      changes: { created: [{ path: "Soak/Order", type: "UMLClass" }], updated: [] },
      dryRun: true,
      plan: { ops: [{ path: "/create_element", body: {} }], creates: [], updates: [], deletes: [] },
    }),
    "POST /apply_pattern": ok({
      pattern: "Strategy",
      roles: { Context: [{ _id: "C1", path: "Model/Order", created: false }] },
      created: 3,
      updated: 0,
      unchanged: 0,
      changes: { created: [{ path: "Model/Strategy", type: "UMLInterface" }], updated: [] },
      properties: [{ path: "Model/Strategy#execute()", field: "isAbstract", value: true }],
      dryRun: true,
      plan: { ops: [], creates: [], updates: [], deletes: [] },
    }),
    "POST /diagram_quality": ok({
      diagram: { _id: "D1", name: "soak", _type: "UMLClassDiagram" },
      kind: "class",
      score: 91,
      rating: 5,
      target: 80,
      passes: true,
      metrics: { nodes: 2, edges: 1, overlapArea: 0 },
      penalties: { overlap: 0, whitespace: 4.5, aspect: 4.5 },
      findings: [{ rule: "L005", name: "label-overflow", severity: "warning", count: 1 }],
    }),
    "POST /improve_diagram": ok({
      diagram: { _id: "D1", name: "soak", _type: "UMLClassDiagram" },
      kind: "class",
      quality: {
        score: 97,
        rating: 5,
        before: 91,
        target: 80,
        passes: true,
        iterations: 1,
        steps: ["snap", "trim"],
        findings: [],
      },
      dryRun: true,
    }),
    "POST /derive_diagrams": ok({
      model: "Soak",
      diagrams: [
        {
          kind: "class",
          name: "Soak",
          diagram: "$diagram",
          created: 1,
          updated: 0,
          unchanged: 0,
          deleted: 0,
          ops: 2,
        },
      ],
      counts: { diagrams: 1, created: 1, updated: 0, unchanged: 0, deleted: 0 },
      dryRun: true,
    }),
    "POST /request_diagram": ok({
      choice: {
        viewpoint: "lifecycle",
        kind: "statemachine",
        template: "lifecycle-states",
        rule: "D01",
        reason: "the intent asks for states",
        question: "Which states can this object be in, and what moves it between them?",
        matched: ["states"],
      },
      scope: "Soak",
      diagrams: [
        {
          kind: "statemachine",
          name: "Order lifecycle",
          diagram: "$diagram",
          created: 4,
          updated: 0,
          unchanged: 0,
          ops: 6,
          viewpoint: "lifecycle",
          conforms: true,
          template: "lifecycle-states",
          accepted: true,
        },
      ],
      counts: { diagrams: 1, created: 4, updated: 0, unchanged: 0, deleted: 0 },
      dryRun: true,
    }),
    "POST /list_templates": ok({
      templates: [{ name: "Default", source: "core", path: "/StarUML/templates/Default.mdj" }],
      diagramTemplates: [
        {
          name: "lifecycle-states",
          version: 1,
          title: "Lifecycle",
          viewpoint: "lifecycle",
          kind: "statemachine",
          default: true,
        },
      ],
    }),
    "POST /lint_diagram": ok({
      diagram: { _id: "D1", _type: "UMLClassDiagram", name: "soak", path: "soak" },
      count: 1,
      counts: { error: 0, warning: 1, info: 0 },
      truncated: false,
      findings: [
        {
          rule: "L005",
          name: "label-overflow",
          severity: "warning",
          message: 'The name of "Order" needs about 104px and its box is 95px wide',
          ids: ["V1"],
          paths: ["Model/Order@soak"],
          fix: "Widen it to 104.",
          autofix: { path: "/resize_node", body: { ref: "V1", width: 104, height: 45 } },
        },
      ],
    }),
  };
  const diagrams = ok([{ id: "D1", type: "UMLClassDiagram", name: "soak" }]);
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () =>
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(replies[`${req.method} ${req.url}`] ?? diagrams),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}
