import { z } from "zod";
import { ErrorCode, EXTENSION_REPOSITORY, StarUMLApiError, type Upstream } from "./errors.js";

export { ErrorCode, StarUMLApiError } from "./errors.js";

const DEFAULT_HOST = "http://localhost";
const DEFAULT_API_PORT = 58321;
const DEFAULT_EXT_PORT = 58322;
/** Both servers answer on loopback in under 50 ms when up (measured on 7.1.1). */
const PROBE_TIMEOUT_MS = 2_000;

/** Extension 0.3.0's code for a path it has no handler for (src/http-server.ts). */
const UNKNOWN_ENDPOINT = "UNKNOWN_ENDPOINT";

/**
 * Where the extension's settings live in StarUML: its preference panel ("id": "mcp-ext", "name":
 * "MCP Extension" in preferences/preference.json) and its Tools menu (menus/menu.json).
 */
const PREFERENCES = "Preferences > MCP Extension";
export const TOKEN_HELP =
  "In StarUML, Tools > MCP Extension > Server Info says whether a token is required and Generate Access Token... creates one; " +
  `pass it with --ext-token <token> or STARUML_EXT_TOKEN. To turn the check off, clear ${PREFERENCES} > Access Token.`;

/** The refusals of extension 0.3.0's request checks (src/http-server.ts), by code. */
const REFUSAL_STATUS: Record<number, string> = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN_ORIGIN",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
  504: "TIMEOUT",
};

const StarUMLResponseSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});

type StarUMLResponse = z.infer<typeof StarUMLResponseSchema>;

export interface StarUMLClientOptions {
  host?: string;
  port?: number;
  extPort?: number;
  /**
   * Sent as `Authorization: Bearer` with every extension request, `GET /` included, for an
   * extension whose `mcp-ext.token` preference is set. Never sent to the built-in API.
   */
  extToken?: string;
}

export class StarUMLClient {
  private readonly host: string;
  private readonly baseUrl: string;
  private readonly extUrl: string;
  private readonly extHeaders: Record<string, string>;
  readonly hasExtToken: boolean;

  constructor(options: StarUMLClientOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    const port = options.port ?? DEFAULT_API_PORT;
    const extPort = options.extPort ?? DEFAULT_EXT_PORT;
    this.baseUrl = `${this.host}:${port}`;
    this.extUrl = `${this.host}:${extPort}`;
    this.hasExtToken = options.extToken !== undefined && options.extToken !== "";
    this.extHeaders = this.hasExtToken ? { Authorization: `Bearer ${options.extToken}` } : {};
  }

  // === Built-in StarUML API (port 58321) ===

  async generateDiagram(code: string): Promise<void> {
    await this.callBase("/generate_diagram", { code });
  }

  async getAllDiagramsInfo(): Promise<unknown> {
    return this.callBase("/get_all_diagrams_info", {});
  }

  async getCurrentDiagramInfo(): Promise<unknown> {
    return this.callBase("/get_current_diagram_info", {});
  }

  async getDiagramImageById(diagramId: string): Promise<string> {
    const result = await this.callBase("/get_diagram_image_by_id", { diagramId });
    if (typeof result !== "string") {
      throw new StarUMLApiError(`Expected a base64 image string, got ${typeof result}`, {
        code: ErrorCode.InvalidResponse,
        slug: "/get_diagram_image_by_id",
        upstream: "builtin",
      });
    }
    return result;
  }

  /** True when the built-in API server answers `GET /`. */
  async ping(): Promise<boolean> {
    return (await this.probe(this.baseUrl, {}))?.ok === true;
  }

  get builtinUrl(): string {
    return this.baseUrl;
  }

  get extensionUrl(): string {
    return this.extUrl;
  }

  // === Extension API (port 58322, requires staruml-mcp-extension installed) ===

  /**
   * The extension's `GET /` banner, `{name, version, endpoints}`; undefined when nothing answers
   * or the answer is another error. Versions before 0.3.0 have no `/introspect`, so this is how
   * the doctor tells them apart. Throws {@link StarUMLApiError} when the extension refuses the
   * request (401 for the access token, 403 for an Origin): it is running, but every call would fail.
   */
  async extensionBanner(): Promise<unknown> {
    const res = await this.probe(this.extUrl, this.extHeaders);
    if (res === undefined) return undefined;
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw this.httpError("extension", "/", res, parseEnvelope(text));
    }
    if (!res.ok) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  /** Versions and the endpoint manifest only; the metamodel section alone is ~250 KB. */
  async introspectManifest(): Promise<unknown> {
    return this.callExt("/introspect", { include: ["endpoints"] });
  }

  /** POSTs `body` to an extension endpoint named by the manifest. */
  async callExtension(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.callExt(path, body);
  }

  // === Internal ===

  /**
   * GET `url` with a deadline: a port held by a hung process would otherwise stall the startup
   * check until the OS gives up on the connection. Undefined when nothing answers in time.
   */
  private async probe(url: string, headers: Record<string, string>): Promise<Response | undefined> {
    try {
      return await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }
  }

  private callBase(slug: string, body: Record<string, unknown>): Promise<unknown> {
    return this.post("builtin", slug, body);
  }

  private callExt(slug: string, body: Record<string, unknown>): Promise<unknown> {
    return this.post("extension", slug, body);
  }

  private async post(
    upstream: Upstream,
    slug: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const baseUrl = upstream === "builtin" ? this.baseUrl : this.extUrl;
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${slug}`, {
        method: "POST",
        // Extension 0.3.0 answers 415 to a POST without this type.
        headers: {
          "Content-Type": "application/json",
          ...(upstream === "extension" ? this.extHeaders : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw await this.unreachable(upstream, slug, cause);
    }

    const envelope = parseEnvelope(await res.text());

    if (!res.ok) {
      throw this.httpError(upstream, slug, res, envelope);
    }
    if (envelope === undefined) {
      throw new StarUMLApiError(
        `${baseUrl}${slug} did not return a {success, data} JSON envelope`,
        {
          code: ErrorCode.InvalidResponse,
          slug,
          upstream,
          status: res.status,
          hint: `Check that ${baseUrl} is ${describe(upstream)} and not another service on that port.`,
        },
      );
    }
    if (!envelope.success) {
      throw new StarUMLApiError(
        envelope.error ?? `${baseUrl}${slug} reported failure without a message`,
        {
          code: envelope.code ?? ErrorCode.RequestRejected,
          slug,
          upstream,
          status: res.status,
          ...(envelope.details === undefined ? {} : { details: envelope.details }),
        },
      );
    }
    return envelope.data;
  }

  private async unreachable(
    upstream: Upstream,
    slug: string,
    cause: unknown,
  ): Promise<StarUMLApiError> {
    const startStarUML = `Start StarUML 7.0.0+ with its API server enabled ("apiServer": true in StarUML's settings.json; port "apiServerPort", default 58321), or pass --api-host/--api-port if it listens elsewhere.`;
    if (upstream === "builtin") {
      return new StarUMLApiError(`Cannot reach the StarUML API server at ${this.baseUrl}`, {
        code: ErrorCode.StarUMLUnreachable,
        slug,
        upstream,
        hint: startStarUML,
        cause,
      });
    }
    // Probing the built-in port tells "StarUML is closed" apart from "the extension is
    // missing": both look identical from the extension port alone.
    if (!(await this.ping())) {
      return new StarUMLApiError(
        `Cannot reach StarUML: neither ${this.baseUrl} nor ${this.extUrl} answers`,
        { code: ErrorCode.StarUMLUnreachable, slug, upstream, hint: startStarUML, cause },
      );
    }
    return new StarUMLApiError(`StarUML is running but nothing answers at ${this.extUrl}`, {
      code: ErrorCode.ExtensionUnreachable,
      slug,
      upstream,
      hint: `Install staruml-mcp-extension (Tools > Extension Manager > Install From Url: ${EXTENSION_REPOSITORY}) and restart StarUML, or pass --ext-port if it listens on another port.`,
      cause,
    });
  }

  private httpError(
    upstream: Upstream,
    slug: string,
    res: Response,
    envelope: StarUMLResponse | undefined,
  ): StarUMLApiError {
    const message = envelope?.error ?? `HTTP ${res.status} ${res.statusText}`.trimEnd();
    const options = {
      slug,
      upstream,
      status: res.status,
      ...(envelope?.details === undefined ? {} : { details: envelope.details }),
    };
    // Extension 0.3.0 names a missing endpoint UNKNOWN_ENDPOINT; older ones and StarUML answer a
    // bare 404. Either way the installed version does not match what this server expects.
    const missing =
      envelope?.code === UNKNOWN_ENDPOINT || (envelope?.code === undefined && res.status === 404);
    if (missing) {
      return new StarUMLApiError(message, {
        ...options,
        code: envelope?.code ?? ErrorCode.EndpointNotFound,
        hint:
          upstream === "builtin"
            ? `This StarUML build has no ${slug} API endpoint; it needs StarUML 7.0.0+.`
            : `The installed staruml-mcp-extension does not provide ${slug}, so its version does not match this server. GET ${this.extUrl}/ lists the endpoints it supports; upgrade from ${EXTENSION_REPOSITORY}.`,
      });
    }
    const hint =
      upstream === "extension"
        ? this.refusalHint(envelope?.code ?? REFUSAL_STATUS[res.status], slug, res)
        : undefined;
    return new StarUMLApiError(message, {
      ...options,
      code:
        envelope?.code ?? (res.status < 500 ? ErrorCode.RequestRejected : ErrorCode.UpstreamError),
      ...(hint === undefined ? {} : { hint }),
    });
  }

  /** What to do about a refusal by the extension's request checks or limits. */
  private refusalHint(code: string | undefined, slug: string, res: Response): string | undefined {
    switch (code) {
      case "UNAUTHORIZED":
        return this.hasExtToken
          ? `The extension rejected the access token this server sent. ${TOKEN_HELP}`
          : `The extension requires an access token. ${TOKEN_HELP}`;
      case "FORBIDDEN_ORIGIN":
        return `The extension refuses requests whose Origin header is not in ${PREFERENCES} > Allowed Origins. This server sends none, so a proxy or browser between it and StarUML added one.`;
      case "PAYLOAD_TOO_LARGE":
        return `The request exceeds ${PREFERENCES} > Max Request Body (KiB) or, for /batch, Max Batch Ops; split it or raise the limit.`;
      case "UNSUPPORTED_MEDIA_TYPE":
        return "The extension takes only Content-Type: application/json, which this server sends; check for a proxy rewriting requests.";
      case "RATE_LIMITED": {
        const after = res.headers.get("Retry-After");
        return `${after === null ? "Retry later" : `Retry in ${after} s`}; ${PREFERENCES} > Commands per Minute limits ${slug} for all clients together.`;
      }
      case "DIALOG_REQUIRED":
        return dialogHint(slug);
      case "TIMEOUT":
        return `The extension stopped waiting after ${PREFERENCES} > Request Timeout (s), but StarUML may still finish the work; check its effect before retrying, or raise the limit.`;
      default:
        return undefined;
    }
  }
}

/**
 * Extension 0.3.0 refuses what would open a modal or native dialog (src/dialog-guard.ts and
 * refuseDialog in src/handlers/commands.ts there): nobody may be at StarUML to close it, and a
 * native file dialog blocks the renderer that serves the API.
 */
function dialogHint(slug: string): string {
  const lead = "StarUML would have opened a dialog and waited for someone to close it.";
  switch (slug) {
    case "/execute_command":
      return `${lead} describe_commands({ids: [<id>]}) names the arguments that avoid it; or use an endpoint instead (save_project, open_project, export_diagram, export_pdf, generate_code).`;
    case "/generate_code":
    case "/reverse_code":
      return `${lead} The generator asked for something its options did not settle; list_code_generators shows the options each language takes.`;
    default:
      return `${lead} Pass the arguments that avoid it, or use a dedicated endpoint.`;
  }
}

function parseEnvelope(text: string): StarUMLResponse | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = StarUMLResponseSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function describe(upstream: Upstream): string {
  return upstream === "builtin" ? "the StarUML API server" : "staruml-mcp-extension";
}
