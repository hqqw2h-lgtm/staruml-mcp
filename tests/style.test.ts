import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setProfileResult } from "../src/style.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  mcp = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
});

afterEach(() => {
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await mcp.close();
  await Promise.all([builtin.stop(), extension.stop()]);
});

/** `uml-standard` as the extension's phase 1h build answers it, cut to the fields tested. */
const PROFILE = {
  name: "uml-standard",
  description: "UML 2.5 conventions on StarUML's own look",
  strict: true,
  blockSaveOnErrors: false,
  naming: { classifier: { pattern: "PascalCase", fix: "pascal" } },
  layout: { maxElements: 30, page: { width: 1600, height: 1200 } },
  quality: { minScore: 80, maxIterations: 3, thresholds: { sequence: 75 } },
};

describe("style profile endpoints", () => {
  it("are reached through call_endpoint and indexed under style", async () => {
    const { tools } = await mcp.client.listTools();
    const index = JSON.parse(text(await mcp.call("describe_endpoints"))) as {
      style: Record<string, string>;
    };

    expect(tools.map((t) => t.name)).not.toContain("set_style_profile");
    expect(Object.keys(index.style)).toEqual(
      expect.arrayContaining([
        "get_style_profile",
        "set_style_profile",
        "apply_style_profile",
        "explain_style_violation",
      ]),
    );
  });

  it("set_style_profile answers the profile's name and switches, not the whole profile", async () => {
    extension.reply("/set_style_profile", {
      body: { success: true, data: { profile: PROFILE, source: "project", changed: true } },
    });

    const result = await mcp.call("call_endpoint", {
      name: "set_style_profile",
      body: { patch: { strict: true } },
    });

    expect(extension.requests[0]!.body).toEqual({ patch: { strict: true } });
    expect(JSON.parse(text(result))).toEqual({
      profile: "uml-standard",
      strict: true,
      blockSaveOnErrors: false,
      source: "project",
      changed: true,
    });
  });

  it("get_style_profile answers the whole profile, which is what it is for", async () => {
    extension.reply("/get_style_profile", {
      body: { success: true, data: { profile: PROFILE, source: "preferences" } },
    });

    const result = await mcp.call("call_endpoint", { name: "get_style_profile" });

    expect(JSON.parse(text(result))).toEqual({ profile: PROFILE, source: "preferences" });
  });

  it("refuses a profile name the request schema does not take before sending", async () => {
    const result = await mcp.call("call_endpoint", {
      name: "set_style_profile",
      body: { profile: "neon" },
    });

    expect(result.structuredContent).toMatchObject({
      error: { code: "INVALID_ARGUMENT", endpoint: "/set_style_profile" },
    });
    expect(extension.requests).toEqual([]);
  });

  it("surfaces STYLE_LOCKED from a locked endpoint with the strict profile's remedies", async () => {
    extension.reply("/move_views", {
      status: 403,
      body: {
        success: false,
        code: "STYLE_LOCKED",
        error: "/move_views: the style profile 'uml-standard' is strict",
        details: { profile: "uml-standard", endpoint: "/move_views" },
      },
    });

    const result = await mcp.call("call_endpoint", {
      name: "move_views",
      body: { refs: ["V1"], dx: 10, dy: 0 },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "STYLE_LOCKED", status: 403, endpoint: "/move_views" },
    });
    expect(text(result)).toContain("Hint: The style profile 'uml-standard' is strict");
    expect(text(result)).toContain("improve_diagram");
  });

  it("passes the answers it does not know as compact JSON", () => {
    expect(text(setProfileResult(null, {}))).toBe("null");
    expect(text(setProfileResult({ profile: "minimal" }, {}))).toBe('{"profile":"minimal"}');
    expect(text(setProfileResult({ profile: { strict: true } }, {}))).toBe(
      '{"profile":{"strict":true}}',
    );
  });
});
