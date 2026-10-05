import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttpHandler } from "../src/index.js";
import { createServer, type ServerConfig } from "../src/server.js";
import { UpstreamFixture } from "./support/fixture.js";
import { INITIALIZE_PARAMS, MCP_HEADERS, rpc } from "./support/sse.js";

const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let config: ServerConfig;
let httpServer: Server;
/**
 * Base URL of the listening transport. Passing the unbound Server to supertest makes it bind
 * per request, which breaks when 50 requests share the same Server object.
 */
let server: string;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  config = {
    apiHost: "http://127.0.0.1",
    apiPort: builtin.port,
    extPort: extension.port,
    name: "staruml-mcp",
    version: "9.9.9",
  };
  httpServer = createHttpServer(createHttpHandler(config));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  server = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(() => {
  builtin.reset();
  extension.reset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
  await Promise.all([builtin.stop(), extension.stop()]);
});

describe("POST /mcp", () => {
  it("answers initialize with server info", async () => {
    const { status, contentType, message } = await rpc(server, 1, "initialize", INITIALIZE_PARAMS);

    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
    expect(message.id).toBe(1);
    expect(message.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "staruml-mcp", version: "9.9.9" },
      capabilities: { tools: {} },
    });
  });

  it("lists the core tier without a session", async () => {
    const { message } = await rpc(server, 2, "tools/list");

    const tools = message.result!.tools as { name: string; inputSchema: object }[];
    expect(tools).toHaveLength(16);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["generate_diagram", "find_elements", "call_endpoint"]),
    );
    // On the wire, not only through the in-memory transport.
    for (const tool of tools) expect(tool.inputSchema).not.toHaveProperty("$schema");
  });

  it("calls a tool against StarUML", async () => {
    builtin.reply("/get_all_diagrams_info", { body: { success: true, data: [{ id: "D1" }] } });

    const { message } = await rpc(server, 3, "tools/call", {
      name: "get_all_diagrams_info",
      arguments: {},
    });

    expect(message.result).toEqual({
      content: [{ type: "text", text: JSON.stringify([{ id: "D1" }]) }],
    });
  });

  it("returns a tool error result rather than a JSON-RPC error", async () => {
    extension.reply("/delete_element", {
      status: 400,
      body: { success: false, error: "Element not found: X" },
    });

    const { message } = await rpc(server, 4, "tools/call", {
      name: "delete_element",
      arguments: { id: "X" },
    });

    expect(message.error).toBeUndefined();
    expect(message.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "REQUEST_REJECTED", message: "Element not found: X" } },
    });
  });

  it("serves concurrent requests independently", async () => {
    builtin.reply("/get_current_diagram_info", { body: { success: true, data: { id: "D1" } } });

    const ids = Array.from({ length: 50 }, (_, i) => 100 + i);
    const responses = await Promise.all(
      ids.map((id) =>
        rpc(server, id, "tools/call", { name: "get_current_diagram_info", arguments: {} }),
      ),
    );

    expect(responses.map((r) => r.message.id)).toEqual(ids);
    for (const { message } of responses) {
      expect(message.result).toMatchObject({ content: [{ type: "text" }] });
      expect(message.result!.isError).toBeUndefined();
    }
    expect(builtin.requests).toHaveLength(50);
    // Correctness, not speed (scripts/load-test.mjs measures that): 50 fresh McpServers took
    // 1.7–5 s on a host at load average 80, past vitest's 5 s default.
  }, 20_000);

  it("rejects a client that does not accept text/event-stream", async () => {
    const res = await request(server)
      .post("/mcp")
      .set({ "Content-Type": "application/json", Accept: "application/json" })
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(406);
  });
});

describe("non-MCP paths", () => {
  it("serves a JSON banner at /", async () => {
    const res = await request(server).get("/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.body).toEqual({
      name: "staruml-mcp",
      version: "9.9.9",
      mcp_endpoint: "/mcp",
      transport: "streamable-http",
      auth_required: false,
    });
  });

  it.each(["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"])(
    "answers OAuth discovery %s with a JSON 404",
    async (path) => {
      const res = await request(server).get(path);

      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toBe("application/json");
      expect(res.body).toEqual({
        error: "not_found",
        error_description: "staruml-mcp does not require OAuth. Use the /mcp endpoint directly.",
      });
    },
  );

  it.each(["/sse", "/mcp/", "/mcp?x=1", "/favicon.ico"])(
    "answers unknown path %s with a JSON 404",
    async (path) => {
      const res = await request(server).post(path).send({});

      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toBe("application/json");
      expect(res.body).toEqual({
        error: "not_found",
        error_description: `Unknown path "${path}". Use /mcp for MCP streamable-http transport.`,
      });
    },
  );

  it("treats a request without a URL as the root", () => {
    const writeHead = vi.fn(() => ({ end }));
    const end = vi.fn();
    const handler = createHttpHandler(config);

    void handler({} as never, { writeHead } as never);

    expect(writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
  });
});

describe("request failures", () => {
  it("answers 500 with JSON when the MCP server cannot connect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = createHttpServer(
      createHttpHandler(config, (c) => {
        const mcp = createServer(c);
        mcp.connect = () => Promise.reject(new Error("connect failed"));
        return mcp;
      }),
    );

    const res = await request(failing).post("/mcp").set(MCP_HEADERS).send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error", error_description: "connect failed" });
  });

  it("stringifies non-Error failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = createHttpServer(
      createHttpHandler(config, (c) => {
        const mcp = createServer(c);
        mcp.connect = () => Promise.reject("plain");
        return mcp;
      }),
    );

    const res = await request(failing).post("/mcp").set(MCP_HEADERS).send({});

    expect(res.body).toEqual({ error: "internal_error", error_description: "plain" });
  });

  it("ends the response when the failure happens after headers were sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = createHttpServer(
      createHttpHandler(config, (c) => {
        const mcp = createServer(c);
        mcp.connect = async (transport) => {
          (transport as unknown as { handleRequest: unknown }).handleRequest = async (
            _req: unknown,
            res: { writeHead(status: number): void },
          ) => {
            res.writeHead(200);
            throw new Error("stream broke");
          };
        };
        return mcp;
      }),
    );

    const res = await request(failing).post("/mcp").set(MCP_HEADERS).send({});

    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[staruml-mcp] request error:", expect.any(Error));
  });
});
