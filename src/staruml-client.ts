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

/** Ends the unreachable hints; the server instructions used to say it with every turn. */
const DOCTOR = "The doctor tool checks the whole setup.";

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
    const startStarUML = `Start StarUML 7.0.0+ with its API server enabled ("apiServer": true in StarUML's settings.json; port "apiServerPort", default 58321), or pass --api-host/--api-port if it listens elsewhere. ${DOCTOR}`;
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
      hint: `Install staruml-mcp-extension (Tools > Extension Manager > Install From Url: ${EXTENSION_REPOSITORY}) and restart StarUML, or pass --ext-port if it listens on another port. ${DOCTOR}`,
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
        ? this.refusalHint(
            envelope?.code ?? REFUSAL_STATUS[res.status],
            slug,
            res,
            envelope?.details,
          )
        : undefined;
    return new StarUMLApiError(message, {
      ...options,
      code:
        envelope?.code ?? (res.status < 500 ? ErrorCode.RequestRejected : ErrorCode.UpstreamError),
      ...(hint === undefined ? {} : { hint }),
    });
  }

  /** What to do about a refusal by the extension's request checks, limits or references. */
  private refusalHint(
    code: string | undefined,
    slug: string,
    res: Response,
    details: unknown,
  ): string | undefined {
    switch (code) {
      case "AMBIGUOUS_REF":
        return ambiguousHint(details);
      case "DUPLICATE_NAME":
        return duplicateHint(slug, details);
      case "SNAPSHOT_STALE":
        return "The undo history no longer reaches that snapshot (it was undone past, cut by StarUML's history limit, or another project is open); take a new one with snapshot.";
      case "UNSUPPORTED_SYNTAX":
        return 'The message names the construct and its line, which StarUML cannot draw; leave it out or rewrite it, or build the diagram from a spec (describe_endpoints({names: ["build_diagram"]})).';
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
      case "STYLE_LOCKED":
        return styleLockedHint(details);
      case "SAVE_BLOCKED":
        return saveBlockedHint(details);
      case "TEMPLATE_ONLY":
        return templateOnlyHint(slug, details);
      case "VIEWPOINT_REQUIRED":
        return VIEWPOINT_REQUIRED_HINT;
      case "VIEWPOINT_MISMATCH":
        return viewpointMismatchHint(details);
      case "DIAGRAM_DERIVED":
        return derivedHint(details);
      case "TIMEOUT":
        return `The extension stopped waiting after ${PREFERENCES} > Request Timeout (s), but StarUML may still finish the work; check its effect before retrying, or raise the limit.`;
      default:
        return undefined;
    }
  }
}

/** Candidates the AMBIGUOUS_REF hint names; details carries up to 20 (extension src/refs.ts). */
const MAX_HINTED_CANDIDATES = 5;

interface Candidate {
  _id?: unknown;
  path?: unknown;
}

/**
 * The candidates of an AMBIGUOUS_REF (`details.candidates`, each `{_id, _type, path}`) as
 * references to pass instead: the path, which reads better and is what the caller tried to
 * write, or the id where a path cannot name the element apart from the others.
 */
function ambiguousHint(details: unknown): string {
  const lead = "Pass one of these instead, or a longer path";
  const raw = (details as { candidates?: unknown } | null)?.candidates;
  const candidates = Array.isArray(raw) ? (raw as Candidate[]) : [];
  if (candidates.length === 0) return `${lead}; find_elements lists elements by name.`;
  const paths = candidates.map((c) => c.path);
  const named = candidates.slice(0, MAX_HINTED_CANDIDATES).map((c) => {
    const unique = typeof c.path === "string" && paths.filter((p) => p === c.path).length === 1;
    return unique ? String(c.path) : String(c._id);
  });
  const more = candidates.length - named.length;
  return `${lead}: ${named.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}.`;
}

/**
 * DUPLICATE_NAME: a new element named like a sibling of its kind (`details.existing`, a summary
 * with its path), which a path could not tell apart. Reusing the sibling is what was usually
 * meant; build_diagram does so for names it finds once in the project.
 */
function duplicateHint(slug: string, details: unknown): string {
  const existing = (details as { existing?: { path?: unknown; _id?: unknown } } | null)?.existing;
  const name = existing?.path ?? existing?._id;
  const which =
    typeof name === "string" ? `${name} exists already` : "A sibling of that kind has the name";
  const reuse =
    slug === "/build_diagram"
      ? "keep reuse on (the default) to show it again"
      : "refer to it by its path";
  return `${which}: ${reuse}, rename the new one, or pass allowDuplicateNames: true to add a second.`;
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

/**
 * STYLE_LOCKED (403, extension src/style/guard.ts): the project's style profile is strict, so
 * the endpoints that place, size or colour views by hand refuse unless told `override: true`.
 * `details.profile` names the profile. The remedies are the ones strict mode leaves open; the
 * override is last because it is what strict mode exists to stop.
 */
function styleLockedHint(details: unknown): string {
  const profile = (details as { profile?: unknown } | null)?.profile;
  const which =
    typeof profile === "string" ? `The style profile '${profile}'` : "The style profile";
  return (
    `${which} is strict: views are placed and styled by the profile and the quality loop, not by hand. ` +
    "Rearrange with improve_diagram, restyle with apply_style_profile, or rebuild with build_diagram or derive_diagrams; " +
    "pass override: true only when the user asked for this exact change, or turn strict mode off with set_style_profile({patch: {strict: false}})."
  );
}

/** Lint errors a SAVE_BLOCKED hint names; details carries up to 20 `{rule, message, path}`. */
const MAX_HINTED_ERRORS = 3;

/**
 * SAVE_BLOCKED (409): the profile's `blockSaveOnErrors` refuses /save_project and /export_*
 * while /uml_lint or /model_lint report errors (`details.count`, `details.findings`).
 */
function saveBlockedHint(details: unknown): string {
  const { count, findings } = (details ?? {}) as { count?: unknown; findings?: unknown };
  const listed = Array.isArray(findings)
    ? (findings as { rule?: unknown; path?: unknown }[])
        .slice(0, MAX_HINTED_ERRORS)
        .map((f) => `${String(f.rule)}${typeof f.path === "string" ? ` ${f.path}` : ""}`)
    : [];
  const errors =
    typeof count === "number" ? `${count} lint error${count === 1 ? "" : "s"}` : "Lint errors";
  const first =
    listed.length > 0
      ? ` (${listed.join(", ")}${Number(count) > listed.length ? ", ..." : ""})`
      : "";
  return (
    `${errors}${first} ${count === 1 ? "blocks" : "block"} saving and exporting under the style profile's blockSaveOnErrors. ` +
    "Run uml_lint and model_lint, fix what they report, then retry; pass override: true to save or export anyway."
  );
}

/**
 * TEMPLATE_ONLY (403, extension src/handlers/build.ts and oo.ts): under a strict profile a
 * diagram is drawn through a template from content alone; `details.fields` names what was
 * refused (layout, direction, autoLayout, showNamespace, spec.styles, or derive_diagrams'
 * policy) and is empty when build_diagram was given no template.
 */
function templateOnlyHint(slug: string, details: unknown): string {
  const raw = (details as { fields?: unknown } | null)?.fields;
  const fields = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
  const drop = fields.length > 0 ? `Leave out ${fields.join(", ")}: ` : "";
  return slug === "/derive_diagrams"
    ? `${drop}what a derived diagram shows and how it looks is its template's; pass template or viewpoints to choose the diagrams.`
    : `${drop}a strict project builds a diagram from a template name (list_templates) and content (spec, mermaid or text) only, or asks request_diagram for the view by intent.`;
}

/** VIEWPOINT_REQUIRED (403, extension src/style/guard.ts): /create_diagram under a strict profile. */
const VIEWPOINT_REQUIRED_HINT =
  "Every diagram of a strict project declares its viewpoint: request_diagram({intent, scope}) picks and draws the view, derive_diagrams draws every view the model implies, build_diagram({template, spec}) draws one from content.";

/** Alternatives a VIEWPOINT_MISMATCH hint names; the extension offers up to about ten. */
const MAX_HINTED_ALTERNATIVES = 4;

interface Alternative {
  viewpoint?: unknown;
  kind?: unknown;
  why?: unknown;
  template?: unknown;
  candidates?: unknown;
}

/**
 * VIEWPOINT_MISMATCH (422, extension src/handlers/viewpoints.ts and build.ts): the view asked for
 * does not fit the scope, the audience, the content or the template, and `details.alternatives`
 * lists the views that do, each with why and, from /request_diagram, the scopes that have one
 * (`candidates`). The hint names them so the next call can pick one without reading `details`.
 */
function viewpointMismatchHint(details: unknown): string {
  const raw = (details as { alternatives?: unknown } | null)?.alternatives;
  const alternatives = Array.isArray(raw) ? (raw as Alternative[]) : [];
  if (alternatives.length === 0) {
    return "Nothing in that scope has such a view; list_viewpoints names the questions each view answers, and a narrower or wider scope may have one.";
  }
  const named = alternatives.slice(0, MAX_HINTED_ALTERNATIVES).map((a) => {
    const template = typeof a.template === "string" ? `, template ${a.template}` : "";
    const scopes = Array.isArray(a.candidates) && a.candidates.length > 0;
    const where = scopes ? ` in ${(a.candidates as unknown[]).slice(0, 3).join(" or ")}` : "";
    return `${String(a.viewpoint)} as ${String(a.kind)}${template}${where} (${String(a.why)})`;
  });
  const more = alternatives.length - named.length;
  return `Views that fit: ${named.join("; ")}${more > 0 ? `; and ${more} more in details.alternatives` : ""}. Ask request_diagram with an intent for one of them and its scope.`;
}

/**
 * DIAGRAM_DERIVED (409, extension src/templates/lock.ts): the diagram belongs to
 * /derive_diagrams (`details.path`, `details.template`), so edits to it would be lost on the next
 * derivation and are refused. The model is what to change.
 */
function derivedHint(details: unknown): string {
  const path = (details as { path?: unknown } | null)?.path;
  const which = typeof path === "string" ? path : "The diagram";
  return `${which} is drawn from the model: change the model (build_model with upsert, or the model endpoints), then derive_diagrams or request_diagram draws it again.`;
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
