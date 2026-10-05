#!/usr/bin/env node
// Load test for the Streamable HTTP transport (stateless: one McpServer per request).
//
// Starts the built server (dist/index.js) as a child process and drives tools/call
// get_all_diagrams_info at each concurrency level. By default StarUML is replaced by an
// in-process stub so the numbers measure this server, not StarUML; --live targets the real
// StarUML on 58321 instead.
//
// Usage: npm run build && node scripts/load-test.mjs
//          [--concurrency 50,200] [--requests 5000] [--warmup 500]
//          [--max-p99-ms N] [--min-rps N] [--live]
// Exits non-zero on any failed request or a breached budget.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
  },
});

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
    `target: ${args.live ? "live StarUML :58321" : "stub upstream"}, node ${process.version}, ${requestsPerLevel} requests per level`,
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
      params: { name: "get_all_diagrams_info", arguments: {} },
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

async function startStub() {
  const diagrams = JSON.stringify({
    success: true,
    data: [{ id: "AAAAAAFF+qBtyKM79qY=", type: "UMLClassDiagram", name: "Main" }],
  });
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end(diagrams));
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
      // Stub runs take the bundled manifest (nothing listens on port 1), so a StarUML running on
      // the same machine does not change what is measured; --live reads the real one.
      ...(args.live ? [] : ["--ext-port", "1"]),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /ready on (http:\/\/localhost:\d+\/mcp)/.exec(stderr);
      if (match) resolve({ child, url: match[1].replace("localhost", "127.0.0.1") });
    });
    child.once("exit", (code) => reject(new Error(`server exited with ${code}: ${stderr}`)));
  });
}
