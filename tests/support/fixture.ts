import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/** Extension 0.3.0's answer to a request without the right bearer token (src/http-server.ts). */
const UNAUTHORIZED = {
  success: false,
  code: "UNAUTHORIZED",
  error: "Missing or wrong bearer token",
};

/**
 * Stand-in for StarUML's built-in API (58321) or staruml-mcp-extension (58322). Routes reply
 * with a fixed status and body; unknown POST paths get the extension's 404 envelope.
 */
export class UpstreamFixture {
  readonly requests: RecordedRequest[] = [];
  /** The Authorization header of each request, in the order of `requests`. */
  readonly authorizations: (string | undefined)[] = [];
  /** When set, requests without `Authorization: Bearer <token>` get the extension's 401. */
  token: string | undefined;
  private readonly routes = new Map<string, Reply[]>();
  /** Body of `GET /`; StarUML answers plain text, the extension a JSON banner. */
  banner: unknown = "Hello from fixture";
  private server: Server | undefined;
  port = 0;

  /** Each request to `path` takes the next reply; the last one repeats. */
  reply(path: string, ...replies: [Reply, ...Reply[]]): this {
    this.routes.set(path, replies);
    return this;
  }

  reset(): void {
    this.routes.clear();
    this.requests.length = 0;
    this.authorizations.length = 0;
    this.token = undefined;
  }

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const path = req.url!;
      const body = await readJson(req);
      this.requests.push({ method: req.method!, path, body });
      this.authorizations.push(req.headers.authorization);
      if (this.token !== undefined && req.headers.authorization !== `Bearer ${this.token}`) {
        res
          .writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer realm="staruml"',
          })
          .end(JSON.stringify(UNAUTHORIZED));
        return;
      }
      if (req.method === "GET" && path === "/") {
        const text = typeof this.banner === "string" ? this.banner : JSON.stringify(this.banner);
        res.writeHead(200, { "Content-Type": "text/plain" }).end(text);
        return;
      }
      const queue = this.routes.get(path);
      const reply = (queue && queue.length > 1 ? queue.shift() : queue?.[0]) ?? {
        status: 404,
        body: { success: false, error: `No handler for ${path}` },
      };
      const payload = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      res
        .writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers })
        .end(payload);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return text === "" ? undefined : JSON.parse(text);
}

/** A port that refuses connections: bound once by the OS, then released. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
