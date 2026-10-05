import type { Server } from "node:http";
import request from "supertest";

export const MCP_HEADERS = {
  "Content-Type": "application/json",
  // Streamable HTTP (MCP 2025-03-26) requires clients to accept both representations.
  Accept: "application/json, text/event-stream",
};

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Parses the single JSON-RPC message the SDK writes as an SSE `data:` line. */
export function parseSse(body: string): JsonRpcResponse {
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  if (data.length !== 1) {
    throw new Error(`Expected one SSE data line, got ${data.length}: ${body}`);
  }
  return JSON.parse(data[0]!) as JsonRpcResponse;
}

/** `target` is a listening base URL, or a Server supertest may bind for a single request. */
export async function rpc(
  target: Server | string,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; contentType: string; message: JsonRpcResponse }> {
  const res = await request(target)
    .post("/mcp")
    .set(MCP_HEADERS)
    .send({ jsonrpc: "2.0", id, method, params })
    .buffer(true)
    .parse((stream, done) => {
      let text = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => (text += chunk));
      stream.on("end", () => done(null, text));
    });
  return {
    status: res.status,
    contentType: String(res.headers["content-type"]),
    message: parseSse(res.body as string),
  };
}

export const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "staruml-mcp-tests", version: "0.0.0" },
};
