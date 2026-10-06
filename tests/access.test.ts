/**
 * Extension 0.3.0's request checks as tools see them: the access token on every request and the
 * hints for each refusal, through the MCP in-memory transport against the HTTP stand-ins.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BUNDLED_MANIFEST } from "../src/manifest.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
const TOKEN = "tok_9Zq";

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
});

afterEach(() => {
  builtin.reset();
  extension.reset();
  extension.banner = "Hello from fixture";
});

afterAll(async () => {
  await Promise.all([builtin.stop(), extension.stop()]);
});

async function withServer(
  extToken: string | undefined,
  body: (mcp: ConnectedClient) => Promise<void>,
): Promise<void> {
  const mcp = await connect({
    apiHost: HOST,
    apiPort: builtin.port,
    extPort: extension.port,
    extToken,
  });
  try {
    await body(mcp);
  } finally {
    await mcp.close();
  }
}

function serveManifest(): void {
  extension.banner = { name: "staruml-mcp-extension", version: "0.3.0" };
  extension.reply("/introspect", { body: { success: true, data: BUNDLED_MANIFEST } });
}

describe("access token", () => {
  it("is sent with tool calls, call_endpoint, resources and the doctor's probes", async () => {
    extension.token = TOKEN;
    serveManifest();
    extension.reply("/find_elements", { body: { success: true, data: { count: 0 } } });
    extension.reply("/is_modified", { body: { success: true, data: { modified: false } } });
    extension.reply("/get_project_info", { body: { success: true, data: { filename: "/a" } } });

    await withServer(TOKEN, async (mcp) => {
      expect(text(await mcp.call("find_elements", { type: "UMLClass" }))).toBe('{"count":0}');
      expect(text(await mcp.call("call_endpoint", { name: "is_modified" }))).toBe(
        '{"modified":false}',
      );
      await mcp.client.readResource({ uri: "staruml://project" });
      expect(text(await mcp.call("doctor"))).toMatch(
        /extension +ok +0\.3\.0 at http:\/\/127\.0\.0\.1:\d+ \(access token sent\)/,
      );
    });

    expect(extension.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /find_elements",
      "POST /is_modified",
      "POST /get_project_info",
      "GET /",
      "POST /introspect",
    ]);
    expect(new Set(extension.authorizations)).toEqual(new Set([`Bearer ${TOKEN}`]));
    expect(builtin.authorizations.every((a) => a === undefined)).toBe(true);
  });

  it("missing: tools fail with UNAUTHORIZED and say how to configure it", async () => {
    extension.token = TOKEN;

    await withServer(undefined, async (mcp) => {
      const result = await mcp.call("find_elements", { type: "UMLClass" });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "UNAUTHORIZED",
          status: 401,
          message: "Missing or wrong bearer token",
          endpoint: "/find_elements",
        },
      });
      expect(text(result)).toContain(
        "Hint: The extension requires an access token. In StarUML, Tools > MCP Extension > Server Info says whether a token is required and Generate Access Token... creates one; pass it with --ext-token <token> or STARUML_EXT_TOKEN.",
      );
    });
  });

  it("missing: the doctor fails the extension check with the same remedy", async () => {
    extension.token = TOKEN;
    serveManifest();

    await withServer(undefined, async (mcp) => {
      const report = text(await mcp.call("doctor"));

      expect(report).toMatch(
        /extension +fail +http:\/\/127\.0\.0\.1:\d+ refused the request: Missing or wrong bearer token \[UNAUTHORIZED\]\n +fix +The extension requires an access token\. In StarUML, Tools > MCP Extension > Server Info/,
      );
      expect(report).toContain(
        "To turn the check off, clear Preferences > MCP Extension > Access Token.",
      );
      // The bundled tools stay listed, so their calls carry the hint too.
      expect(report).toMatch(/manifest +ok +103 endpoints from the bundled manifest/);
    });
    expect(extension.requests.map((r) => r.path)).toEqual(["/"]);
  });

  it("wrong: the hint says the token sent was rejected", async () => {
    extension.token = TOKEN;

    await withServer("stale", async (mcp) => {
      const result = await mcp.call("batch", { ops: [{ path: "/is_modified" }] });

      expect(text(result)).toContain(
        "Hint: The extension rejected the access token this server sent.",
      );
    });
    expect(extension.authorizations).toEqual(["Bearer stale"]);
  });

  it("not required: a configured token is sent and ignored", async () => {
    extension.reply("/is_modified", { body: { success: true, data: { modified: true } } });

    await withServer(TOKEN, async (mcp) => {
      expect(text(await mcp.call("call_endpoint", { name: "is_modified" }))).toBe(
        '{"modified":true}',
      );
    });
  });
});

describe("refusals", () => {
  it.each([
    ["FORBIDDEN_ORIGIN", 403, {}, "Allowed Origins"],
    ["PAYLOAD_TOO_LARGE", 413, {}, "Max Batch Ops; split it or raise the limit."],
    ["UNSUPPORTED_MEDIA_TYPE", 415, {}, "takes only Content-Type: application/json"],
    ["RATE_LIMITED", 429, { "Retry-After": "7" }, "Retry in 7 s;"],
    ["TIMEOUT", 504, {}, "StarUML may still finish the work"],
  ])("%s (HTTP %d) reaches the model with a hint", async (code, status, headers, hint) => {
    extension.reply("/batch", {
      status,
      headers,
      body: { success: false, code, error: `${code} from the extension` },
    });

    await withServer(undefined, async (mcp) => {
      const result = await mcp.call("batch", { ops: [{ path: "/is_modified" }] });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code, status, endpoint: "/batch", upstream: "extension" },
      });
      expect(text(result)).toContain(`[${code}, /batch, HTTP ${status}]\nHint: `);
      expect(text(result)).toContain(hint);
    });
  });
});
