#!/usr/bin/env node
// Records what a running StarUML answers when a model reads one class diagram back, for the
// "read and explain a diagram" part of scripts/token-benchmark.mjs: the PNG of the built-in API
// (size only), an element dump, /describe_diagram and /export_text in both formats. The diagram is
// built in the open project with one /build_diagram call and removed again with one /undo.
//
// Usage: node scripts/capture-read-diagram.mjs [--url http://localhost] (needs StarUML 7 with its
// API server on 58321 and staruml-mcp-extension 0.3 on 58322; STARUML_EXT_TOKEN is sent when set).

import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { url: { type: "string", default: "http://localhost" } },
});

const SPEC = {
  classes: [
    {
      name: "Shopper",
      attributes: ["+id: UUID", "+name: String", "+email: String"],
      operations: ["+placeOrder(cart: Cart): PurchaseOrder"],
    },
    {
      name: "PurchaseOrder",
      attributes: ["+id: UUID", "+status: PurchaseStatus", "+createdAt: Instant"],
      operations: ["+total(): Money", "+cancel(): void"],
    },
    {
      name: "PurchaseLine",
      attributes: ["+quantity: int", "+unitPrice: Money"],
      operations: ["+subtotal(): Money"],
    },
    { name: "CatalogItem", attributes: ["+sku: String", "+name: String", "+price: Money"] },
    {
      name: "Settlement",
      attributes: ["+amount: Money", "+method: String"],
      operations: ["+authorize(): boolean"],
    },
    { name: "PurchaseStatus", kind: "enum", literals: ["NEW", "PAID", "SHIPPED", "CANCELLED"] },
  ],
  relations: [
    {
      from: "Shopper",
      to: "PurchaseOrder",
      type: "association",
      name: "places",
      toMultiplicity: "0..*",
    },
    { from: "PurchaseOrder", to: "PurchaseLine", type: "composition", toMultiplicity: "1..*" },
    { from: "PurchaseLine", to: "CatalogItem", type: "directed" },
    { from: "PurchaseOrder", to: "Settlement", type: "association", toMultiplicity: "0..1" },
    { from: "PurchaseOrder", to: "PurchaseStatus", type: "dependency" },
  ],
};

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

const built = await ext("/build_diagram", { kind: "class", name: "Ordering", spec: SPEC });
const diagramId = built.diagram._id;
try {
  const png = pngSize(await post(58321, "/get_diagram_image_by_id", { diagramId }));
  // Every classifier with its saved attributes, expanded down to the association ends and their
  // aggregation and multiplicity (depth 2): what a model without the text reads asks for to see
  // members and relationships. Classifiers of other diagrams in the open project are dropped, as
  // if the project held only this one; the class names are uncommon so that build_diagram, which
  // reuses an element of the same name elsewhere in the project, creates them all.
  const ours = new Set(Object.values(built.ids).map((ids) => ids.model));
  const dumpArgs = { type: "UMLClassifier", summary: false, depth: 2, limit: 1000 };
  const found = await ext("/find_elements", dumpArgs);
  const elements = found.elements.filter((e) => ours.has(e._id));
  if (elements.length !== SPEC.classes.length || built.created < ours.size) {
    throw new Error(`build_diagram reused elements of the open project; use a fresh project`);
  }
  const dump = { ...found, count: elements.length, elements };
  const describe = await ext("/describe_diagram", { diagramId });
  const mermaid = await ext("/export_text", { diagramId, format: "mermaid" });
  const plantuml = await ext("/export_text", { diagramId, format: "plantuml" });
  const versions = await ext("/introspect", { include: [] });
  const out = new URL("benchmark-data/read-diagram-7.1.1.json", import.meta.url);
  writeFileSync(
    out,
    `${JSON.stringify({ versions, spec: SPEC, diagramId, png, dumpArgs, dump, describe, mermaid, plantuml }, null, 2)}\n`,
  );
  console.log(`Wrote ${out.pathname}: ${dump.count} classifiers, PNG ${png.width}x${png.height}.`);
} finally {
  await ext("/undo");
}
