#!/usr/bin/env node
// Load test for the Streamable HTTP transport.
//
// By default every request carries no session id, so the server builds a McpServer for it alone
// (stateless fallback); with --session the script initializes once and sends every request in that
// session, so one McpServer serves them all, as for an MCP client.
//
// Starts the built server (dist/index.js) as a child process and drives tools/call
// get_all_diagrams_info at each concurrency level, or with --call-endpoint call_endpoint
// find_elements, which adds the manifest schema check and the extension port, with --batch a
// batch of four read-only ops, one with a "$name" reference, which adds the per-op schema checks,
// or with --build a build_diagram of a three-class Mermaid diagram, which adds the check against
// the whole request schema, or with --lint a lint_diagram of the current diagram, whose findings
// are reshaped (src/quality.ts), or with --model a build_model dry run of a three-class spec, or
// with --pattern an apply_pattern dry run of Strategy, whose answers are reshaped by path
// (src/model.ts, src/patterns.ts), or with --quality a diagram_quality of the current diagram, or
// with --improve an improve_diagram dry run of it (src/quality.ts), or with --derive a
// derive_diagrams dry run under --tools oo, whose answer is reshaped per diagram (src/model.ts),
// which also runs the tier's checks and, since 0.9.0, reads the style profile first. --lint lists
// lint_diagram
// with --tools core,lint_diagram, since it left the core tier in 0.7.0, and --pattern
// apply_pattern with --tools core,apply_pattern, since it left in 0.8.0. By default StarUML is replaced by an in-process stub so the numbers
// measure this server, not StarUML; --live targets the real StarUML on 58321 and the extension
// on 58322 instead. --build --live upserts one diagram named "load-test" into the open project:
// the first call builds it and every later one finds nothing to add. --model and --pattern are
// dry runs and change nothing, and so do --quality and --improve; --pattern --live needs a model in
// the open project, where Strategy's new elements would go, and --quality --live and --improve
// --live an open diagram, --derive --live a model named LoadTest. --request runs a
// request_diagram dry run under --tools oo (issue #20), shaped as derive_diagrams' answer; --live
// needs the LoadTest model too. --quick-find runs quick_find
// (core since 0.8.0) for "order", which reads the whole repository in StarUML.
//
// Usage: npm run build && node scripts/load-test.mjs
//          [--concurrency 50,200] [--requests 5000] [--warmup 500]
//          [--max-p99-ms N] [--min-rps N] [--live] [--session]
//          [--call-endpoint | --batch | --build | --lint | --model | --pattern | --quality
//           | --improve | --derive | --request]
// STARUML_EXT_TOKEN reaches the server, so --live works with an extension that requires a token.
// Exits non-zero on any failed request or a breached budget.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    concurrency: { type: "string", default: "50,200" },
    requests: { type: "string", default: "5000" },
    warmup: { type: "string", default: "500" },
    "max-p99-ms": { type: "string" },
    "min-rps": { type: "string" },
    live: { type: "boolean", default: false },
    "call-endpoint": { type: "boolean", default: false },
    batch: { type: "boolean", default: false },
    build: { type: "boolean", default: false },
    lint: { type: "boolean", default: false },
    model: { type: "boolean", default: false },
    pattern: { type: "boolean", default: false },
    "quick-find": { type: "boolean", default: false },
    quality: { type: "boolean", default: false },
    improve: { type: "boolean", default: false },
    derive: { type: "boolean", default: false },
    request: { type: "boolean", default: false },
    session: { type: "boolean", default: false },
  },
});

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/** Read-only, so a --live run leaves the open project as it was. */
const BATCH_OPS = [
  { path: "/get_project_info", as: "p" },
  { path: "/get_element_by_id", body: { ref: "$p.project" } },
  { path: "/find_elements", body: { type: "UMLClass", limit: 10 } },
  { path: "/is_modified" },
];
const BUILD = {
  mermaid: "classDiagram\n  Order --> Line\n  Order --> Customer",
  name: "load-test",
  upsert: true,
};
const MODEL = {
  spec: {
    system: "LoadTest",
    classes: [{ name: "Order" }, { name: "Line" }, { name: "Customer" }],
    relationships: [
      { from: "Order", to: "Line", type: "owns", toMult: "1..*" },
      { from: "Customer", to: "Order", type: "knows" },
    ],
  },
  dryRun: true,
};
const PATTERN = { pattern: "Strategy", dryRun: true };
/** The first mode given wins; each names the tool call, its label and the tier it needs. */
const MODES = [
  ["quick-find", { name: "quick_find", arguments: { text: "order" } }, 'quick_find ("order")'],
  [
    "pattern",
    { name: "apply_pattern", arguments: PATTERN },
    "apply_pattern (Strategy, dry run)",
    "core,apply_pattern",
  ],
  ["model", { name: "build_model", arguments: MODEL }, "build_model (3 classes, dry run)"],
  [
    "lint",
    { name: "lint_diagram", arguments: {} },
    "lint_diagram (current diagram)",
    "core,lint_diagram",
  ],
  ["quality", { name: "diagram_quality", arguments: {} }, "diagram_quality (current diagram)"],
  [
    "improve",
    { name: "improve_diagram", arguments: { dryRun: true } },
    "improve_diagram (current diagram, dry run)",
  ],
  [
    "derive",
    { name: "derive_diagrams", arguments: { scope: "LoadTest", dryRun: true } },
    "derive_diagrams (dry run, oo tier)",
    "oo",
  ],
  [
    "request",
    {
      name: "request_diagram",
      arguments: {
        intent: "what classes are there and how are they related",
        audience: "developer",
        scope: "LoadTest",
        dryRun: true,
      },
    },
    "request_diagram (dry run, oo tier)",
    "oo",
  ],
  ["build", { name: "build_diagram", arguments: BUILD }, "build_diagram (3 classes, upsert)"],
  ["batch", { name: "batch", arguments: { ops: BATCH_OPS } }, `batch of ${BATCH_OPS.length} ops`],
  [
    "call-endpoint",
    {
      name: "call_endpoint",
      arguments: { name: "find_elements", body: { type: "UMLClass", limit: 10 } },
    },
    "call_endpoint find_elements",
  ],
];
const [, params, label, tools] = MODES.find(([flag]) => args[flag]) ?? [
  undefined,
  { name: "get_all_diagrams_info", arguments: {} },
  "get_all_diagrams_info",
];

const levels = args.concurrency.split(",").map(Number);
const requestsPerLevel = Number(args.requests);
const warmup = Number(args.warmup);
const maxP99 = args["max-p99-ms"] === undefined ? undefined : Number(args["max-p99-ms"]);
const minRps = args["min-rps"] === undefined ? undefined : Number(args["min-rps"]);
const entry = new URL("../dist/index.js", import.meta.url);

if (!existsSync(entry)) {
  console.error("dist/index.js is missing; run `npm run build` first.");
  process.exit(2);
}

const stub = args.live ? undefined : await startStub();
const apiPort = stub?.port ?? 58321;
const mcp = await startMcp(apiPort);
const session = args.session ? await openSession() : undefined;

let failed = false;
try {
  await runLevel(Math.min(50, levels[0]), warmup);
  console.log(
    `target: ${args.live ? "live StarUML" : "stub upstream"}, tool: ${label}, ${session === undefined ? "stateless" : "one session"}, node ${process.version}, ${requestsPerLevel} requests per level`,
  );
  console.log("concurrency  requests   req/s    p50 ms   p90 ms   p99 ms   max ms  errors");
  for (const concurrency of levels) {
    const r = await runLevel(concurrency, requestsPerLevel);
    console.log(
      [
        String(concurrency).padStart(11),
        String(r.count).padStart(9),
        r.rps.toFixed(0).padStart(7),
        r.p50.toFixed(2).padStart(9),
        r.p90.toFixed(2).padStart(8),
        r.p99.toFixed(2).padStart(8),
        r.max.toFixed(2).padStart(8),
        String(r.errors).padStart(7),
      ].join(" "),
    );
    if (r.errors > 0) {
      failed = true;
      console.error(`  first error: ${r.firstError}`);
    }
    if (maxP99 !== undefined && r.p99 > maxP99) {
      failed = true;
      console.error(`  p99 ${r.p99.toFixed(2)} ms exceeds budget ${maxP99} ms`);
    }
    if (minRps !== undefined && r.rps < minRps) {
      failed = true;
      console.error(`  ${r.rps.toFixed(0)} req/s is below budget ${minRps} req/s`);
    }
  }
} finally {
  mcp.child.kill("SIGTERM");
  stub?.server.close();
  stub?.server.closeAllConnections();
}
process.exit(failed ? 1 : 0);

async function runLevel(concurrency, total) {
  const latencies = [];
  let next = 0;
  let errors = 0;
  let firstError;
  const started = performance.now();
  const worker = async () => {
    while (next < total) {
      const id = next++;
      const t0 = performance.now();
      try {
        await callTool(id);
        latencies.push(performance.now() - t0);
      } catch (error) {
        errors++;
        firstError ??= error instanceof Error ? error.message : String(error);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)];
  return {
    count: total,
    rps: total / elapsed,
    p50: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    max: latencies.at(-1),
    errors,
    firstError,
  };
}

/** `initialize` and `notifications/initialized`; the headers later requests carry. */
async function openSession() {
  const res = await fetch(mcp.url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "load-test", version: "0" },
      },
    }),
  });
  await res.text();
  const id = res.headers.get("mcp-session-id");
  if (id === null) throw new Error(`initialize answered HTTP ${res.status} without a session id`);
  const headers = { ...HEADERS, "Mcp-Session-Id": id, "MCP-Protocol-Version": "2025-06-18" };
  const ack = await fetch(mcp.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await ack.text();
  return headers;
}

async function callTool(id) {
  const res = await fetch(mcp.url, {
    method: "POST",
    headers: session ?? HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params,
    }),
  });
  const body = await res.text();
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${body}`);
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  if (!data) throw new Error(`no SSE data line: ${body}`);
  const message = JSON.parse(data.slice(6));
  if (message.id !== id) throw new Error(`response id ${message.id} for request ${id}`);
  if (message.error || message.result.isError) throw new Error(data);
}

/**
 * Answers both StarUML ports. For the extension it serves the bundled manifest, so the server
 * starts with the same catalog it would get from extension 0.3.0, and one page of find_elements.
 */
async function startStub() {
  const manifest = JSON.parse(
    readFileSync(new URL("../src/extension-manifest.json", import.meta.url), "utf8"),
  );
  const element = { _id: "AAAAAAFF+qBtyKM79qY=", _type: "UMLClass", name: "Order", _parent: "M" };
  const project = { _id: "AAAAAAFF+qBtyKM79qZ=", _type: "Project", name: "Untitled" };
  const page = { count: 1, elements: [element], nextCursor: null };
  const replies = {
    "GET /": JSON.stringify(manifest.extension),
    "POST /batch": JSON.stringify({
      success: true,
      data: {
        atomic: true,
        succeeded: 4,
        failed: 0,
        results: [
          { path: "/get_project_info", as: "p", success: true, data: { project } },
          { path: "/get_element_by_id", success: true, data: project },
          { path: "/find_elements", success: true, data: page },
          { path: "/is_modified", success: true, data: { modified: false } },
        ],
      },
    }),
    "POST /introspect": JSON.stringify({ success: true, data: manifest }),
    // An upsert that found every node and edge already there (src/handlers/build.ts).
    "POST /build_diagram": JSON.stringify({
      success: true,
      data: {
        diagram: { _id: "AAAAAAFF+qBtyKM79qD=", _type: "UMLClassDiagram", name: "load-test" },
        kind: "class",
        upserted: true,
        created: 0,
        updated: 0,
        unchanged: 5,
        layout: "placed",
        ids: Object.fromEntries(
          ["Order", "Line", "Customer"].map((n, i) => [
            n,
            { model: `AAAAAAFF+qBtyKM79q${i}=`, view: `AAAAAAFF+qBtyKM79v${i}=` },
          ]),
        ),
        edges: [],
      },
    }),
    "POST /find_elements": JSON.stringify({ success: true, data: page }),
    // Two matches in the shape src/handlers/workspace.ts answers.
    "POST /quick_find": JSON.stringify({
      success: true,
      data: {
        matches: [
          {
            element: {
              _id: "AAAAAAFF+qBtyKM79q0=",
              _type: "UMLClass",
              name: "Order",
              _parent: "M1",
            },
            field: "name",
            text: "Order",
          },
          {
            element: {
              _id: "AAAAAAFF+qBtyKM79q1=",
              _type: "UMLClass",
              name: "Line",
              _parent: "M1",
            },
            field: "documentation",
            text: "One line of an order.",
          },
        ],
        total: 2,
        truncated: false,
      },
    }),
    // Dry runs in the shapes src/handlers/model.ts and patterns.ts answer.
    "POST /build_model": JSON.stringify({
      success: true,
      data: {
        model: { _id: "$m0", name: "LoadTest", path: "LoadTest" },
        upserted: false,
        counts: { created: { UMLModel: 1, UMLClass: 3, UMLAssociation: 2 }, updated: {} },
        changes: {
          created: ["LoadTest", "LoadTest/Order", "LoadTest/Line", "LoadTest/Customer"].map(
            (path) => ({ path, type: path.includes("/") ? "UMLClass" : "UMLModel" }),
          ),
          updated: [],
        },
        dryRun: true,
        plan: {
          ops: Array.from({ length: 6 }, (_, i) => ({
            path: "/create_element",
            body: { parent: "$m0", type: "UMLClass", name: `C${i}` },
            as: `m${i + 1}`,
          })),
          creates: [],
          updates: [],
          deletes: [],
        },
      },
    }),
    "POST /apply_pattern": JSON.stringify({
      success: true,
      data: {
        pattern: "Strategy",
        roles: {
          Context: [{ _id: "$m0", path: "Model/Context", created: true }],
          Strategy: [{ _id: "$m1", path: "Model/Strategy", created: true }],
          ConcreteStrategy: [{ _id: "$m2", path: "Model/ConcreteStrategy", created: true }],
        },
        created: 8,
        updated: 0,
        unchanged: 0,
        changes: {
          created: [
            { path: "Model/Strategy", type: "UMLInterface" },
            { path: "Model/Context -> Model/Strategy", type: "UMLAssociation" },
          ],
          updated: [],
        },
        properties: [
          { path: "Model/Strategy#execute()", field: "isAbstract", value: true },
          { path: "Model/Context -> Model/Strategy.end1", field: "aggregation", value: "shared" },
          { path: "Model/Context -> Model/Strategy.end2", field: "name", value: "strategy" },
        ],
        dryRun: true,
        plan: { ops: [], creates: [], updates: [], deletes: [] },
      },
    }),
    // A messy diagram's score and the loop's dry run, in the shapes src/handlers/quality.ts
    // answers.
    "POST /diagram_quality": JSON.stringify({
      success: true,
      data: {
        diagram: { _id: "AAAAAAFF+qBtyKM79qY=", name: "Main", _type: "UMLClassDiagram" },
        kind: "class",
        score: 58,
        rating: 3,
        target: 80,
        passes: false,
        metrics: { nodes: 5, edges: 4, overlapArea: 15400, overlapPairs: 4 },
        penalties: { overlap: 30, nodeEdge: 8, edgeEdge: 0, whitespace: 4 },
        findings: [{ rule: "L001", name: "stacked", severity: "error", count: 3 }],
      },
    }),
    "POST /improve_diagram": JSON.stringify({
      success: true,
      data: {
        diagram: { _id: "AAAAAAFF+qBtyKM79qY=", name: "Main", _type: "UMLClassDiagram" },
        kind: "class",
        quality: {
          score: 98,
          rating: 5,
          before: 58,
          target: 80,
          passes: true,
          iterations: 1,
          steps: ["layout hierarchy-down", "snap", "trim"],
          findings: [],
        },
        dryRun: true,
      },
    }),
    // A strict profile: the oo tier reads it before every change (src/style.ts, #19), so
    // --derive measures that read too.
    "POST /get_style_profile": JSON.stringify({
      success: true,
      data: {
        profile: { name: "uml-standard", strict: true, blockSaveOnErrors: false },
        source: "project",
        builtIns: ["uml-standard", "minimal", "presentation", "print"],
      },
    }),
    // A dry run of two derived diagrams in the shape src/handlers/oo.ts answers.
    "POST /derive_diagrams": JSON.stringify({
      success: true,
      data: {
        model: "LoadTest",
        diagrams: [
          {
            kind: "package",
            name: "LoadTest packages",
            diagram: "$diagram",
            created: 2,
            updated: 0,
            unchanged: 0,
            deleted: 0,
            ops: 4,
          },
          {
            kind: "class",
            name: "LoadTest",
            diagram: "$diagram",
            created: 5,
            updated: 0,
            unchanged: 0,
            deleted: 0,
            ops: 9,
          },
        ],
        counts: { diagrams: 2, created: 7, updated: 0, unchanged: 0, deleted: 0 },
        dryRun: true,
      },
    }),
    // The choice and one derived diagram, as src/handlers/viewpoints.ts answers a dry run.
    "POST /request_diagram": JSON.stringify({
      success: true,
      data: {
        choice: {
          viewpoint: "code",
          kind: "class",
          template: "code-classes",
          rule: "D12",
          reason: "the intent asks which types there are",
          question: "Which types make up this part of the system, and how are they related?",
          matched: ["classes"],
        },
        scope: "LoadTest",
        diagrams: [
          {
            kind: "class",
            name: "LoadTest",
            diagram: "$diagram",
            created: 5,
            updated: 0,
            unchanged: 0,
            ops: 9,
            viewpoint: "code",
            conforms: true,
            template: "code-classes",
            accepted: true,
          },
        ],
        counts: { diagrams: 1, created: 5, updated: 0, unchanged: 0, deleted: 0 },
        dryRun: true,
      },
    }),
    // Two findings in the shape src/handlers/lint.ts answers, one with an autofix.
    "POST /lint_diagram": JSON.stringify({
      success: true,
      data: {
        diagram: { ...element, _type: "UMLClassDiagram", name: "Main", path: "Model/Main" },
        count: 2,
        counts: { error: 0, warning: 2, info: 0 },
        truncated: false,
        findings: [
          {
            rule: "L005",
            name: "label-overflow",
            severity: "warning",
            message: 'The name of "Order" needs about 104px and its box is 95px wide',
            ids: ["AAAAAAFF+qBtyKM79v0="],
            paths: ["Model/Order@Model/Main"],
            fix: "Widen it to 104.",
            autofix: {
              path: "/resize_node",
              body: { ref: "AAAAAAFF+qBtyKM79v0=", width: 104, height: 45 },
            },
          },
          {
            rule: "L006",
            name: "isolated",
            severity: "warning",
            message: '"Order" has no edge',
            ids: ["AAAAAAFF+qBtyKM79v0="],
            paths: ["Model/Order@Model/Main"],
            fix: "Connect it or move it to another diagram.",
            autofix: null,
          },
        ],
      },
    }),
  };
  const diagrams = JSON.stringify({
    success: true,
    data: [{ id: "AAAAAAFF+qBtyKM79qY=", type: "UMLClassDiagram", name: "Main" }],
  });
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

function startMcp(port) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(entry),
      "--transport",
      "http",
      "--port",
      "0",
      "--api-host",
      "http://127.0.0.1",
      "--api-port",
      String(port),
      // Stub runs point the extension port at the stub too, so a StarUML running on the same
      // machine does not change what is measured; --live reads the real extension.
      ...(args.live ? [] : ["--ext-port", String(port)]),
      ...(tools === undefined ? [] : ["--tools", tools]),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /ready on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(stderr);
      if (match) resolve({ child, url: match[1] });
    });
    child.once("exit", (code) => reject(new Error(`server exited with ${code}: ${stderr}`)));
  });
}
