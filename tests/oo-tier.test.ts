/**
 * Contract tests for the `oo` tier (issue #17 and the enforcement layers its comment lists): the
 * listing has nothing that draws, call_endpoint and describe_endpoints refuse what the tier
 * leaves out, a view's geometry cannot be set through update_element, the OO spec is strict, and
 * the model-first answers are shaped for the model. Nothing here relies on the skill or a prompt.
 */
import fc from "fast-check";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CatalogState,
  describe as describeEndpoints,
  HAND_WRITTEN_TOOLS,
} from "../src/extension-tools.js";
import { parseArgs } from "../src/index.js";
import { BUNDLED_MANIFEST, compileManifest } from "../src/manifest.js";
import {
  DERIVE_DIAGRAMS_DESCRIPTION,
  deriveResult,
  EXPLAIN_MODEL_DESCRIPTION,
  explainResult,
} from "../src/model.js";
import { DETECT_PATTERNS_DESCRIPTION } from "../src/patterns.js";
import { MODEL_LINT_DESCRIPTION } from "../src/quality.js";
import { OO_REACHABLE, OO_TOOLS, parseToolSelection, reaches } from "../src/tiers.js";
import { styleProfile, UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;
let catalog: CatalogState;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
});

afterEach(async () => {
  await mcp?.close();
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await Promise.all([builtin.stop(), extension.stop()]);
});

async function connectOo(tools = "oo", allowTierSwitch = false): Promise<ConnectedClient> {
  catalog = new CatalogState(undefined, parseToolSelection(tools), { allowTierSwitch });
  mcp = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port, catalog });
  return mcp;
}

const names = async () => (await mcp.client.listTools()).tools.map((t) => t.name);

/**
 * What a refusal of the tier must not say (issue #19): the re-validation's agent followed the
 * hint's `doctor({tools: "core"})` and left the tier in one call.
 */
const WAY_OUT = /doctor|tools:|\bcore\b|switch|--tools|allow-tier/i;

/**
 * Endpoints that place, size, colour or draw views (`DRAWING_ENDPOINTS` and `STYLE_ENDPOINTS` in
 * the extension's src/style/guard.ts), and those that run any endpoint or change the profile.
 */
const DRAWING = [
  "build_diagram",
  "create_element_with_view",
  "create_edge_with_view",
  "create_view_of",
  "layout_diagram",
  "route_edges",
  "move_views",
  "resize_node",
  "set_view_style",
  "set_z_order",
  "divide_fragment",
  "apply_theme",
  "set_style_profile",
  "batch",
  "execute_command",
];

describe("oo tier listing", () => {
  it("lists exactly the model-first tools, nothing that draws", async () => {
    await connectOo();

    expect(await names()).toEqual([
      "view_diagram",
      "diagram_as_text",
      "doctor",
      "validate_model",
      "build_model",
      "derive_diagrams",
      "explain_model",
      "model_lint",
      "apply_pattern",
      "detect_patterns",
      "diagram_quality",
      "describe_endpoints",
      "call_endpoint",
    ]);
    for (const name of [...DRAWING, "generate_diagram", "get_diagram_image_by_id"]) {
      expect(await names()).not.toContain(name);
    }
  });

  it("costs at most 1,500 definition tokens with the instructions", async () => {
    await connectOo();
    const { tools } = await mcp.client.listTools();
    const forwarded = tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));

    const tokens =
      countTokens(JSON.stringify(forwarded)) + countTokens(mcp.client.getInstructions()!);

    expect(tokens).toBeLessThanOrEqual(1500);
  });

  it("lists the model-first tools with one-line descriptions and short schemas", async () => {
    await connectOo();
    const { tools } = await mcp.client.listTools();
    const tool = (name: string) => tools.find((t) => t.name === name)!;

    expect(tool("derive_diagrams")).toMatchObject({
      description: DERIVE_DIAGRAMS_DESCRIPTION,
      inputSchema: {
        properties: {
          scope: { type: "string", description: "The model, or a package of it." },
          kinds: {
            description:
              "Only these: package|class|sequence|usecase|statemachine|activity|erd|c4|deployment|mindmap.",
          },
          dryRun: { description: "Change nothing; answer what each diagram would change." },
        },
        required: ["scope"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    });
    expect(tool("explain_model").description).toBe(EXPLAIN_MODEL_DESCRIPTION);
    expect(Object.keys(tool("explain_model").inputSchema.properties!)).toEqual([
      "scope",
      "maxChars",
    ]);
    expect(tool("model_lint").description).toBe(MODEL_LINT_DESCRIPTION);
    expect(Object.keys(tool("model_lint").inputSchema.properties!)).toEqual(["scope", "rules"]);
    expect(tool("detect_patterns").description).toBe(DETECT_PATTERNS_DESCRIPTION);
    expect(Object.keys(tool("detect_patterns").inputSchema.properties!)).toEqual([
      "scope",
      "patterns",
    ]);
  });

  it("parses --tools oo and STARUML_MCP_TOOLS=oo as a closed selection", () => {
    const flag = parseArgs(["node", "staruml-mcp", "--tools", "oo"]).tools;
    const env = parseArgs(["node", "staruml-mcp"], { STARUML_MCP_TOOLS: "oo" }).tools;

    expect(flag).toEqual(env);
    expect(flag.closed).toBe(true);
    expect([...flag.names]).toEqual(OO_TOOLS);
    expect(flag.reachable).toEqual(new Set([...OO_TOOLS, ...OO_REACHABLE]));
  });
});

describe("oo tier refusals", () => {
  it.each(DRAWING)("call_endpoint refuses %s before anything is sent", async (name) => {
    await connectOo();

    const result = await mcp.call("call_endpoint", { name, body: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "NOT_IN_TIER",
        message: `${name} is outside the oo tier`,
        endpoint: `/${name}`,
        hint: expect.stringContaining("derive_diagrams"),
      },
    });
    const { hint } = (result.structuredContent as { error: { hint: string } }).error;
    expect(hint).toMatch(/build_model.*derive_diagrams.*improve_diagram/);
    expect(hint).not.toMatch(WAY_OUT);
    expect(extension.requests).toEqual([]);
  });

  it("describe_endpoints indexes only what the tier reaches and refuses the rest by name", async () => {
    await connectOo();

    const index = JSON.parse(text(await mcp.call("describe_endpoints"))) as Record<
      string,
      Record<string, string>
    >;
    const indexed = Object.values(index).flatMap((group) => Object.keys(group));
    expect(indexed.sort()).toEqual(
      OO_REACHABLE.filter((n) => !OO_TOOLS.includes(n)).sort((a, b) => a.localeCompare(b)),
    );
    for (const name of DRAWING) expect(indexed).not.toContain(name);

    const refused = await mcp.call("describe_endpoints", { names: ["move_views"] });
    expect(refused.structuredContent).toMatchObject({ error: { code: "NOT_IN_TIER" } });
    expect(text(refused)).not.toMatch(WAY_OUT);
    const group = JSON.parse(text(await mcp.call("describe_endpoints", { group: "style" })));
    expect(Object.keys(group)).toEqual([
      "get_style_profile",
      "apply_style_profile",
      "explain_style_violation",
    ]);
  });

  it("does not list or run the hand-written drawing and image tools", async () => {
    await connectOo();

    const result = await mcp.call("generate_diagram", { code: "classDiagram\n  class A" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Tool generate_diagram disabled/);
    expect(builtin.requests).toEqual([]);
  });

  it("refuses a view's geometry or style through update_element, and passes a model field", async () => {
    await connectOo();
    extension.reply("/update_element", {
      body: { success: true, data: { _id: "C1", _type: "UMLClass", name: "Order" } },
    });

    for (const field of ["left", "top", "width", "height", "fillColor", "suppressAttributes"]) {
      const refused = await mcp.call("call_endpoint", {
        name: "update_element",
        body: { ref: "Order@Main", field, value: 10 },
      });
      expect(refused.structuredContent, field).toMatchObject({
        error: { code: "NOT_IN_TIER", endpoint: "/update_element" },
      });
      expect(text(refused)).toMatch(/Hint: Change the model and let derive_diagrams/);
      expect(text(refused)).not.toMatch(WAY_OUT);
    }
    expect(extension.requests).toEqual([]);

    extension.reply("/get_style_profile", styleProfile(true));
    const renamed = await mcp.call("call_endpoint", {
      name: "update_element",
      body: { ref: "Shop/Order", field: "name", value: "Purchase" },
    });
    expect(renamed.isError).toBeFalsy();
    expect(extension.requests.map((r) => [r.path, r.body])).toEqual([
      ["/get_style_profile", {}],
      ["/update_element", { ref: "Shop/Order", field: "name", value: "Purchase" }],
    ]);
  });

  it("lets the core tier set a view's geometry, which the extension may still lock", async () => {
    await connectOo("core");
    extension.reply("/update_element", {
      body: { success: true, data: { _id: "V1", _type: "UMLClassView" } },
    });

    const moved = await mcp.call("update_element", { ref: "Order@Main", field: "left", value: 40 });

    expect(moved.isError).toBeFalsy();
  });

  it("reaches a name added to the tier, drawing or not, since the user asked for it", async () => {
    await connectOo("oo,move_views");
    extension.reply("/get_style_profile", styleProfile(true));
    extension.reply("/move_views", { body: { success: true, data: { moved: 1 } } });

    expect(await names()).toContain("move_views");
    expect((await mcp.call("move_views", { refs: ["V1"], dx: 1, dy: 0 })).isError).toBeFalsy();
    // The user named it, so its override is theirs to pass; the profile is strict all the same.
    const moved = await mcp.call("call_endpoint", {
      name: "move_views",
      body: { refs: ["V1"], dx: 1, dy: 0, override: true },
    });
    expect(moved.isError).toBeFalsy();
    expect(extension.requests.at(-1)!.body).toMatchObject({ override: true });
  });

  it("refuses a spec that tries to draw: the OO spec is strict", async () => {
    await connectOo();

    const result = await mcp.call("build_model", {
      spec: { system: "Shop", classes: [{ name: "Order", x: 40, fillColor: "#fff" }] },
    });

    expect(result.structuredContent).toMatchObject({
      error: { code: "INVALID_ARGUMENT", endpoint: "/build_model" },
    });
    expect(text(result)).toMatch(/spec\.classes\.0: Unrecognized keys: "x", "fillColor"/);
    expect(extension.requests).toEqual([]);
  });
});

describe("oo tier: the style profile is strict before anything changes", () => {
  const SPEC = { spec: { system: "Shop", classes: [{ name: "Order" }] } };
  const built = { body: { success: true, data: { model: { _id: "M1", path: "Shop" } } } };
  const sent = () => extension.requests.map((r) => [r.path, r.body]);

  it("makes the profile strict, reads it back, then sends the change", async () => {
    await connectOo();
    extension.reply("/get_style_profile", styleProfile(false), styleProfile(true));
    extension.reply("/set_style_profile", {
      body: { success: true, data: { profile: { name: "uml-standard" }, source: "project" } },
    });
    extension.reply("/build_model", built);

    const result = await mcp.call("build_model", SPEC);

    expect(result.isError, text(result)).toBeFalsy();
    expect(sent()).toEqual([
      ["/get_style_profile", {}],
      ["/set_style_profile", { patch: { strict: true } }],
      ["/get_style_profile", {}],
      ["/build_model", SPEC],
    ]);
  });

  it("only reads a profile that is strict already, before every change", async () => {
    await connectOo();
    extension.reply("/get_style_profile", styleProfile(true));
    extension.reply("/build_model", built);

    await mcp.call("build_model", SPEC);
    await mcp.call("build_model", SPEC);

    expect(sent().map(([path]) => path)).toEqual([
      "/get_style_profile",
      "/build_model",
      "/get_style_profile",
      "/build_model",
    ]);
  });

  it("refuses the change when the profile is still not strict after setting it", async () => {
    await connectOo();
    extension.reply("/get_style_profile", styleProfile(false));
    extension.reply("/set_style_profile", { body: { success: true, data: { changed: false } } });

    const result = await mcp.call("build_model", SPEC);

    expect(result.structuredContent).toEqual({
      error: {
        code: "PROFILE_NOT_STRICT",
        message:
          "The oo tier makes the project's style profile strict before it changes anything, and could not: the extension still reports strict: false after setting it",
        endpoint: "/build_model",
        hint: expect.stringMatching(/^Nothing was changed\./),
      },
    });
    expect(sent().map(([path]) => path)).not.toContain("/build_model");
  });

  it.each([
    ["reading", "/get_style_profile"],
    ["setting", "/set_style_profile"],
  ])("refuses the change when %s the profile fails", async (_, failing) => {
    await connectOo();
    extension.reply("/get_style_profile", styleProfile(false));
    extension.reply(failing, {
      status: 500,
      body: { success: false, code: "INTERNAL", error: "profile store broke" },
    });

    const result = await mcp.call("call_endpoint", { name: "undo", body: {} });

    expect(result.structuredContent).toMatchObject({
      error: { code: "PROFILE_NOT_STRICT", endpoint: "/undo" },
    });
    expect(text(result)).toContain(`profile store broke [INTERNAL, ${failing}]`);
    expect(sent().map(([path]) => path)).not.toContain("/undo");
  });

  it("reads a profile answer without a profile as not strict", async () => {
    await connectOo();
    extension.reply("/get_style_profile", { body: { success: true, data: null } });
    extension.reply("/set_style_profile", { body: { success: true, data: {} } });

    const result = await mcp.call("call_endpoint", { name: "undo", body: {} });

    expect(result.structuredContent).toMatchObject({ error: { code: "PROFILE_NOT_STRICT" } });
  });

  it("leaves reads, and replacing the project, alone", async () => {
    await connectOo();
    extension.reply("/explain_model", { body: { success: true, data: { text: "Shop" } } });
    extension.reply("/new_project", { body: { success: true, data: {} } });
    extension.reply("/get_element_by_id", { body: { success: true, data: { _id: "C1" } } });

    await mcp.call("explain_model", { scope: "Shop" });
    await mcp.call("call_endpoint", { name: "get_element_by_id", body: { ref: "Shop" } });
    await mcp.call("call_endpoint", { name: "new_project", body: {} });

    expect(sent().map(([path]) => path)).toEqual([
      "/explain_model",
      "/get_element_by_id",
      "/new_project",
    ]);
  });

  it("leaves the core tier's profile as the project has it", async () => {
    await connectOo("core");
    extension.reply("/build_model", built);

    await mcp.call("build_model", SPEC);

    expect(sent().map(([path]) => path)).toEqual(["/build_model"]);
  });
});

/**
 * Endpoints whose `override` passes a strict profile (STYLE_LOCKED) rather than
 * blockSaveOnErrors, read from the manifest's own description of the field.
 */
const STRICT_GUARDED = BUNDLED_MANIFEST.endpoints
  .filter((e) =>
    /style profile is strict/.test(
      String(
        (e.request.properties as Record<string, { description?: string }> | undefined)?.override
          ?.description,
      ),
    ),
  )
  .map((e) => e.path.slice(1));
const OVERRIDABLE = BUNDLED_MANIFEST.endpoints
  .filter((e) => Object.hasOwn((e.request.properties ?? {}) as object, "override"))
  .map((e) => e.path.slice(1));

describe("oo tier: STYLE_LOCKED is reachable only through override, which it does not expose", () => {
  it("reaches one strict-guarded endpoint, update_element, whose view fields it refuses itself", () => {
    const oo = parseToolSelection("oo");
    expect(STRICT_GUARDED.length).toBeGreaterThan(5);
    expect(STRICT_GUARDED.filter((name) => reaches(oo, name))).toEqual(["update_element"]);
  });

  it.each(OVERRIDABLE.filter((name) => reaches(parseToolSelection("oo"), name)))(
    "call_endpoint refuses %s with override before anything is sent",
    async (name) => {
      await connectOo();

      for (const override of [true, false]) {
        const result = await mcp.call("call_endpoint", { name, body: { override } });
        expect(result.structuredContent).toEqual({
          error: {
            code: "NOT_IN_TIER",
            message: "override is not part of the oo tier: the style profile decides",
            endpoint: `/${name}`,
            hint: expect.stringMatching(/^The oo tier states the model/),
          },
        });
        expect(text(result)).not.toMatch(WAY_OUT);
      }
      expect(extension.requests).toEqual([]);
    },
  );

  it("shows override in no schema the tier lists or describes", async () => {
    await connectOo();
    const { tools } = await mcp.client.listTools();
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).not.toContain("override");
    }
    const described = JSON.parse(
      text(
        await mcp.call("describe_endpoints", {
          names: [...OO_REACHABLE.filter((n) => !OO_TOOLS.includes(n))],
        }),
      ),
    ) as Record<string, { request: { properties?: Record<string, unknown> } }>;
    const overridable = Object.keys(described).filter((n) => OVERRIDABLE.includes(n));
    expect(overridable.length).toBeGreaterThan(5);
    for (const [name, { request }] of Object.entries(described)) {
      expect(Object.keys(request.properties ?? {}), name).not.toContain("override");
    }
  });

  it("describes override where the user named the endpoint, and everywhere under core", async () => {
    await connectOo("oo,move_views");
    const named = JSON.parse(
      text(await mcp.call("describe_endpoints", { names: ["move_views", "save_project"] })),
    ) as Record<string, { request: { properties: Record<string, unknown> } }>;
    expect(Object.keys(named.move_views!.request.properties)).toContain("override");
    expect(Object.keys(named.save_project!.request.properties)).not.toContain("override");
    await mcp.close();

    await connectOo("core");
    const core = JSON.parse(
      text(await mcp.call("describe_endpoints", { names: ["save_project"] })),
    ) as Record<string, { request: { properties: Record<string, unknown> } }>;
    expect(Object.keys(core.save_project!.request.properties)).toContain("override");
  });
});

describe("doctor({tools}): the tier is fixed at launch", () => {
  const manifest = () => {
    extension.banner = { name: "staruml-mcp-extension", version: "0.3.0", endpoints: [] };
    extension.reply("/introspect", {
      body: {
        success: true,
        data: {
          staruml: { version: "7.1.1", apiVersion: "7.1.1" },
          extension: { name: "staruml-mcp-extension", version: "0.3.0" },
          endpoints: BUNDLED_MANIFEST.endpoints,
        },
      },
    });
  };

  it("narrows core to oo, notifying the client, and refuses to widen it back", async () => {
    manifest();
    await connectOo("core");
    let changed = 0;
    mcp.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed++;
    });
    expect(await names()).toContain("generate_diagram");

    const report = text(await mcp.call("doctor", { tools: "oo" }));

    expect(report).toMatch(
      /tier +ok +oo: 8 extension tools listed, \d+ endpoints through call_endpoint/,
    );
    expect(catalog.selection.closed).toBe(true);
    expect(await names()).not.toContain("generate_diagram");
    expect(await names()).toContain("derive_diagrams");
    await vi.waitFor(() => expect(changed).toBeGreaterThan(0));

    extension.requests.length = 0;
    const refused = await mcp.call("doctor", { tools: "core" });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toEqual({
      error: {
        code: "TIER_LOCKED",
        message:
          "doctor cannot widen the oo tier to core: the tier was fixed when the server started",
        hint: expect.stringMatching(/^The oo tier states the model and derives the diagrams/),
      },
    });
    // Refused before the extension was read, and nothing changed.
    expect(extension.requests).toEqual([]);
    expect(catalog.selection.label).toBe("oo");
    expect(await names()).not.toContain("generate_diagram");
  });

  it.each([
    ["core", "core"],
    ["all", "all"],
    ["a drawing name added", "oo,move_views"],
    ["a hand-written tool added", "oo,generate_diagram"],
    ["an open list of oo's own tools", "build_model,derive_diagrams"],
  ])("refuses widening oo to %s", async (_, tools) => {
    await connectOo();

    const refused = await mcp.call("doctor", { tools });

    expect(refused.structuredContent).toMatchObject({ error: { code: "TIER_LOCKED" } });
    expect(text(refused)).toContain(`widen the oo tier to ${tools}`);
    expect(catalog.selection.label).toBe("oo");
    expect(extension.requests).toEqual([]);
  });

  it.each([
    ["oo again", "oo", "oo"],
    ["oo with a name it reaches already", "oo", "oo,save_project"],
    ["oo from oo with a name it reaches already", "oo,save_project", "oo"],
  ])("takes %s", async (_, from, tools) => {
    await connectOo(from);

    const result = await mcp.call("doctor", { tools });

    expect(result.structuredContent).toBeUndefined();
    expect(catalog.selection.label).toBe(tools);
  });

  it("narrows oo,move_views to oo, after which move_views is out of reach for good", async () => {
    await connectOo("oo,move_views");

    expect(text(await mcp.call("doctor", { tools: "oo" }))).toMatch(/tier +ok +oo:/);
    expect(await names()).not.toContain("move_views");
    const back = await mcp.call("doctor", { tools: "oo,move_views" });
    expect(back.structuredContent).toMatchObject({ error: { code: "TIER_LOCKED" } });
  });

  it("lists more under core without widening what it reaches: core to all is taken", async () => {
    await connectOo("core");

    await mcp.call("doctor", { tools: "all" });

    expect(catalog.selection.all).toBe(true);
  });

  it("switches oo to core and back with --allow-tier-switch", async () => {
    manifest();
    await connectOo("oo", true);

    expect(text(await mcp.call("doctor", { tools: "core" }))).toMatch(/tier +ok +core:/);
    expect(await names()).toContain("generate_diagram");
    await mcp.call("doctor", { tools: "oo" });
    expect(await names()).not.toContain("generate_diagram");
  });

  it("says in its schema whether the tier may widen", async () => {
    await connectOo();
    const locked = (await mcp.client.listTools()).tools.find((t) => t.name === "doctor")!;
    expect(locked.inputSchema.properties!.tools).toMatchObject({
      description: "Tier to list, never wider than at launch: core, oo, all or tool names.",
    });
    await mcp.close();

    await connectOo("oo", true);
    const open = (await mcp.client.listTools()).tools.find((t) => t.name === "doctor")!;
    expect(open.inputSchema.properties!.tools).toMatchObject({
      description: "Tier to list: core, oo, all or comma-separated tool names.",
    });
  });

  it("no sequence of doctor calls widens the tier through the MCP tool", async () => {
    const TIERS = ["oo", "core", "all", "oo,move_views", "oo,save_project", "build_model"];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("oo", "oo,move_views"),
        fc.array(fc.constantFrom(...TIERS), { minLength: 1, maxLength: 4 }),
        async (launch, calls) => {
          await connectOo(launch);
          const reachable = new Set(catalog.selection.reachable);
          for (const tools of calls) {
            await mcp.call("doctor", { tools });
            expect(catalog.selection.closed).toBe(true);
            for (const name of catalog.selection.reachable) expect(reachable).toContain(name);
            for (const name of await names()) {
              if (name !== "describe_endpoints" && name !== "call_endpoint") {
                expect(reachable).toContain(name);
              }
            }
          }
          await mcp.close();
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe("model-first answers", () => {
  /** /derive_diagrams of the extension's phase 1h build, two of ThingsBoard's diagrams. */
  const DERIVED = {
    model: "ThingsBoard",
    diagrams: [
      {
        kind: "package",
        name: "ThingsBoard packages",
        diagram: "AAAAAAGhDiqAx1",
        created: 31,
        updated: 0,
        unchanged: 0,
        deleted: 0,
        quality: { score: 96, rating: 5, passes: true },
      },
      {
        kind: "class",
        name: "Class - Entities and DAO",
        diagram: "AAAAAAGhDiqAx2",
        created: 0,
        updated: 2,
        unchanged: 40,
        deleted: 1,
        quality: { score: 82, rating: 5, passes: true },
      },
    ],
    counts: { diagrams: 2, created: 31, updated: 2, unchanged: 40, deleted: 1 },
    quality: { min: 82, mean: 89, passing: 2, failing: [] },
  };

  it("derive_diagrams answers each diagram by kind, name, id, non-zero counts and score", async () => {
    await connectOo();
    extension.reply("/get_style_profile", styleProfile(true));
    extension.reply("/derive_diagrams", { body: { success: true, data: DERIVED } });

    const result = await mcp.call("derive_diagrams", { scope: "ThingsBoard" });

    expect(extension.requests.at(-1)!.body).toEqual({ scope: "ThingsBoard" });
    // failing: [] is empty and pruned.
    expect(JSON.parse(text(result))).toEqual({
      model: "ThingsBoard",
      diagrams: [
        {
          kind: "package",
          name: "ThingsBoard packages",
          diagram: "AAAAAAGhDiqAx1",
          created: 31,
          score: 96,
        },
        {
          kind: "class",
          name: "Class - Entities and DAO",
          diagram: "AAAAAAGhDiqAx2",
          updated: 2,
          unchanged: 40,
          deleted: 1,
          score: 82,
        },
      ],
      counts: DERIVED.counts,
      quality: { min: 82, mean: 89, passing: 2 },
    });
  });

  it("derive_diagrams counts a dry run's ops per diagram and passes other answers", () => {
    const planned = deriveResult(
      { diagrams: [{ kind: "class", name: "A", diagram: "$diagram", created: 3, ops: 7 }] },
      {},
    );
    expect(JSON.parse(text(planned))).toEqual({
      diagrams: [{ kind: "class", name: "A", created: 3, ops: 7 }],
    });
    expect(text(deriveResult(null, {}))).toBe("null");
    expect(JSON.parse(text(deriveResult({ diagrams: [null, 4] }, {})))).toEqual({
      diagrams: [null, 4],
    });
  });

  it("explain_model answers its text as text, saying when it was cut", async () => {
    await connectOo();
    const explained =
      "Shop: 0 packages, 3 classifiers\n\n## Shop\n- Order (class): Holds a purchase";
    extension.reply("/explain_model", {
      body: { success: true, data: { text: explained, truncated: false } },
    });

    expect(text(await mcp.call("explain_model", { scope: "Shop" }))).toBe(explained);
    expect(text(explainResult({ text: "x", truncated: true }, {}))).toBe(
      "x\n[cut at maxChars; raise it or narrow scope]",
    );
    expect(text(explainResult({ count: 1 }, {}))).toBe('{"count":1}');
  });

  it("detect_patterns and model_lint take a scope and pass the rest unlisted", async () => {
    await connectOo();
    extension.reply("/detect_patterns", { body: { success: true, data: { detections: [] } } });
    extension.reply("/model_lint", {
      body: { success: true, data: { count: 0, counts: { error: 0 }, findings: [] } },
    });

    await mcp.call("detect_patterns", { scope: "Shop", minConfidence: 0.9 });
    await mcp.call("model_lint", { scope: "Shop", limit: 5, rules: { M001: "off" } });

    expect(extension.requests.map((r) => r.body)).toEqual([
      { scope: "Shop", minConfidence: 0.9 },
      { scope: "Shop", limit: 5, rules: { M001: "off" } },
    ]);
  });

  it("describe() of a closed tier passes a request schema without properties as it is", () => {
    // Every endpoint of extension 0.3.0 has properties; a newer one may take no body at all.
    const endpoints = BUNDLED_MANIFEST.endpoints.map((e) =>
      e.path === "/undo" ? { ...e, request: { type: "object" } } : e,
    );
    const compiled = compileManifest({ ...BUNDLED_MANIFEST, endpoints }, HAND_WRITTEN_TOOLS);
    const state = new CatalogState(
      { compiled, source: "bundled", enabled: true },
      parseToolSelection("oo"),
    );

    expect(describeEndpoints(state, { names: ["undo"] })).toEqual({
      undo: expect.objectContaining({ request: { type: "object" } }),
    });
  });

  it("describe() of a closed tier leaves out what it cannot reach", () => {
    const state = new CatalogState(undefined, parseToolSelection("oo"));
    const index = describeEndpoints(state, {});

    expect(Object.values(index).flatMap((g) => Object.keys(g as object))).not.toContain(
      "build_diagram",
    );
  });
});
