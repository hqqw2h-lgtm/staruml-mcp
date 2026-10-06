import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { CORE_ENDPOINTS } from "../src/tiers.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { diagnose, formatReport, healthy, type Check } from "../src/doctor.js";
import { CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST, type ManifestEntry } from "../src/manifest.js";
import { StarUMLApiError, StarUMLClient, TOKEN_HELP } from "../src/staruml-client.js";
import { parseToolSelection } from "../src/tiers.js";
import { closedPort, UpstreamFixture } from "./support/fixture.js";
import { connect, text } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let refused: number;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  refused = await closedPort();
});

afterEach(() => {
  builtin.reset();
  extension.reset();
  extension.banner = "Hello from fixture";
});

afterAll(async () => {
  await Promise.all([builtin.stop(), extension.stop()]);
});

function client(apiPort = builtin.port, extPort = extension.port): StarUMLClient {
  return new StarUMLClient({ host: HOST, port: apiPort, extPort });
}

function serve(
  version = "0.3.0",
  endpoints: ManifestEntry[] = BUNDLED_MANIFEST.endpoints,
  staruml = "7.1.1",
): void {
  extension.banner = { name: "staruml-mcp-extension", version, endpoints: [] };
  extension.reply("/introspect", {
    body: {
      success: true,
      data: {
        staruml: { version: staruml, apiVersion: staruml },
        extension: { name: "staruml-mcp-extension", version },
        endpoints,
      },
    },
  });
}

function check(checks: Check[], name: string): Check {
  return checks.find((c) => c.name === name)!;
}

const NODE = "22.23.3";

describe("diagnose", () => {
  it("names the URL and the token remedy for a refusal without the extension's codes", async () => {
    const proxied = Object.assign(Object.create(StarUMLClient.prototype) as StarUMLClient, {
      ping: async () => true,
      extensionBanner: async () => {
        throw new StarUMLApiError("Forbidden", {
          code: "REQUEST_REJECTED",
          slug: "/",
          upstream: "extension",
          status: 403,
        });
      },
    });
    Object.defineProperty(proxied, "extensionUrl", { value: "http://proxy:1" });
    Object.defineProperty(proxied, "builtinUrl", { value: "http://proxy:2" });

    const { checks } = await diagnose(proxied, { nodeVersion: NODE });

    expect(check(checks, "extension")).toEqual({
      name: "extension",
      status: "fail",
      detail: "http://proxy:1 refused the request: Forbidden [REQUEST_REJECTED]",
      remedy: `Check what answers at http://proxy:1. ${TOKEN_HELP}`,
    });
  });

  it("reports every check ok and the live manifest when everything is installed", async () => {
    serve();

    const { checks, catalog } = await diagnose(client(), { nodeVersion: NODE });

    expect(checks).toEqual([
      { name: "node", status: "ok", detail: NODE },
      { name: "staruml api", status: "ok", detail: `${HOST}:${builtin.port}` },
      { name: "extension", status: "ok", detail: `0.3.0 at ${HOST}:${extension.port}` },
      { name: "staruml", status: "ok", detail: "7.1.1" },
      { name: "manifest", status: "ok", detail: "103 endpoints from the live manifest" },
    ]);
    expect(catalog).toMatchObject({ source: "live", enabled: true });
    expect(extension.requests).toContainEqual({
      method: "POST",
      path: "/introspect",
      body: { include: ["endpoints"] },
    });
    expect(healthy(checks)).toBe(true);
  });

  it("uses the running Node version by default", async () => {
    serve();

    const { checks } = await diagnose(client());

    expect(check(checks, "node").detail).toBe(process.versions.node);
  });

  it("fails an old Node with the install link", async () => {
    serve();

    const { checks } = await diagnose(client(), { nodeVersion: "18.20.0" });

    expect(check(checks, "node")).toEqual({
      name: "node",
      status: "fail",
      detail: "18.20.0 is older than 20",
      remedy: "Install Node.js 20+ (https://nodejs.org).",
    });
    expect(healthy(checks)).toBe(false);
  });

  it("asks to start StarUML when neither port answers, and falls back to the bundled manifest", async () => {
    const { checks, catalog } = await diagnose(client(refused, refused), { nodeVersion: NODE });

    expect(check(checks, "staruml api")).toMatchObject({
      status: "fail",
      remedy: expect.stringContaining("Start StarUML 7.0.0+ with its API server enabled"),
    });
    expect(check(checks, "extension")).toMatchObject({
      status: "fail",
      detail: `no answer at ${HOST}:${refused}`,
      remedy: "Start StarUML; the extension listens while StarUML runs.",
    });
    expect(check(checks, "manifest").detail).toBe("103 endpoints from the bundled manifest");
    expect(catalog).toMatchObject({ source: "bundled", enabled: true });
    expect(checks.map((c) => c.name)).not.toContain("staruml");
  });

  it("asks to enable the API server when only the extension answers", async () => {
    serve();

    const { checks } = await diagnose(client(refused), { nodeVersion: NODE });

    expect(check(checks, "staruml api")).toMatchObject({
      status: "fail",
      remedy: expect.stringMatching(/^Enable StarUML's API server \("apiServer": true/),
    });
    expect(check(checks, "extension").status).toBe("ok");
  });

  it("gives the install URL when StarUML answers but the extension does not", async () => {
    const { checks, catalog } = await diagnose(client(builtin.port, refused), {
      nodeVersion: NODE,
    });

    expect(check(checks, "extension").remedy).toBe(
      "Install staruml-mcp-extension 0.3.x (Tools > Extension Manager > Install From Url: https://github.com/hqqw2h-lgtm/staruml-mcp-extension), then restart StarUML; or pass --ext-port.",
    );
    expect(catalog.source).toBe("bundled");
  });

  it("refuses the extension tools of a pre-0.3 extension without /introspect", async () => {
    extension.banner = { name: "staruml-mcp-extension", version: "0.2.2" };

    const { checks, catalog } = await diagnose(client(), { nodeVersion: NODE });

    expect(check(checks, "extension")).toEqual({
      name: "extension",
      status: "fail",
      detail: `0.2.2 at ${HOST}:${extension.port} is incompatible; this server needs 0.3.x, so extension tools are not offered`,
      remedy:
        "Install staruml-mcp-extension 0.3.x from https://github.com/hqqw2h-lgtm/staruml-mcp-extension (Tools > Extension Manager > Install From Url), then restart StarUML.",
    });
    expect(catalog.enabled).toBe(false);
    expect(check(checks, "manifest").detail).toBe("0 endpoints from the bundled manifest");
  });

  it("refuses an extension that names /introspect UNKNOWN_ENDPOINT even if its banner looks compatible", async () => {
    extension.banner = { version: "0.3.0" };
    extension.reply("/introspect", {
      status: 404,
      body: { success: false, code: "UNKNOWN_ENDPOINT", error: "No handler for /introspect" },
    });

    const { catalog } = await diagnose(client(), { nodeVersion: NODE });

    expect(catalog.enabled).toBe(false);
  });

  it("refuses an extension with another major version", async () => {
    serve("1.0.0");

    const { checks, catalog } = await diagnose(client(), { nodeVersion: NODE });

    expect(check(checks, "extension")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("1.0.0 at"),
    });
    expect(check(checks, "staruml").status).toBe("ok");
    expect(catalog).toMatchObject({ source: "bundled", enabled: false });
  });

  it("accepts a newer patch release", async () => {
    serve("0.3.9");

    const { catalog } = await diagnose(client(), { nodeVersion: NODE });

    expect(catalog).toMatchObject({ source: "live", enabled: true });
  });

  it("warns and keeps the bundled tools when a compatible extension's /introspect fails", async () => {
    extension.banner = { version: "0.3.1" };
    extension.reply("/introspect", { body: { success: true, data: { endpoints: "nope" } } });

    const { checks, catalog } = await diagnose(client(), { nodeVersion: NODE });

    expect(check(checks, "extension")).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(
        /^0\.3\.1 at .*; \/introspect failed \(.+\), using the bundled manifest$/,
      ),
      remedy: expect.stringContaining("/issues"),
    });
    expect(catalog).toMatchObject({ source: "bundled", enabled: true });
    expect(healthy(checks)).toBe(true);
  });

  it("treats a banner that is not JSON as an unknown, incompatible version", async () => {
    extension.reply("/introspect", { status: 500, body: { success: false, error: "boom" } });

    const { checks, catalog } = await diagnose(client(), { nodeVersion: NODE });

    expect(check(checks, "extension").detail).toMatch(/^unknown version at /);
    expect(catalog.enabled).toBe(false);
  });

  it("reports a non-Error failure of /introspect", async () => {
    extension.banner = { version: "0.3.0" };
    const failing = client();
    failing.introspectManifest = () => Promise.reject("socket hang up");

    const { checks } = await diagnose(failing, { nodeVersion: NODE });

    expect(check(checks, "extension").detail).toContain("/introspect failed (socket hang up)");
  });

  it("fails a StarUML without the API server", async () => {
    serve("0.3.0", BUNDLED_MANIFEST.endpoints, "6.3.0");

    const { checks } = await diagnose(client(), { nodeVersion: NODE });

    expect(check(checks, "staruml")).toEqual({
      name: "staruml",
      status: "fail",
      detail: "6.3.0 has no API server",
      remedy: "Upgrade to StarUML 7.0.0+ (https://staruml.io/download).",
    });
  });

  it("warns about endpoints it could not turn into tools", async () => {
    const broken = {
      ...BUNDLED_MANIFEST.endpoints[0]!,
      path: "/broken",
      request: { type: "string" },
    };
    serve("0.3.0", [...BUNDLED_MANIFEST.endpoints, broken]);

    const { checks } = await diagnose(client(), { nodeVersion: NODE });

    expect(check(checks, "manifest")).toEqual({
      name: "manifest",
      status: "warn",
      detail:
        "103 endpoints from the live manifest; skipped /broken (request schema is not an object schema)",
    });
  });
});

describe("formatReport", () => {
  it("aligns the columns and puts each remedy under its check", () => {
    expect(
      formatReport([
        { name: "node", status: "ok", detail: "22.0.0" },
        { name: "extension", status: "fail", detail: "down", remedy: "Install it." },
      ]),
    ).toBe(
      ["node       ok    22.0.0", "extension  fail  down", "           fix   Install it."].join(
        "\n",
      ),
    );
  });
});

describe("doctor tool", () => {
  function changes(mcp: Awaited<ReturnType<typeof connect>>): () => number {
    let count = 0;
    mcp.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      count++;
    });
    return () => count;
  }

  async function names(mcp: Awaited<ReturnType<typeof connect>>): Promise<string[]> {
    return (await mcp.client.listTools()).tools.map((t) => t.name);
  }

  it("returns the report and adopts the live manifest", async () => {
    const live = BUNDLED_MANIFEST.endpoints
      .filter((e) => e.path !== "/debug")
      .concat({ ...BUNDLED_MANIFEST.endpoints[0]!, path: "/frobnicate", description: "Build." });
    serve("0.3.0", live);
    const catalog = new CatalogState(undefined, parseToolSelection("all"));
    const mcp = await connect({
      apiHost: HOST,
      apiPort: builtin.port,
      extPort: extension.port,
      catalog,
    });
    const changed = changes(mcp);
    try {
      expect(await names(mcp)).toContain("debug");

      const result = await mcp.call("doctor");

      expect(result.isError).toBeFalsy();
      expect(text(result)).toMatch(/^node +ok/);
      expect(text(result)).toContain("manifest     ok    103 endpoints from the live manifest");
      expect(text(result)).toContain(
        "tier         ok    all: 103 extension tools listed, 0 endpoints through call_endpoint",
      );
      const after = await names(mcp);
      expect(after).toContain("frobnicate");
      expect(after).not.toContain("debug");
      expect(catalog.current.source).toBe("live");
      await vi.waitFor(() => expect(changed()).toBeGreaterThan(0));

      // A second run with the same manifest changes nothing.
      const before = changed();
      await mcp.call("doctor");
      expect(changed()).toBe(before);
    } finally {
      await mcp.close();
    }
  });

  it("re-registers a tool whose definition changed", async () => {
    const [first, ...rest] = BUNDLED_MANIFEST.endpoints;
    serve("0.3.0", [{ ...first!, description: "Changed upstream." }, ...rest]);
    const mcp = await connect({
      apiHost: HOST,
      apiPort: builtin.port,
      extPort: extension.port,
      catalog: new CatalogState(undefined, parseToolSelection("all")),
    });
    try {
      await mcp.call("doctor");

      const tool = (await mcp.client.listTools()).tools.find((t) => t.name === "get_all_commands");
      expect(tool!.description).toBe("Changed upstream.");
    } finally {
      await mcp.close();
    }
  });

  it("withdraws the extension tools when the extension became incompatible", async () => {
    serve("0.4.0");
    const mcp = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
    try {
      const result = await mcp.call("doctor");

      expect(text(result)).toContain("is incompatible; this server needs 0.3.x");
      expect((await names(mcp)).sort()).toEqual([
        "diagram_as_text",
        "doctor",
        "generate_diagram",
        "get_all_diagrams_info",
        "get_current_diagram_info",
        "get_diagram_image_by_id",
        "view_diagram",
      ]);
      expect(text(result)).toContain("tier         ok    core: 0 extension tools listed");
    } finally {
      await mcp.close();
    }
  });

  it("switches the listed tier on request and notifies the client", async () => {
    serve();
    const catalog = new CatalogState();
    const mcp = await connect({
      apiHost: HOST,
      apiPort: builtin.port,
      extPort: extension.port,
      catalog,
    });
    const changed = changes(mcp);
    try {
      expect(await names(mcp)).not.toContain("create_diagram");

      const result = await mcp.call("doctor", { tools: "core,create_diagram,nope" });

      expect(catalog.selection.label).toBe("core,create_diagram,nope");
      expect(await names(mcp)).toContain("create_diagram");
      expect(text(result)).toMatch(
        new RegExp(
          `tier +warn +core,create_diagram,nope: ${CORE_ENDPOINTS.length + 1} extension tools .*; unknown: nope\n +fix +Check the names`,
        ),
      );
      await vi.waitFor(() => expect(changed()).toBeGreaterThan(0));
    } finally {
      await mcp.close();
    }
  });

  it("rejects a malformed tier without changing the listing", async () => {
    const catalog = new CatalogState();
    const mcp = await connect({ apiHost: HOST, apiPort: refused, extPort: refused, catalog });
    try {
      const result = await mcp.call("doctor", { tools: "core,Bad Name" });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: "INVALID_ARGUMENT",
          message:
            'Invalid tools: "core,Bad Name". Use core, oo, all, or comma-separated tool names such as core,create_diagram.',
        },
      });
      expect(catalog.selection.label).toBe("core");
    } finally {
      await mcp.close();
    }
  });
});
