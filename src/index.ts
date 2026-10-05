import { realpathSync } from "node:fs";
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { diagnose, formatReport, healthy } from "./doctor.js";
import { CatalogState, tierCheck } from "./extension-tools.js";
import { createServer, type ServerConfig } from "./server.js";
import { StarUMLClient } from "./staruml-client.js";
import { DEFAULT_TOOLS, parseToolSelection, type ToolSelection } from "./tiers.js";
import packageJson from "../package.json" with { type: "json" };

const TRANSPORTS = ["stdio", "http"] as const;
type Transport = (typeof TRANSPORTS)[number];

export interface CliOptions {
  transport: Transport;
  port: number;
  /** Address the HTTP transport binds. */
  host: string;
  apiPort: number;
  extPort: number;
  apiHost: string;
  doctor: boolean;
  tools: ToolSelection;
  /** The extension's access token; undefined when none is configured. */
  extToken: string | undefined;
}

/**
 * The HTTP transport has no authentication and every tool drives StarUML, so it listens on
 * loopback unless told otherwise: the MCP spec (2025-06-18, Transports, "Security Warning") asks
 * local servers to bind only to localhost.
 */
export const DEFAULT_HOST = "127.0.0.1";

/** Read when `--tools` is absent, for clients that pass environment but no arguments. */
export const TOOLS_ENV = "STARUML_MCP_TOOLS";
/**
 * Read when `--ext-token` is absent. The variable keeps the token out of the process list, where
 * any local user can read command-line arguments.
 */
export const EXT_TOKEN_ENV = "STARUML_EXT_TOKEN";

export interface Stdio {
  stdin: Readable;
  stdout: Writable;
}

export interface RunningServer {
  /** Port the HTTP transport listens on; undefined for stdio. */
  port: number | undefined;
  close(): Promise<void>;
}

export type McpServerFactory = (config: ServerConfig) => ReturnType<typeof createServer>;

/** `argv` follows `process.argv`: the first two entries are the node binary and the script. */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): CliOptions {
  const program = new Command();
  program
    .name("staruml-mcp")
    .description(packageJson.description)
    .version(packageJson.version)
    .option("-t, --transport <transport>", `MCP transport: ${TRANSPORTS.join("|")}`, "stdio")
    .option("-p, --port <number>", "Port to listen on (HTTP transport only)", "58323")
    .option(
      "--host <address>",
      "Address the HTTP transport binds; anything but loopback exposes StarUML to the network",
      DEFAULT_HOST,
    )
    .option("--api-port <number>", "StarUML built-in API Server port", "58321")
    .option("--ext-port <number>", "staruml-mcp-extension HTTP port (for extended tools)", "58322")
    .option(
      "--api-host <url>",
      "StarUML API Server host (protocol + hostname, without port)",
      "http://localhost",
    )
    .option("--doctor", "Check the StarUML setup, print a report and exit (1 on failure)", false)
    .option(
      "--ext-token <token>",
      `Access token staruml-mcp-extension requires (env ${EXT_TOKEN_ENV}); sent as Authorization: Bearer`,
    )
    .option(
      "--tools <tiers>",
      `Extension tools to list: core, all or comma-separated names (env ${TOOLS_ENV}; default ${DEFAULT_TOOLS})`,
    )
    .parse([...argv]);

  const raw = program.opts<{
    transport: string;
    port: string;
    host: string;
    apiPort: string;
    extPort: string;
    apiHost: string;
    doctor: boolean;
    tools?: string;
    extToken?: string;
  }>();
  const fromEnv = env[TOOLS_ENV];

  return {
    transport: validateTransport(raw.transport),
    // 0 asks the OS for a free port; the tests and scripts/load-test.mjs rely on it.
    port: parsePort(raw.port, "--port", 0),
    host: raw.host,
    apiPort: parsePort(raw.apiPort, "--api-port", 1),
    extPort: parsePort(raw.extPort, "--ext-port", 1),
    apiHost: raw.apiHost,
    doctor: raw.doctor,
    tools:
      raw.tools !== undefined
        ? parseToolSelection(raw.tools)
        : parseToolSelection(fromEnv || DEFAULT_TOOLS, TOOLS_ENV),
    // An empty value means no token, as an empty mcp-ext.token preference does in the extension.
    extToken: (raw.extToken ?? env[EXT_TOKEN_ENV]) || undefined,
  };
}

export async function main(
  argv: readonly string[],
  stdio: Stdio = { stdin: process.stdin, stdout: process.stdout },
): Promise<RunningServer> {
  const options = parseArgs(argv);
  const client = new StarUMLClient({
    host: options.apiHost,
    port: options.apiPort,
    extPort: options.extPort,
    extToken: options.extToken,
  });
  const { checks, catalog } = await diagnose(client);
  const state = new CatalogState(catalog, options.tools);
  const report = formatReport([...checks, tierCheck(state)]);

  if (options.doctor) {
    stdio.stdout.write(`${report}\n`);
    if (!healthy(checks)) process.exitCode = 1;
    return { port: undefined, close: async () => {} };
  }

  // stdout carries the stdio transport, so the startup report goes to stderr.
  console.error(`[staruml-mcp] startup check\n${report}`);
  const serverConfig: ServerConfig = {
    apiHost: options.apiHost,
    apiPort: options.apiPort,
    extPort: options.extPort,
    extToken: options.extToken,
    name: packageJson.name,
    version: packageJson.version,
    catalog: state,
  };

  if (options.transport === "stdio") {
    const mcpServer = createServer(serverConfig);
    await mcpServer.connect(new StdioServerTransport(stdio.stdin, stdio.stdout));
    console.error("[staruml-mcp] stdio transport ready");
    return { port: undefined, close: () => mcpServer.close() };
  }

  const loopbackOnly = isLoopback(options.host);
  if (!loopbackOnly) {
    console.error(
      `[staruml-mcp] warning: --host ${options.host} accepts MCP requests from other machines. ` +
        "The endpoint has no authentication and its tools drive StarUML (save, open, execute any " +
        "command); bind to 127.0.0.1 unless a firewall or proxy restricts who can connect.",
    );
  }
  const handler = createHttpHandler(serverConfig, createServer, { loopbackOnly });
  const httpServer = await listen(createHttpServer(handler), options.port, options.host);
  const { port } = httpServer.address() as AddressInfo;
  console.error(
    `[staruml-mcp] http transport ready on http://${urlHost(options.host)}:${port}/mcp`,
  );
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      }),
  };
}

export interface HttpHandlerOptions {
  /**
   * Refuse requests whose Host or Origin names anything but a loopback address. A web page can
   * point a DNS name of its own at 127.0.0.1 and post to a loopback server from the browser (DNS
   * rebinding); its requests then carry that name in Host and the page's in Origin. The check is
   * the one MCP SDK 1.29's Express-only `localhostHostValidation` makes, plus the Origin check
   * the MCP spec (2025-06-18, Transports) requires. Set when the server binds to loopback.
   */
  loopbackOnly?: boolean;
}

/** `localhost`, 127.0.0.0/8 and ::1, with or without IPv6 brackets or the IPv4-mapped prefix. */
export function isLoopback(host: string): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/^::ffff:/, "");
  return name === "localhost" || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name);
}

/** `host` as it goes into a URL: IPv6 addresses in brackets. */
function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/** Why a request from outside loopback is refused, or undefined when it is not. */
function nonLoopback(headers: { host?: string; origin?: string }): string | undefined {
  const hostname = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  };
  // Node's server answers 400 to an HTTP/1.1 request without Host before calling the handler
  // (http.createServer requireHostHeader, default true since Node 20).
  if (!isLoopback(hostname(`http://${headers.host}`))) {
    return `Host ${JSON.stringify(headers.host)} is not a loopback address`;
  }
  if (headers.origin !== undefined && !isLoopback(hostname(headers.origin))) {
    return `Origin ${JSON.stringify(headers.origin)} is not a loopback address`;
  }
  return undefined;
}

/**
 * Stateless mode: a fresh McpServer and transport per request, so reconnecting clients
 * (Claude Code, Cursor) never inherit state from an earlier session. This is the stateless
 * pattern from the MCP TypeScript SDK README ("Without Session Management").
 */
export function createHttpHandler(
  serverConfig: ServerConfig,
  factory: McpServerFactory = createServer,
  options: HttpHandlerOptions = {},
): RequestListener {
  return async (req, res) => {
    const url = req.url ?? "/";

    const refused = options.loopbackOnly ? nonLoopback(req.headers) : undefined;
    if (refused !== undefined) {
      sendJson(res, 403, {
        error: "forbidden",
        error_description: `${refused}; staruml-mcp listens on loopback only (--host).`,
      });
      return;
    }

    if (url === "/") {
      sendJson(res, 200, {
        name: serverConfig.name,
        version: serverConfig.version,
        mcp_endpoint: "/mcp",
        transport: "streamable-http",
        auth_required: false,
      });
      return;
    }

    // MCP clients probe RFC 8414 / RFC 9728 discovery paths to decide whether to start OAuth.
    // A plaintext 404 makes Claude Code fail while parsing it, so answer with JSON.
    if (url.startsWith("/.well-known/")) {
      sendJson(res, 404, {
        error: "not_found",
        error_description: "staruml-mcp does not require OAuth. Use the /mcp endpoint directly.",
      });
      return;
    }

    if (url !== "/mcp") {
      sendJson(res, 404, {
        error: "not_found",
        error_description: `Unknown path "${url}". Use /mcp for MCP streamable-http transport.`,
      });
      return;
    }

    const mcpServer = factory(serverConfig);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[staruml-mcp] request error:", error);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, {
        error: "internal_error",
        error_description: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * True when this module is the process entrypoint. npm's `bin` and `npx` start the script
 * through a symlink, so the path is resolved before comparing it with `import.meta.url`.
 */
export function isEntrypoint(moduleUrl: string, scriptPath: string | undefined): boolean {
  if (scriptPath === undefined) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(scriptPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

/** Where shutdown signals come from; tests pass an EventEmitter instead of `process`. */
export interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export async function run(argv: readonly string[], signals: SignalSource = process): Promise<void> {
  let server: RunningServer;
  try {
    server = await main(argv);
  } catch (error) {
    console.error("[staruml-mcp] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
    return;
  }
  const shutdown = (): void => {
    console.error("[staruml-mcp] shutting down…");
    void server.close().finally(() => process.exit(0));
  };
  signals.once("SIGINT", shutdown);
  signals.once("SIGTERM", shutdown);
}

function listen(server: HttpServer, port: number, host: string): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function validateTransport(value: string): Transport {
  if ((TRANSPORTS as readonly string[]).includes(value)) {
    return value as Transport;
  }
  throw new Error(`Invalid --transport: "${value}". Must be one of: ${TRANSPORTS.join(", ")}`);
}

function parsePort(value: string, flag: string, min: number): number {
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= min && port <= 65535)) {
    throw new Error(`Invalid ${flag}: "${value}". Must be an integer ${min}–65535.`);
  }
  return port;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  void run(process.argv);
}
