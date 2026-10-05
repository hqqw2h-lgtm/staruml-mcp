#!/usr/bin/env node
// Refreshes src/extension-manifest.json, the manifest bundled as the offline fallback, from a
// running staruml-mcp-extension (POST /introspect) or from a recorded /introspect response such
// as the extension repository's tests/fixtures/introspect.7.1.1.json. Only the versions and the
// endpoint manifest are kept; the metamodel and toolbox sections are not used by this server.
//
// Usage: npm run sync:manifest [-- --url http://localhost:58322 | --from <introspect.json>]
// The extension's access token, when its mcp-ext.token preference is set, is read from
// STARUML_EXT_TOKEN, the variable the server reads.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:58322" },
    from: { type: "string" },
  },
});

async function fetchIntrospection(url) {
  const res = await fetch(`${url}/introspect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.STARUML_EXT_TOKEN
        ? { Authorization: `Bearer ${process.env.STARUML_EXT_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({ include: ["endpoints"] }),
  });
  const body = await res.json();
  if (!res.ok || body.success !== true) {
    throw new Error(`${url}/introspect answered HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body.data;
}

const source = args.from ?? args.url;
const data =
  args.from === undefined
    ? await fetchIntrospection(args.url)
    : JSON.parse(readFileSync(args.from, "utf8"));
const { staruml, extension, endpoints } = data;
if (!staruml || !extension || !Array.isArray(endpoints)) {
  console.error(`${source} is not an /introspect response with an endpoint manifest.`);
  process.exit(1);
}
const target = new URL("../src/extension-manifest.json", import.meta.url);
writeFileSync(target, `${JSON.stringify({ staruml, extension, endpoints }, null, 2)}\n`);
console.log(
  `Wrote ${endpoints.length} endpoints of ${extension.name} ${extension.version} ` +
    `(StarUML ${staruml.version}) from ${source}.`,
);
