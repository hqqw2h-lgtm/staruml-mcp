#!/usr/bin/env node
// The ThingsBoard acceptance of issues #17 and #19 as a client of this server sees it: the built
// server (dist/index.js) started with --tools oo over stdio, build_model with the object spec,
// derive_diagrams of the model, then per diagram diagram_quality (the score and the hard-limit
// `failures` of extension #38) and view_diagram with `path`, which writes the PNG to disk and
// answers a few tokens instead of an image. Every call's arguments and answer are counted in
// o200k_base tokens. The class diagrams are derived per class view (the spec's default) and then
// per package, the two sets the extension's reviewers rated.
//
// Usage: npm run build && node scripts/acceptance-oo.mjs [--spec <file>] [--out <dir>]
// (StarUML 7 with staruml-mcp-extension 0.3 on 58321/58322; STARUML_EXT_TOKEN reaches the
// server.) The model is deleted and the style profile reset at the end, straight through the
// extension: the oo tier reaches neither. Writes
// scripts/benchmark-data/oo-acceptance-7.1.1.json.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

const { values: args } = parseArgs({
  options: {
    spec: {
      type: "string",
      default: new URL("../tests/fixtures/thingsboard.oo.json", import.meta.url).pathname,
    },
    out: { type: "string" },
  },
});

const spec = JSON.parse(readFileSync(args.spec, "utf8"));
const out = args.out ?? mkdtempSync(join(tmpdir(), "staruml-mcp-acceptance-"));

async function ext(path, body = {}) {
  const res = await fetch(`http://localhost:58322${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.STARUML_EXT_TOKEN
        ? { Authorization: `Bearer ${process.env.STARUML_EXT_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

const client = new Client({ name: "acceptance-oo", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname, "--tools", "oo"],
    env: { ...process.env },
  }),
);

const calls = [];
const text = (result) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

/** One tools/call, counted; a failure ends the run. */
async function call(name, toolArgs) {
  const started = performance.now();
  // build_model of 93 classes took 20 s on an idle StarUML; the SDK's default gives up at 60 s.
  const result = await client.callTool({ name, arguments: toolArgs }, undefined, {
    timeout: 600_000,
  });
  const answer = text(result);
  if (result.isError) throw new Error(`${name} failed: ${answer}`);
  const row = {
    tool: name,
    callTokens: countTokens(JSON.stringify(toolArgs)),
    resultTokens: countTokens(answer),
    ms: Math.round(performance.now() - started),
  };
  calls.push(row);
  return { row, data: answer.startsWith("{") ? JSON.parse(answer) : answer };
}

/** derive_diagrams with `policy`, then each diagram scored and written to disk. */
async function derive(label, policy) {
  const first = calls.length;
  const { data } = await call("derive_diagrams", {
    scope: spec.system,
    ...(policy && { policy }),
  });
  const diagrams = [];
  for (const [index, d] of data.diagrams.entries()) {
    const ref = d.diagram ?? d.name;
    const { data: q } = await call("diagram_quality", { ref });
    const file = join(out, `${label}-${String(index).padStart(2, "0")}.png`);
    const { row } = await call("view_diagram", { diagram: ref, path: file });
    diagrams.push({
      kind: d.kind,
      name: d.name,
      score: q.score,
      loop: d.score,
      failures: q.failures ?? [],
      penalties: q.penalties,
      png: { bytes: statSync(file).size, answerTokens: row.resultTokens },
    });
  }
  const own = calls.slice(first);
  return {
    label,
    policy: policy ?? null,
    quality: data.quality,
    counts: data.counts,
    calls: own.length,
    resultTokens: own.reduce((n, c) => n + c.resultTokens, 0),
    diagrams,
  };
}

let failed;
const sets = [];
let built;
try {
  const started = performance.now();
  built = await call("build_model", { spec });
  sets.push(await derive("views"));
  sets.push(await derive("perPackage", { classDiagrams: "perPackage" }));
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  const versions = (await ext("/introspect", { include: [] })).data;
  const twoCalls = calls.filter((c) => c.tool !== "diagram_quality" && c.tool !== "view_diagram");
  const record = {
    versions,
    seconds,
    build: built.row,
    model: { calls: 2, resultTokens: built.row.resultTokens + calls[1].resultTokens },
    sets,
    totals: {
      calls: calls.length,
      callTokens: calls.reduce((n, c) => n + c.callTokens, 0),
      resultTokens: calls.reduce((n, c) => n + c.resultTokens, 0),
      modelAndDerive: twoCalls.map(({ tool, resultTokens }) => ({ tool, resultTokens })),
    },
  };
  const file = new URL("benchmark-data/oo-acceptance-7.1.1.json", import.meta.url);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote ${file.pathname}; images in ${out}`);
  for (const set of sets) {
    const below = set.diagrams.filter((d) => d.score < 80).map((d) => `${d.name} ${d.score}`);
    const failing = set.diagrams.filter((d) => d.failures.length > 0).map((d) => d.name);
    console.log(
      `${set.label}: ${set.diagrams.length} diagrams, scores ${set.quality.min}-` +
        `${Math.max(...set.diagrams.map((d) => d.score))} (mean ${set.quality.mean}), below 80: ` +
        `${below.join(", ") || "none"}; failures: ${failing.join(", ") || "none"}; ` +
        `${set.calls} calls, ${set.resultTokens} result tokens`,
    );
  }
  console.log(
    `build_model + derive_diagrams: 2 calls, ${record.model.resultTokens} result tokens; ` +
      `all ${record.totals.calls} calls ${record.totals.resultTokens} result tokens, ${seconds} s`,
  );
} catch (error) {
  failed = error;
} finally {
  await client.close();
  // A failed clean-up must not hide the error that got here.
  if (built) await ext("/delete_element", { ref: spec.system }).catch(() => {});
  await ext("/set_style_profile", { reset: true }).catch(() => {});
}
if (failed) throw failed;
