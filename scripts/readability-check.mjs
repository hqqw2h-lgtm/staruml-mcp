#!/usr/bin/env node
// The readability check of issue #20 on a derived diagram set: the built server (dist/index.js)
// started with --tools oo over stdio builds the model from its object spec and derives its
// diagrams; each diagram's PNG goes to disk through view_diagram and, with the question its
// viewpoint answers (list_viewpoints), to a lower-tier model, which answers from the picture
// alone and rates its confidence (src/readability.ts). A diagram fails when the model cannot
// answer or is less sure than the threshold. Results, next to each diagram's quality score, go to
// scripts/benchmark-data/readability-7.1.1.json.
//
// Usage: npm run build && npm run readability [-- options]
//   --spec <file>        object spec; default tests/fixtures/thingsboard.oo.json (ThingsBoard)
//   --threshold <0-100>  confidence a diagram needs; default 70
//   --replay <file>      answer from recorded Messages API responses instead of the network;
//                        only the diagrams it has a recording for are judged
//   --record <file>      write the responses of this run there, for --replay
//   --out <dir>          where the PNGs go; default a temp directory
// The model is READABILITY_MODEL (default claude-haiku-4-5-20251001); the key comes from
// ANTHROPIC_API_KEY. Without a key and without --replay the check is skipped and exits 0.
// StarUML 7 with staruml-mcp-extension 0.3 must run on 58321/58322; the model is deleted and the
// style profile reset at the end, straight through the extension, which the oo tier cannot.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  checkReadability,
  DEFAULT_READABILITY_MODEL,
  DEFAULT_THRESHOLD,
  recordingClient,
  replayClient,
} from "../src/readability.ts";

const { values: args } = parseArgs({
  options: {
    spec: {
      type: "string",
      default: new URL("../tests/fixtures/thingsboard.oo.json", import.meta.url).pathname,
    },
    threshold: { type: "string", default: String(DEFAULT_THRESHOLD) },
    replay: { type: "string" },
    record: { type: "string" },
    out: { type: "string" },
  },
});

const model = process.env.READABILITY_MODEL ?? DEFAULT_READABILITY_MODEL;
const threshold = Number(args.threshold);
if (args.replay === undefined && !process.env.ANTHROPIC_API_KEY) {
  console.log(
    "Readability check skipped: ANTHROPIC_API_KEY is not set. Set it, or pass --replay <file> " +
      "to judge from recorded answers.",
  );
  process.exit(0);
}

const recordings =
  args.replay === undefined ? undefined : JSON.parse(readFileSync(args.replay, "utf8")).recordings;
const recorded = [];
async function messagesClient() {
  if (recordings !== undefined) return replayClient(recordings);
  // Loaded only for a live run, so a run without a key needs nothing from the network.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const live = new Anthropic();
  return args.record === undefined ? live : recordingClient(live, recorded);
}

const spec = JSON.parse(readFileSync(args.spec, "utf8"));
const out = args.out ?? mkdtempSync(join(tmpdir(), "staruml-mcp-readability-"));

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

const client = new Client({ name: "readability-check", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname, "--tools", "oo"],
    env: { ...process.env },
  }),
);

async function call(name, toolArgs) {
  // build_model of 93 classes took 20 s on an idle StarUML; the SDK's default gives up at 60 s.
  const result = await client.callTool({ name, arguments: toolArgs }, undefined, {
    timeout: 600_000,
  });
  const answer = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  if (result.isError) throw new Error(`${name} failed: ${answer}`);
  return JSON.parse(answer);
}

let failed;
let built = false;
try {
  await call("build_model", { spec });
  built = true;
  const derived = await call("derive_diagrams", { scope: spec.system });
  const { viewpoints } = await call("call_endpoint", { name: "list_viewpoints" });
  const questions = new Map(viewpoints.map((v) => [v.name, v.question]));
  const diagrams = [];
  for (const [index, d] of derived.diagrams.entries()) {
    const file = join(out, `${String(index).padStart(2, "0")}.png`);
    // The Messages API scales an image past 1,568 px on the long edge down anyway (Anthropic's
    // vision guide), so the PNG is written no wider: what the model sees, at a third the bytes.
    await call("view_diagram", { diagram: d.diagram, path: file, maxWidth: 1568 });
    diagrams.push({
      name: d.name,
      kind: d.kind,
      viewpoint: d.viewpoint,
      question: questions.get(d.viewpoint),
      png: readFileSync(file).toString("base64"),
      ...(d.score === undefined ? {} : { score: d.score }),
      ...(d.template === undefined ? {} : { template: d.template }),
    });
  }
  const recordedNames = new Set((recordings ?? []).map((r) => r.diagram));
  const judged =
    recordings === undefined ? diagrams : diagrams.filter((d) => recordedNames.has(d.name));
  const report = await checkReadability(await messagesClient(), judged, { model, threshold });
  const versions = (await ext("/introspect", { include: [] })).data;
  const record = {
    versions,
    mode:
      recordings === undefined
        ? "live"
        : `replay of ${args.replay}; not model output unless that file was written by --record`,
    spec: spec.system,
    ...report,
    ...(judged.length < diagrams.length
      ? { notJudged: diagrams.filter((d) => !judged.includes(d)).map((d) => d.name) }
      : {}),
  };
  const file = new URL("benchmark-data/readability-7.1.1.json", import.meta.url);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  if (args.record !== undefined) {
    writeFileSync(args.record, `${JSON.stringify({ recordings: recorded }, null, 2)}\n`);
  }
  for (const v of report.diagrams) {
    const j = v.judgement;
    console.log(
      `${v.passed ? "pass" : "FAIL"}  ${v.name} [${v.viewpoint}, score ${v.score ?? "-"}]: ` +
        (j === undefined
          ? v.error
          : `${j.answerable ? "answerable" : "not answerable"}, confidence ${j.confidence}`),
    );
  }
  console.log(
    `${report.passed} of ${report.diagrams.length} pass at ${threshold} with ${model}` +
      `${report.meanConfidence === undefined ? "" : `, mean confidence ${report.meanConfidence}`}; ` +
      `wrote ${file.pathname}; images in ${out}`,
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
