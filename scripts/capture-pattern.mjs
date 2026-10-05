#!/usr/bin/env node
// Records what a running StarUML answers while the Strategy pattern is applied to an existing
// three-class model both ways, for the "apply Strategy to an existing class model" part of
// scripts/token-benchmark.mjs:
//
// - apply_pattern (#13): /describe_pattern, then one /apply_pattern with the roles bound by path;
// - by hand: the same changes as one /batch, the ops /apply_pattern's dry run spells out, which
//   is the best a model writing the ops itself can do: every property the pattern prescribes.
//
// /detect_patterns runs after each, to record that both reach confidence 1. Snapshots put the
// project back: the model is gone afterwards.
//
// Usage: node scripts/capture-pattern.mjs [--url http://localhost] (needs StarUML 7 with
// staruml-mcp-extension 0.3 with /apply_pattern on 58322; STARUML_EXT_TOKEN is sent when set).

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { url: { type: "string", default: "http://localhost" } },
});

async function ext(path, body = {}) {
  const res = await fetch(`${args.url}:58322${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.STARUML_EXT_TOKEN
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

/** The existing model: an order and the two ways of pricing its shipping. */
const SPEC = {
  system: "Shipping",
  classes: [
    {
      name: "Order",
      responsibility: "Prices and ships one purchase",
      attributes: ["+weight: double"],
      operations: ["+shippingCost(): double"],
    },
    { name: "FlatRate", responsibility: "Charges one price per order" },
    { name: "ByWeight", responsibility: "Charges by the kilogram" },
  ],
};
const APPLY = {
  pattern: "Strategy",
  bindings: {
    Context: "Shipping/Order",
    Strategy: "ShippingPolicy",
    ConcreteStrategy: ["Shipping/FlatRate", "Shipping/ByWeight"],
  },
  parent: "Shipping",
};
const DETECT = { scope: "Shipping", patterns: ["Strategy"] };

const start = await ext("/snapshot", { label: "capture-pattern-start" });
try {
  await ext("/build_model", { spec: SPEC });
  await ext("/snapshot", { label: "capture-pattern-model" });

  const describe = await ext("/describe_pattern", { name: "Strategy" });
  const dryRun = await ext("/apply_pattern", { ...APPLY, dryRun: true });
  const applied = await ext("/apply_pattern", APPLY);
  const viaPattern = { describe, dryRun, applied, detect: await ext("/detect_patterns", DETECT) };

  await ext("/restore_snapshot", { snapshot: "capture-pattern-model" });
  const ops = dryRun.plan.ops;
  // The answer as the batch tool gets it: terse by default since the extension's phase 1g.
  const batch = await ext("/batch", { ops });
  const byHand = { ops, batch, detect: await ext("/detect_patterns", DETECT) };

  const versions = await ext("/introspect", { include: [] });
  const out = new URL("benchmark-data/pattern-7.1.1.json", import.meta.url);
  writeFileSync(
    out,
    `${JSON.stringify({ versions, spec: SPEC, apply: APPLY, detectBody: DETECT, viaPattern, byHand }, null, 2)}\n`,
  );
  const confidence = (d) => d.detections.find((x) => x.pattern === "Strategy")?.confidence;
  console.log(
    `Wrote ${out.pathname}: ${ops.length} ops; confidence ${confidence(viaPattern.detect)} ` +
      `with apply_pattern, ${confidence(byHand.detect)} by hand.`,
  );
} finally {
  await ext("/restore_snapshot", { snapshot: start.label });
}
