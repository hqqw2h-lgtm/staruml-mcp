import { z } from "zod";
import { ErrorCode, EXTENSION_REPOSITORY, StarUMLApiError, type Upstream } from "./errors.js";

export { ErrorCode, StarUMLApiError } from "./errors.js";

const DEFAULT_HOST = "http://localhost";
const DEFAULT_API_PORT = 58321;
const DEFAULT_EXT_PORT = 58322;

const StarUMLResponseSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

type StarUMLResponse = z.infer<typeof StarUMLResponseSchema>;

export interface StarUMLClientOptions {
  host?: string;
  port?: number;
  extPort?: number;
}

export class StarUMLClient {
  private readonly host: string;
  private readonly baseUrl: string;
  private readonly extUrl: string;

  constructor(options: StarUMLClientOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    const port = options.port ?? DEFAULT_API_PORT;
    const extPort = options.extPort ?? DEFAULT_EXT_PORT;
    this.baseUrl = `${this.host}:${port}`;
    this.extUrl = `${this.host}:${extPort}`;
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

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  // === Extension API (port 58322, requires staruml-mcp-extension installed) ===

  async pingExtension(): Promise<boolean> {
    try {
      const res = await fetch(this.extUrl, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getAllCommands(): Promise<unknown> {
    return this.callExt("/get_all_commands", {});
  }

  async executeCommand(id: string, args?: unknown[]): Promise<unknown> {
    return this.callExt("/execute_command", { id, args: args ?? [] });
  }

  async getProjectInfo(): Promise<unknown> {
    return this.callExt("/get_project_info", {});
  }

  async saveProject(filename?: string): Promise<unknown> {
    return this.callExt("/save_project", filename ? { filename } : {});
  }

  async saveProjectAs(filename: string): Promise<unknown> {
    return this.callExt("/save_project_as", { filename });
  }

  async newProject(): Promise<unknown> {
    return this.callExt("/new_project", {});
  }

  async openProject(filename: string): Promise<unknown> {
    return this.callExt("/open_project", { filename });
  }

  async getElementById(id: string): Promise<unknown> {
    return this.callExt("/get_element_by_id", { id });
  }

  async findElements(filter: { type?: string; name?: string } = {}): Promise<unknown> {
    return this.callExt("/find_elements", filter);
  }

  async createElement(input: { type: string; parentId: string; name?: string }): Promise<unknown> {
    return this.callExt("/create_element", input);
  }

  async createElementWithView(input: {
    type: string;
    parentId: string;
    diagramId: string;
    name?: string;
    x?: number;
    y?: number;
    x2?: number;
    y2?: number;
  }): Promise<unknown> {
    return this.callExt("/create_element_with_view", input);
  }

  async createEdgeWithView(input: {
    type: string;
    parentId: string;
    diagramId: string;
    tailViewId: string;
    headViewId: string;
    name?: string;
    x?: number;
    y?: number;
    x2?: number;
    y2?: number;
  }): Promise<unknown> {
    return this.callExt("/create_edge_with_view", input);
  }

  async updateElement(input: { id: string; field: string; value: unknown }): Promise<unknown> {
    return this.callExt("/update_element", input);
  }

  async deleteElement(id: string): Promise<unknown> {
    return this.callExt("/delete_element", { id });
  }

  async createDiagram(input: { type: string; parentId: string; name?: string }): Promise<unknown> {
    return this.callExt("/create_diagram", input);
  }

  async switchDiagram(id: string): Promise<unknown> {
    return this.callExt("/switch_diagram", { id });
  }

  async closeDiagram(id: string): Promise<unknown> {
    return this.callExt("/close_diagram", { id });
  }

  // === Internal ===

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
        headers: { "Content-Type": "application/json" },
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
    const options = { slug, upstream, status: res.status };
    if (envelope?.code !== undefined) {
      return new StarUMLApiError(message, { ...options, code: envelope.code });
    }
    if (res.status === 404) {
      return new StarUMLApiError(message, {
        ...options,
        code: ErrorCode.EndpointNotFound,
        hint:
          upstream === "builtin"
            ? `This StarUML build has no ${slug} API endpoint; it needs StarUML 7.0.0+.`
            : `The installed staruml-mcp-extension does not provide ${slug}, so its version does not match this server. GET ${this.extUrl}/ lists the endpoints it supports; upgrade from ${EXTENSION_REPOSITORY}.`,
      });
    }
    return new StarUMLApiError(message, {
      ...options,
      code: res.status < 500 ? ErrorCode.RequestRejected : ErrorCode.UpstreamError,
    });
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
