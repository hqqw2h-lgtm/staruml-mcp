#!/usr/bin/env node
// Load test for the Streamable HTTP transport (stateless: one McpServer per request).
//
// Starts the built server (dist/index.js) as a child process and drives tools/call
// get_all_diagrams_info at each concurrency level, or with --call-endpoint call_endpoint
// find_elements, which adds the manifest schema check and the extension port, with --batch a
// batch of four read-only ops, one with a "$name" reference, which adds the per-op schema checks,
// or with --build a build_diagram of a three-class Mermaid diagram, which adds the check against
// the whole request schema. By default StarUML is replaced by an in-process stub so the numbers
// measure this server, not StarUML; --live targets the real StarUML on 58321 and the extension
// on 58322 instead. --build --live upserts one diagram named "load-test" into the open project:
// the first call builds it and every later one finds nothing to add.
//
// Usage: npm run build && node scripts/load-test.mjs
//          [--concurrency 50,200] [--requests 5000] [--warmup 500]
//          [--max-p99-ms N] [--min-rps N] [--live] [--call-endpoint | --batch | --build]
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
  },
});

const callEndpoint = args["call-endpoint"];
/** Read-only, so a --live run leaves the open project as it was. */
const BATCH_OPS = [
  { path: "/get_project_info", as: "p" },
  { path: "/get_element_by_id", body: { id: "$p.project" } },
  { path: "/find_elements", body: { type: "UMLClass", limit: 10 } },
  { path: "/is_modified" },
];
const BUILD = {
  mermaid: "classDiagram\n  Order --> Line\n  Order --> Customer",
  name: "load-test",
  upsert: true,
};
const params = args.build
  ? { name: "build_diagram", arguments: BUILD }
  : args.batch
    ? { name: "batch", arguments: { ops: BATCH_OPS } }
    : callEndpoint
      ? {
          name: "call_endpoint",
          arguments: { name: "find_elements", body: { type: "UMLClass", limit: 10 } },
        }
      : { name: "get_all_diagrams_info", arguments: {} };
const label = args.build
  ? "build_diagram (3 classes, upsert)"
  : args.batch
    ? `batch of ${BATCH_OPS.length} ops`
    : callEndpoint
      ? "call_endpoint find_elements"
      : params.name;

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

let failed = false;
try {
  await runLevel(Math.min(50, levels[0]), warmup);
  console.log(
    `target: ${args.live ? "live StarUML" : "stub upstream"}, tool: ${label}, node ${process.version}, ${requestsPerLevel} requests per level`,
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

async function callTool(id) {
  const res = await fetch(mcp.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
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
