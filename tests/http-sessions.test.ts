import { createServer as createHttpServer, type Server } from "node:http";
import { CORE_ENDPOINTS } from "../src/tiers.js";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CatalogState } from "../src/extension-tools.js";
import { DEFAULT_SESSION_LIMITS, SessionStore, type SessionLimits } from "../src/http-sessions.js";
import { createHttpHandler, type HttpHandler } from "../src/index.js";
import { BUNDLED_MANIFEST } from "../src/manifest.js";
import type { ServerConfig } from "../src/server.js";
import { VIEWER_URI } from "../src/viewer.js";
import { UpstreamFixture } from "./support/fixture.js";
import { UI_CAPABILITIES } from "./support/mcp.js";
import { INITIALIZE_PARAMS, MCP_HEADERS, parseSse } from "./support/sse.js";

/** The hand-written tools, describe_endpoints and call_endpoint, and the core endpoints. */
const CORE_TOOLS = 9 + CORE_ENDPOINTS.length;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><text>Book</text></svg>';

const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let config: ServerConfig;
const running: { http: Server; handler: HttpHandler }[] = [];

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
});

afterEach(async () => {
  for (const { http, handler } of running.splice(0)) {
    await handler.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  builtin.reset();
  extension.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all([builtin.stop(), extension.stop()]);
});

/** A listening handler with its own catalog; `now` drives the session clock. */
async function listen(
  sessions?: SessionLimits,
  now?: () => number,
): Promise<{ base: string; handler: HttpHandler; catalog: CatalogState }> {
  const catalog = new CatalogState();
  config = {
    apiHost: "http://127.0.0.1",
    apiPort: builtin.port,
    extPort: extension.port,
    name: "staruml-mcp",
    version: "9.9.9",
    catalog,
  };
  const handler = createHttpHandler(config, undefined, { loopbackOnly: true, sessions, now });
  const http = createHttpServer(handler);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  running.push({ http, handler });
  return { base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, handler, catalog };
}

/** An SDK client over Streamable HTTP, as Claude Code connects with `--transport http`. */
async function client(base: string, capabilities: ClientCapabilities = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  const mcp = new Client({ name: "staruml-mcp-tests", version: "0.0.0" }, { capabilities });
  await mcp.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await mcp.callTool({ name, arguments: args })) as CallToolResult;
  return { mcp, transport, call };
}

/** `initialize` by hand: the session id, without the GET stream an SDK client opens. */
async function initialize(base: string): Promise<string> {
  const res = await request(base)
    .post("/mcp")
    .set(MCP_HEADERS)
    .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE_PARAMS });
  expect(res.status).toBe(200);
  return String(res.headers["mcp-session-id"]);
}

function toolsList(base: string, session?: string) {
  return request(base)
    .post("/mcp")
    .set({ ...MCP_HEADERS, ...(session === undefined ? {} : { "Mcp-Session-Id": session }) })
    .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
}

function serveSvg(): void {
  extension.reply("/export_diagram", {
    body: {
      success: true,
      data: {
        diagram: "D1",
        format: "svg",
        width: 4,
        height: 2,
        base64: Buffer.from(SVG).toString("base64"),
      },
    },
  });
  extension.reply("/get_element_by_id", {
    body: { success: true, data: { _id: "D1", _type: "UMLClassDiagram", name: "Main" } },
  });
}

describe("sessions", () => {
  it("keeps one server per session: view_diagram sees the client's MCP Apps capability", async () => {
    const { base, handler } = await listen();
    const { mcp, transport, call } = await client(base, UI_CAPABILITIES);
    try {
      expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(handler.sessions.size).toBe(1);
      serveSvg();

      const result = await call("view_diagram", { id: "D1" });

      expect(result.structuredContent).toMatchObject({ diagram: "D1", name: "Main", svg: SVG });
      expect(handler.sessions.size).toBe(1);
    } finally {
      await mcp.close();
    }
  });

  it("remembers a read of the viewer resource for later view_diagram calls", async () => {
    const { base } = await listen();
    const { mcp, call } = await client(base);
    try {
      serveSvg();
      builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: "iVBORw0KGgo=" } });
      expect((await call("view_diagram", { id: "D1" })).content[0]!.type).toBe("image");

      await mcp.readResource({ uri: VIEWER_URI });

      expect((await call("view_diagram", { id: "D1" })).structuredContent).toMatchObject({
        svg: SVG,
      });
    } finally {
      await mcp.close();
    }
  });

  it("delivers list_changed to every session when doctor switches the tier", async () => {
    const { base, catalog } = await listen();
    extension.banner = { name: "staruml-mcp-extension", version: "0.3.0", endpoints: [] };
    extension.reply("/introspect", { body: { success: true, data: BUNDLED_MANIFEST } });
    const a = await client(base);
    const b = await client(base);
    const changed = { a: 0, b: 0 };
    a.mcp.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed.a++);
    b.mcp.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed.b++);
    try {
      expect(catalog.subscribers).toBe(2);
      const names = async () => (await b.mcp.listTools()).tools.map((t) => t.name);
      expect(await names()).not.toContain("create_diagram");

      const report = await a.call("doctor", { tools: "core,create_diagram" });

      expect(report.isError).toBeFalsy();
      await vi.waitFor(() => expect(changed).toEqual({ a: 1, b: 1 }));
      expect(await names()).toContain("create_diagram");
    } finally {
      await Promise.all([a.mcp.close(), b.mcp.close()]);
    }
  });

  it("ends the session on DELETE and answers its id with 404 afterwards", async () => {
    const { base, handler, catalog } = await listen();
    const { mcp, transport } = await client(base);
    const id = transport.sessionId!;

    await transport.terminateSession();
    await mcp.close();

    expect(handler.sessions.has(id)).toBe(false);
    expect(catalog.subscribers).toBe(0);
    const res = await toolsList(base, id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    });
  });

  it("serves requests that carry no session id statelessly", async () => {
    const { base, handler, catalog } = await listen();
    await initialize(base);

    const res = await toolsList(base);

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect((parseSse(res.text).result!.tools as unknown[]).length).toBe(CORE_TOOLS);
    expect(handler.sessions.size).toBe(1);
    // The stateless server unsubscribed when its response closed.
    await vi.waitFor(() => expect(catalog.subscribers).toBe(1));
  });

  it("refuses a batch with two initialize requests without keeping a session", async () => {
    const { base, handler, catalog } = await listen();
    const init = { jsonrpc: "2.0", method: "initialize", params: INITIALIZE_PARAMS };

    const res = await request(base)
      .post("/mcp")
      .set(MCP_HEADERS)
      .send([
        { ...init, id: 1 },
        { ...init, id: 2 },
      ]);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      "Invalid Request: Only one initialization request is allowed",
    );
    expect(handler.sessions.size).toBe(0);
    expect(catalog.subscribers).toBe(0);
  });

  it("answers a body that is not JSON with a JSON-RPC parse error", async () => {
    const { base } = await listen();

    const res = await request(base).post("/mcp").set(MCP_HEADERS).send("{not json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON" },
      id: null,
    });
  });

  it("answers a session's request that is not JSON with a parse error, keeping the session", async () => {
    const { base, handler } = await listen();
    const session = await initialize(base);

    const res = await request(base)
      .post("/mcp")
      .set({ ...MCP_HEADERS, "Mcp-Session-Id": session })
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: -32700, message: "Parse error: Invalid JSON" });
    expect(handler.sessions.has(session)).toBe(true);
  });

  it("leaves a GET without a session to the stateless transport", async () => {
    const { base } = await listen();

    const res = await request(base).get("/mcp").set({ Accept: "application/json" });

    expect(res.status).toBe(406);
  });

  it("closes the least recently used session beyond the cap", async () => {
    const { base, handler } = await listen({ ...DEFAULT_SESSION_LIMITS, maxSessions: 2 });
    const first = await initialize(base);
    const second = await initialize(base);
    expect((await toolsList(base, first)).status).toBe(200);

    const third = await initialize(base);

    expect(handler.sessions.size).toBe(2);
    expect(handler.sessions.has(second)).toBe(false);
    expect((await toolsList(base, first)).status).toBe(200);
    expect((await toolsList(base, third)).status).toBe(200);
    expect((await toolsList(base, second)).status).toBe(404);
  });

  it("closes sessions idle past the timeout, but not one holding a stream open", async () => {
    let clock = 1_000_000;
    const { base, handler } = await listen({ idleTimeoutMs: 60_000, maxSessions: 8 }, () => clock);
    const idle = await initialize(base);
    const streaming = await client(base);
    try {
      clock += 60_000;
      expect(await handler.sessions.sweep()).toBe(0);
      expect((await toolsList(base, idle)).status).toBe(200);

      clock += 60_001;
      // The SDK client's GET stream is a request in flight.
      await vi.waitFor(async () => expect(await handler.sessions.sweep()).toBe(1));

      expect(handler.sessions.has(idle)).toBe(false);
      expect(handler.sessions.has(streaming.transport.sessionId!)).toBe(true);
    } finally {
      await streaming.mcp.close();
    }
  });

  it("with --max-sessions 0 never opens a session and ignores session ids", async () => {
    const { base, handler } = await listen({ ...DEFAULT_SESSION_LIMITS, maxSessions: 0 });

    const res = await request(base)
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE_PARAMS });

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(handler.sessions.size).toBe(0);
    expect((await toolsList(base, "made-up")).status).toBe(200);
  });

  it("keeps the loopback check in front of sessions", async () => {
    const { base } = await listen();
    const id = await initialize(base);

    const res = await toolsList(base, id).set("Host", "evil.example");

    expect(res.status).toBe(403);
  });
});

describe("SessionStore", () => {
  it("ends every session on close", async () => {
    const { base, handler } = await listen();
    const id = await initialize(base);

    await handler.close();

    expect(handler.sessions.size).toBe(0);
    expect((await toolsList(base, id)).status).toBe(404);
  });

  it("sweeps on a timer no slower than once a minute", () => {
    vi.useFakeTimers();
    const store = new SessionStore({ idleTimeoutMs: 3_600_000, maxSessions: 1 });
    const sweep = vi.spyOn(store, "sweep").mockResolvedValue(0);

    vi.advanceTimersByTime(60_000);

    expect(sweep).toHaveBeenCalledTimes(1);
    void store.close();
  });

  it("starts no timer when sessions are off", () => {
    vi.useFakeTimers();
    const store = new SessionStore({ idleTimeoutMs: 1_000, maxSessions: 0 });

    expect(store.enabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    void store.close();
  });

  it("defaults to 30 minutes and 64 sessions", () => {
    const store = new SessionStore();
    expect(store.limits).toEqual({ idleTimeoutMs: 1_800_000, maxSessions: 64 });
    void store.close();
  });
});
