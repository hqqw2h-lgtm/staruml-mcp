/**
 * Stateful Streamable HTTP sessions (MCP 2025-06-18, Transports, "Session Management"): the
 * server answers `initialize` with an `Mcp-Session-Id`, and every later request carrying it reaches
 * the same McpServer. That server remembers the client's capabilities and its read of the viewer
 * resource, so view_diagram can answer with the inline viewer, and it holds the client's GET
 * stream, so `notifications/tools/list_changed` reaches it.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface SessionLimits {
  /** A session with no request in flight for this long is closed. */
  idleTimeoutMs: number;
  /** Live sessions; opening one more closes the least recently used. 0 turns sessions off. */
  maxSessions: number;
}

/**
 * Thirty minutes covers a pause between modelling steps; a client whose session expired gets 404
 * and starts a new one, as the spec asks of it. A core-tier McpServer holds about 160 KB of heap
 * (Node 22.23, 64 servers measured with --expose-gc), so 64 sessions cost about 10 MB and leave
 * room for clients that reconnect without sending DELETE.
 */
export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  idleTimeoutMs: 30 * 60_000,
  maxSessions: 64,
};

/** The sweep runs this often at most, so a short timeout in tests still expires promptly. */
const MAX_SWEEP_INTERVAL_MS = 60_000;

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  /** Requests whose response is still open; a client's GET stream keeps its session alive. */
  inFlight: number;
}

export class SessionStore {
  /** In least-recently-used order: a request moves its session to the end. */
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(
    readonly limits: SessionLimits = DEFAULT_SESSION_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    if (this.enabled) {
      const every = Math.min(limits.idleTimeoutMs, MAX_SWEEP_INTERVAL_MS);
      this.timer = setInterval(() => void this.sweep(), every).unref();
    }
  }

  get enabled(): boolean {
    return this.limits.maxSessions > 0;
  }

  get size(): number {
    return this.sessions.size;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Answers an `initialize` request with a new session around `server`. The session is kept only
   * once the SDK accepted the request and generated its id; a refused initialize closes `server`.
   */
  async open(
    server: McpServer,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    while (this.sessions.size >= this.limits.maxSessions) {
      const [oldest] = this.sessions;
      await this.end(...oldest!);
    }
    const session: Session = {
      server,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => void this.sessions.set(id, session),
      }),
      lastSeen: this.now(),
      inFlight: 0,
    };
    // Set before connect, which chains the server's own handler after it. Runs for DELETE, for
    // eviction and for the idle sweep alike.
    session.transport.onclose = () => {
      const id = session.transport.sessionId;
      if (id !== undefined && this.sessions.get(id) === session) this.sessions.delete(id);
    };
    await server.connect(session.transport);
    await this.serve(session, req, res, body);
    if (session.transport.sessionId === undefined) await server.close();
  }

  /**
   * Answers a request for session `id`; false when there is no such session. `body` is the
   * parsed POST body, undefined for GET and DELETE.
   */
  async handle(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<boolean> {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    this.sessions.delete(id);
    this.sessions.set(id, session);
    await this.serve(session, req, res, body);
    return true;
  }

  private async serve(
    session: Session,
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<void> {
    session.inFlight++;
    session.lastSeen = this.now();
    res.once("close", () => {
      session.inFlight--;
      session.lastSeen = this.now();
    });
    await session.transport.handleRequest(req, res, body);
  }

  /** Closes the sessions idle for longer than the timeout; returns how many. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.limits.idleTimeoutMs;
    const idle = [...this.sessions].filter(([, s]) => s.inFlight === 0 && s.lastSeen < cutoff);
    await Promise.all(idle.map((entry) => this.end(...entry)));
    return idle.length;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.sessions].map((entry) => this.end(...entry)));
  }

  /** Closing the transport closes the server too (Protocol.connect chains its onclose). */
  private async end(id: string, session: Session): Promise<void> {
    this.sessions.delete(id);
    await session.transport.close();
  }
}
