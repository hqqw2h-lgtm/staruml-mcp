/**
 * Fuzz tests: random JSON as call_endpoint and batch arguments, through the in-memory transport
 * as a client sends them. Whatever arrives, the call resolves to a result, never a thrown error or
 * a JSON-RPC failure, and a refusal carries a stable error code for the model to act on.
 */
import fc from "fast-check";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorCode } from "../src/errors.js";
import { CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST, toolName } from "../src/manifest.js";
import { parseToolSelection, reaches } from "../src/tiers.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, type ConnectedClient } from "./support/mcp.js";

const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

/** Codes this server or the fixture's 404 envelope produce; the SDK's own refusal has none. */
const CODES = new Set<string>([
  ErrorCode.NotInTier,
  ErrorCode.InvalidArgument,
  ErrorCode.UnknownEndpoint,
  ErrorCode.EndpointNotFound,
]);

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  // Every endpoint answers, so a body that passes the checks shows up as a success.
  for (const { path } of BUNDLED_MANIFEST.endpoints) {
    extension.reply(path, { body: { success: true, data: { path } } });
  }
  // apply_pattern and delete_element left the core tier in 0.8.0 and are listed by name.
  mcp = await connect({
    apiHost: "http://127.0.0.1",
    apiPort: builtin.port,
    extPort: extension.port,
    catalog: new CatalogState(undefined, parseToolSelection("core,apply_pattern,delete_element")),
  });
});

afterAll(async () => {
  await mcp.close();
  await Promise.all([builtin.stop(), extension.stop()]);
});

/** Outcomes seen, so a test can show the inputs reached past the first check. */
const seen = new Map<string, number>();
const saw = (outcome: string) => seen.set(outcome, (seen.get(outcome) ?? 0) + 1);

/** Resolves to a result; an error result names a known code, or is the SDK's argument check. */
function structured(result: CallToolResult): void {
  if (!result.isError) {
    saw("ok");
    return;
  }
  const error = (
    result.structuredContent as { error?: { code: string; message: string } } | undefined
  )?.error;
  if (error === undefined) {
    saw("sdk validation");
    // McpServer's own input validation (SDK 1.29) answers in text: "Input validation error".
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("validation"),
    });
    return;
  }
  saw(error.code);
  expect(CODES).toContain(error.code);
  expect(error.message.length).toBeGreaterThan(0);
}

const names = BUNDLED_MANIFEST.endpoints.map((e) => toolName(e.path));
const json = fc.jsonValue({ maxDepth: 3 });
/** Scalars an endpoint often accepts, so some random bodies get past the schema check. */
const plausible = fc.oneof(
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.nat(50),
  fc.boolean(),
  json,
);
/** The entry's parameter names, and one it does not have. */
const parameters = (entry: (typeof BUNDLED_MANIFEST.endpoints)[number]) => [
  ...Object.keys((entry.request.properties ?? {}) as object),
  "unknown",
];
/** An endpoint and a body over its own parameter names, or anything at all. */
const call = fc.oneof(
  fc
    .constantFrom(...BUNDLED_MANIFEST.endpoints)
    .chain((entry) =>
      fc.tuple(
        fc.constant(toolName(entry.path)),
        fc.dictionary(fc.constantFrom(...parameters(entry)), plausible),
      ),
    ),
  fc.tuple(fc.oneof(fc.constantFrom(...names), fc.string()), json),
  fc.tuple(fc.string(), fc.dictionary(fc.string(), json)),
);

describe("fuzz", () => {
  afterAll(() => {
    console.info(`[fuzz] outcomes: ${JSON.stringify(Object.fromEntries(seen))}`);
    // Inputs got past every check, and were refused at each of them.
    for (const outcome of [
      "ok",
      "sdk validation",
      ErrorCode.InvalidArgument,
      ErrorCode.UnknownEndpoint,
      ErrorCode.NotInTier,
    ]) {
      expect(seen.get(outcome), outcome).toBeGreaterThan(0);
    }
  });

  it("call_endpoint answers every name and body with a result", async () => {
    await fc.assert(
      fc.asyncProperty(call, async ([name, sent]) => {
        structured(await mcp.call("call_endpoint", { name, body: sent }));
      }),
      { numRuns: 300 },
    );
  }, 60_000);

  it("listed tools pass any path in a field that takes one to the extension as written", async () => {
    // Fields of listed tools that take an id or a path (extension src/refs.ts), as listed.
    const fields: [string, string, Record<string, unknown>][] = [
      ["get_element_by_id", "ref", {}],
      ["delete_element", "ref", {}],
      ["update_element", "ref", { field: "name", value: "x" }],
      ["update_element", "parent", { ref: "Model/A", op: "relocate" }],
      ["export_diagram", "diagram", { format: "svg" }],
      ["build_diagram", "parent", { kind: "mindmap", spec: { root: { name: "r" } } }],
      ["build_model", "parent", { spec: { classes: [] } }],
      ["apply_pattern", "diagram", { pattern: "Strategy" }],
      ["apply_pattern", "parent", { pattern: "Strategy" }],
      ["diagram_quality", "ref", {}],
      ["improve_diagram", "ref", { dryRun: true }],
    ];
    const segment = fc.oneof(
      fc.string({ minLength: 1, maxLength: 6 }),
      fc.constantFrom("/", ".", "#", "@", "(", ")", ",", "\\", "@current", "@project"),
    );
    const path = fc.array(segment, { minLength: 1, maxLength: 6 }).map((p) => p.join(""));
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...fields), path, async ([tool, field, rest], ref) => {
        const sentBefore = extension.requests.length;
        const result = await mcp.call(tool, { ...rest, [field]: ref });
        structured(result);
        expect(result.isError, `${tool} ${field}=${JSON.stringify(ref)}`).toBeFalsy();
        const sent = extension.requests.slice(sentBefore).at(-1)!.body as Record<string, unknown>;
        expect(sent[field]).toBe(ref);
      }),
      { numRuns: 200 },
    );
  }, 60_000);

  it("apply_pattern answers any bindings with a result, refusing bad ones before sending", async () => {
    await fc.assert(
      fc.asyncProperty(json, async (bindings) => {
        const sentBefore = extension.requests.length;
        const result = await mcp.call("apply_pattern", { pattern: "Strategy", bindings });
        structured(result);
        // A refusal is local: the whole request schema checks bindings before anything is sent.
        if (result.isError) expect(extension.requests.length).toBe(sentBefore);
      }),
      { numRuns: 200 },
    );
  }, 60_000);

  it("build_model answers any spec with a result, refusing a non-object before sending", async () => {
    await fc.assert(
      fc.asyncProperty(json, fc.option(json), async (spec, upsert) => {
        const sentBefore = extension.requests.length;
        const args = { spec, ...(upsert === null ? {} : { upsert }) };
        const result = await mcp.call("build_model", args);
        structured(result);
        const object = typeof spec === "object" && spec !== null && !Array.isArray(spec);
        if (!object) expect(result.isError).toBe(true);
        if (result.isError) expect(extension.requests.length).toBe(sentBefore);
      }),
      { numRuns: 200 },
    );
  }, 60_000);

  it("improve_diagram answers any arguments with a result, refusing bad ones before sending", async () => {
    const argument = fc.oneof(
      fc.integer({ min: -20, max: 120 }),
      fc.constantFrom("flow-down", "hierarchy-right", "spiral"),
      json,
    );
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.constantFrom("ref", "target", "maxIterations", "relayout", "preset", "dryRun", "x"),
          argument,
        ),
        async (args) => {
          const sentBefore = extension.requests.length;
          const result = await mcp.call("improve_diagram", args);
          structured(result);
          if (result.isError) expect(extension.requests.length).toBe(sentBefore);
          // What reached the extension is what its whole request schema takes.
          else {
            const sent = extension.requests.at(-1)!.body as Record<string, unknown>;
            if ("target" in sent) expect(sent.target).toEqual(expect.any(Number));
            expect(sent).not.toHaveProperty("x");
          }
        },
      ),
      { numRuns: 200 },
    );
  }, 60_000);

  it("call_endpoint under the oo tier never sends what the tier leaves out", async () => {
    const oo = await connect({
      apiHost: "http://127.0.0.1",
      apiPort: builtin.port,
      extPort: extension.port,
      catalog: new CatalogState(undefined, parseToolSelection("oo")),
    });
    const selection = parseToolSelection("oo");
    try {
      await fc.assert(
        fc.asyncProperty(call, async ([name, sent]) => {
          const sentBefore = extension.requests.length;
          const result = await oo.call("call_endpoint", { name, body: sent });
          structured(result);
          const code = (result.structuredContent as { error?: { code: string } } | undefined)?.error
            ?.code;
          // The SDK refuses a body that is not an object before the tier is consulted.
          const sdkRefused = result.isError === true && code === undefined;
          if (names.includes(name) && !reaches(selection, name) && !sdkRefused) {
            expect(code, name).toBe(ErrorCode.NotInTier);
          }
          // Whatever reached the extension is an endpoint the tier reaches.
          for (const request of extension.requests.slice(sentBefore)) {
            expect(reaches(selection, request.path.slice(1)), request.path).toBe(true);
          }
        }),
        { numRuns: 300 },
      );
    } finally {
      await oo.close();
    }
  }, 60_000);

  it("batch answers every ops list with a result", async () => {
    const op = fc
      .tuple(call, fc.option(fc.oneof(fc.stringMatching(/^[a-z]{1,2}$/), fc.string())))
      .map(([[name, body], as]) => ({ path: `/${name}`, body, ...(as === null ? {} : { as }) }));
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          { weight: 4, arbitrary: fc.array(op, { minLength: 1, maxLength: 4 }) },
          { weight: 1, arbitrary: json },
        ),
        fc.option(json),
        async (ops, atomic) => {
          structured(await mcp.call("batch", { ops, ...(atomic === null ? {} : { atomic }) }));
        },
      ),
      { numRuns: 300 },
    );
  }, 60_000);
});
