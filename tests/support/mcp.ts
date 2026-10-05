import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type ServerConfig } from "../../src/server.js";

export interface ConnectedClient {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** What a client that renders MCP Apps declares at initialize (ext-apps `getUiCapability`). */
export const UI_CAPABILITIES: ClientCapabilities = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
};

export async function connect(
  config: ServerConfig,
  capabilities: ClientCapabilities = {},
): Promise<ConnectedClient> {
  const server = createServer(config);
  const client = new Client({ name: "staruml-mcp-tests", version: "0.0.0" }, { capabilities });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    call: async (name, args = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}
