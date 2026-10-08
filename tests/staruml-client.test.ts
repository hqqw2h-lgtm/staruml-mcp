import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ErrorCode, StarUMLApiError, StarUMLClient } from "../src/staruml-client.js";

describe("StarUMLClient", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockJsonResponse(body: unknown, status = 200, statusText?: string): void {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        statusText,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  function mockTextResponse(body: string, status: number, statusText?: string): void {
    fetchSpy.mockResolvedValueOnce(new Response(body, { status, statusText }));
  }

  async function caught(promise: Promise<unknown>): Promise<StarUMLApiError> {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StarUMLApiError);
    return error as StarUMLApiError;
  }

  function lastRequest(): { url: string; body: unknown } {
    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    return { url: String(url), body: JSON.parse(String(init?.body)) };
  }

  describe("constructor", () => {
    it("uses default host and ports when no options given", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: true });
      mockJsonResponse({ success: true });
      await client.generateDiagram("flowchart LR\n  A --> B");
      expect(lastRequest().url).toBe("http://localhost:58321/generate_diagram");
      await client.callExtension("/get_project_info", {});
      expect(lastRequest().url).toBe("http://localhost:58322/get_project_info");
    });

    it("uses custom host and ports when provided", async () => {
      const client = new StarUMLClient({ host: "http://example.com", port: 1234, extPort: 4321 });
      mockJsonResponse({ success: true });
      mockJsonResponse({ success: true });
      await client.generateDiagram("x");
      expect(lastRequest().url).toBe("http://example.com:1234/generate_diagram");
      await client.callExtension("/new_project", {});
      expect(lastRequest().url).toBe("http://example.com:4321/new_project");
      expect(client.builtinUrl).toBe("http://example.com:1234");
      expect(client.extensionUrl).toBe("http://example.com:4321");
    });
  });

  describe("request shape", () => {
    it("sends POST with a JSON body", async () => {
      const client = new StarUMLClient();
      const code = "erDiagram\n  USER ||--o{ ORDER : places";
      mockJsonResponse({ success: true });

      await client.generateDiagram(code);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(init?.body as string)).toEqual({ code });
    });

    const cases: [string, (c: StarUMLClient) => Promise<unknown>, string, unknown][] = [
      ["getAllDiagramsInfo", (c) => c.getAllDiagramsInfo(), "/get_all_diagrams_info", {}],
      ["getCurrentDiagramInfo", (c) => c.getCurrentDiagramInfo(), "/get_current_diagram_info", {}],
      [
        "callExtension",
        (c) => c.callExtension("/find_elements", { type: "UMLClass", limit: 5 }),
        "/find_elements",
        { type: "UMLClass", limit: 5 },
      ],
      [
        "introspectManifest",
        (c) => c.introspectManifest(),
        "/introspect",
        { include: ["endpoints"] },
      ],
    ];

    it.each(cases)(
      "%s posts to the right endpoint and returns data",
      async (_, call, slug, body) => {
        const client = new StarUMLClient();
        mockJsonResponse({ success: true, data: { ok: slug } });

        await expect(call(client)).resolves.toEqual({ ok: slug });

        const request = lastRequest();
        expect(new URL(request.url).pathname).toBe(slug);
        expect(request.body).toEqual(body);
      },
    );
  });

  describe("getCurrentDiagramInfo", () => {
    it("returns undefined when data is absent", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: true });

      await expect(client.getCurrentDiagramInfo()).resolves.toBeUndefined();
    });
  });

  describe("getDiagramImageById", () => {
    it("returns the image string from data", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: true, data: "iVBORw0KGgo=" });

      await expect(client.getDiagramImageById("d1")).resolves.toBe("iVBORw0KGgo=");
      expect(lastRequest().body).toEqual({ diagramId: "d1" });
    });

    it("rejects with INVALID_RESPONSE when data is not a string", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: true, data: { wrong: "shape" } });

      const error = await caught(client.getDiagramImageById("d1"));
      expect(error.code).toBe(ErrorCode.InvalidResponse);
      expect(error.message).toBe("Expected a base64 image string, got object");
      expect(error.upstream).toBe("builtin");
    });
  });

  describe("connectivity failures", () => {
    it("reports STARUML_UNREACHABLE for the built-in API without probing again", async () => {
      const client = new StarUMLClient();
      const cause = new TypeError("fetch failed");
      fetchSpy.mockRejectedValueOnce(cause);

      const error = await caught(client.generateDiagram("x"));

      expect(error).toMatchObject({
        code: ErrorCode.StarUMLUnreachable,
        slug: "/generate_diagram",
        upstream: "builtin",
        status: undefined,
        cause,
      });
      expect(error.message).toBe("Cannot reach the StarUML API server at http://localhost:58321");
      expect(error.hint).toContain('"apiServer": true');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("reports STARUML_UNREACHABLE for an extension call when StarUML itself is down", async () => {
      const client = new StarUMLClient();
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

      const error = await caught(client.callExtension("/get_project_info", {}));

      expect(error.code).toBe(ErrorCode.StarUMLUnreachable);
      expect(error.upstream).toBe("extension");
      expect(error.message).toContain("neither http://localhost:58321 nor http://localhost:58322");
      expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:58321");
    });

    it("reports EXTENSION_UNREACHABLE when StarUML answers but the extension does not", async () => {
      const client = new StarUMLClient();
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
      mockTextResponse("Hello from StarUML API Server!", 200);

      const error = await caught(client.callExtension("/get_project_info", {}));

      expect(error.code).toBe(ErrorCode.ExtensionUnreachable);
      expect(error.message).toBe(
        "StarUML is running but nothing answers at http://localhost:58322",
      );
      expect(error.hint).toContain("Extension Manager");
    });
  });

  describe("HTTP errors", () => {
    it("surfaces the extension's error body on HTTP 400", async () => {
      const client = new StarUMLClient();
      mockJsonResponse(
        { success: false, error: "Cannot read properties of null (reading 'model')" },
        400,
        "Bad Request",
      );

      const error = await caught(
        client.callExtension("/create_element_with_view", { type: "T", diagramId: "d" }),
      );

      expect(error.toJSON()).toEqual({
        code: ErrorCode.RequestRejected,
        message: "Cannot read properties of null (reading 'model')",
        endpoint: "/create_element_with_view",
        upstream: "extension",
        status: 400,
      });
    });

    it("passes an upstream code through verbatim", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: false, error: "Element not found: e", code: "NOT_FOUND" }, 404);

      const error = await caught(client.callExtension("/get_element_by_id", { id: "e" }));

      expect(error.code).toBe("NOT_FOUND");
      expect(error.hint).toBeUndefined();
    });

    it("maps an extension 404 without code to ENDPOINT_NOT_FOUND with a version hint", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: false, error: "No handler for /close_diagram" }, 404);

      const error = await caught(client.callExtension("/close_diagram", { id: "d" }));

      expect(error.code).toBe(ErrorCode.EndpointNotFound);
      expect(error.message).toBe("No handler for /close_diagram");
      expect(error.hint).toContain("GET http://localhost:58322/ lists the endpoints");
    });

    it("keeps extension 0.3.0's UNKNOWN_ENDPOINT code and adds the version hint", async () => {
      const client = new StarUMLClient();
      mockJsonResponse(
        { success: false, code: "UNKNOWN_ENDPOINT", error: "No handler for /batch" },
        404,
      );

      const error = await caught(client.callExtension("/batch", {}));

      expect(error).toMatchObject({ code: "UNKNOWN_ENDPOINT", status: 404 });
      expect(error.hint).toContain("does not provide /batch");
    });

    it.each([
      ["INVALID_ARGUMENT", 400],
      ["NO_PROJECT", 409],
      ["STARUML_ERROR", 422],
      ["INTERNAL", 500],
    ])("passes extension 0.3.0's %s (HTTP %d) through without a hint", async (code, status) => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: false, code, error: "why" }, status);

      const error = await caught(client.callExtension("/create_element", {}));

      expect(error.toJSON()).toEqual({
        code,
        message: "why",
        endpoint: "/create_element",
        upstream: "extension",
        status,
      });
    });

    it("maps a built-in 404 HTML page to ENDPOINT_NOT_FOUND with the status line", async () => {
      const client = new StarUMLClient();
      mockTextResponse("<pre>Cannot POST /get_all_diagrams_info</pre>", 404, "Not Found");

      const error = await caught(client.getAllDiagramsInfo());

      expect(error.code).toBe(ErrorCode.EndpointNotFound);
      expect(error.message).toBe("HTTP 404 Not Found");
      expect(error.hint).toContain("StarUML 7.0.0+");
    });

    it("maps HTTP 5xx without an envelope to UPSTREAM_ERROR", async () => {
      const client = new StarUMLClient();
      mockTextResponse("Server error", 500);

      const error = await caught(client.generateDiagram("x"));

      expect(error).toMatchObject({ code: ErrorCode.UpstreamError, status: 500 });
      expect(error.message).toBe("HTTP 500");
    });

    it("uses the error body of a built-in 500", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: false, error: "Error: Unsupported diagram type" }, 500);

      const error = await caught(client.generateDiagram("bogus"));

      expect(error).toMatchObject({
        code: ErrorCode.UpstreamError,
        message: "Error: Unsupported diagram type",
      });
    });
  });

  describe("2xx responses that are not a success", () => {
    it("rejects with REQUEST_REJECTED when success is false", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: false, error: "Invalid Mermaid syntax" });

      const error = await caught(client.generateDiagram("invalid"));

      expect(error).toMatchObject({
        code: ErrorCode.RequestRejected,
        slug: "/generate_diagram",
        message: "Invalid Mermaid syntax",
        status: 200,
      });
    });

    it("keeps the upstream code and falls back to a generic message", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ success: false, code: "BUSY" });

      const error = await caught(client.callExtension("/get_all_commands", {}));

      expect(error.code).toBe("BUSY");
      expect(error.message).toBe(
        "http://localhost:58322/get_all_commands reported failure without a message",
      );
    });

    it("rejects with INVALID_RESPONSE when the body is not JSON", async () => {
      const client = new StarUMLClient();
      mockTextResponse("<html></html>", 200);

      const error = await caught(client.getAllDiagramsInfo());

      expect(error.code).toBe(ErrorCode.InvalidResponse);
      expect(error.hint).toContain("is the StarUML API server");
    });

    it("rejects with INVALID_RESPONSE when JSON lacks the envelope", async () => {
      const client = new StarUMLClient();
      mockJsonResponse({ hello: "world" });

      const error = await caught(client.callExtension("/get_project_info", {}));

      expect(error.code).toBe(ErrorCode.InvalidResponse);
      expect(error.hint).toContain("is staruml-mcp-extension");
    });
  });

  describe("ping", () => {
    it("returns true when HTTP 200", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("OK", { status: 200 }));
      await expect(new StarUMLClient().ping()).resolves.toBe(true);
    });

    it("returns false when HTTP not ok", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
      await expect(new StarUMLClient().ping()).resolves.toBe(false);
    });

    it("returns false when fetch throws", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("network down"));
      await expect(new StarUMLClient().ping()).resolves.toBe(false);
    });
  });

  describe("extensionBanner", () => {
    it("returns the parsed GET / banner", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('{"name":"staruml-mcp-extension","version":"0.3.0"}', { status: 200 }),
      );
      await expect(new StarUMLClient().extensionBanner()).resolves.toEqual({
        name: "staruml-mcp-extension",
        version: "0.3.0",
      });
      expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:58322");
    });

    it("returns null when something answers without JSON", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Hello", { status: 200 }));
      await expect(new StarUMLClient().extensionBanner()).resolves.toBeNull();
    });

    it("returns undefined when nothing answers", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("network down"));
      await expect(new StarUMLClient().extensionBanner()).resolves.toBeUndefined();
    });

    it("gives up on a port that does not answer within the probe deadline", async () => {
      fetchSpy.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
          }),
      );
      vi.useFakeTimers();
      try {
        const banner = new StarUMLClient().extensionBanner();
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(banner).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("access token", () => {
    const headersOf = (call: number): Headers =>
      new Headers(fetchSpy.mock.calls[call]![1]?.headers as Record<string, string>);

    it("sends Authorization: Bearer to the extension only", async () => {
      const client = new StarUMLClient({ extToken: "s3cret" });
      mockJsonResponse({ success: true });
      mockJsonResponse({ success: true });
      fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
      fetchSpy.mockResolvedValueOnce(new Response("OK", { status: 200 }));

      await client.callExtension("/is_modified", {});
      await client.getAllDiagramsInfo();
      await client.extensionBanner();
      await client.ping();

      expect(headersOf(0).get("Authorization")).toBe("Bearer s3cret");
      expect(headersOf(0).get("Content-Type")).toBe("application/json");
      expect(headersOf(1).get("Authorization")).toBeNull();
      expect(headersOf(2).get("Authorization")).toBe("Bearer s3cret");
      expect(headersOf(3).get("Authorization")).toBeNull();
      expect(client.hasExtToken).toBe(true);
    });

    it.each([undefined, ""])("sends no Authorization for the token %j", async (extToken) => {
      const client = new StarUMLClient({ extToken });
      mockJsonResponse({ success: true });

      await client.callExtension("/is_modified", {});

      expect(headersOf(0).get("Authorization")).toBeNull();
      expect(client.hasExtToken).toBe(false);
    });
  });

  describe("extension refusals", () => {
    const refusal = (code: string, status: number, headers: Record<string, string> = {}) =>
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, code, error: `refused: ${code}` }), {
          status,
          headers,
        }),
      );

    it.each([
      [
        "UNAUTHORIZED",
        401,
        {},
        "The extension requires an access token. In StarUML, Tools > MCP Extension > Server Info",
      ],
      ["FORBIDDEN_ORIGIN", 403, {}, "Preferences > MCP Extension > Allowed Origins"],
      ["PAYLOAD_TOO_LARGE", 413, {}, "Max Request Body (KiB) or, for /batch, Max Batch Ops"],
      ["UNSUPPORTED_MEDIA_TYPE", 415, {}, "Content-Type: application/json"],
      [
        "RATE_LIMITED",
        429,
        { "Retry-After": "12" },
        "Retry in 12 s; Preferences > MCP Extension > Commands per Minute limits /execute_command",
      ],
      ["RATE_LIMITED", 429, {}, "Retry later; "],
      ["TIMEOUT", 504, {}, "Request Timeout (s), but StarUML may still finish the work"],
    ])("explains %s (HTTP %d)", async (code, status, headers, hint) => {
      refusal(code, status, headers);

      const error = await caught(new StarUMLClient().callExtension("/execute_command", {}));

      expect(error).toMatchObject({ code, status, message: `refused: ${code}` });
      expect(error.hint).toContain(hint);
    });

    it.each([
      ["/execute_command", "describe_commands({ids: [<id>]}) names the arguments that avoid it"],
      ["/generate_code", "list_code_generators shows the options each language takes"],
      ["/reverse_code", "list_code_generators shows the options each language takes"],
      ["/export_diagrams", "Pass the arguments that avoid it, or use a dedicated endpoint."],
    ])("explains DIALOG_REQUIRED from %s and keeps its details", async (slug, hint) => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            code: "DIALOG_REQUIRED",
            error: "refused",
            details: { dialog: "without-args", args: ["filename"] },
          }),
          { status: 422 },
        ),
      );

      const error = await caught(new StarUMLClient().callExtension(slug, {}));

      expect(error).toMatchObject({
        code: "DIALOG_REQUIRED",
        status: 422,
        details: { dialog: "without-args", args: ["filename"] },
      });
      expect(error.hint).toMatch(/^StarUML would have opened a dialog and waited for someone/);
      expect(error.hint).toContain(hint);
    });

    const reference = (slug: string, code: string, details?: unknown) => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, code, error: `refused: ${code}`, details }), {
          status: code === "UNSUPPORTED_SYNTAX" ? 422 : 409,
        }),
      );
      return caught(new StarUMLClient().callExtension(slug, {}));
    };
    const candidate = (n: number, path: string | null = `Model/P${n}/Order`) => ({
      _id: `C${n}`,
      _type: "UMLClass",
      path,
    });

    it("names the candidates of AMBIGUOUS_REF by path, or by id where paths collide", async () => {
      const error = await reference("/get_element_by_id", "AMBIGUOUS_REF", {
        candidates: [candidate(1), candidate(2), candidate(3, "Order"), candidate(4, "Order")],
      });

      expect(error).toMatchObject({ code: "AMBIGUOUS_REF", status: 409 });
      expect(error.hint).toBe(
        "Pass one of these instead, or a longer path: Model/P1/Order, Model/P2/Order, C3, C4.",
      );
      expect(error.details).toMatchObject({ candidates: [{ _id: "C1" }, {}, {}, {}] });
    });

    it("names five AMBIGUOUS_REF candidates and counts the rest", async () => {
      const candidates = Array.from({ length: 8 }, (_, i) => candidate(i + 1));
      const error = await reference("/delete_element", "AMBIGUOUS_REF", { candidates });

      expect(error.hint).toMatch(/: Model\/P1\/Order, .*, Model\/P5\/Order \(and 3 more\)\.$/);
    });

    it("points to find_elements when AMBIGUOUS_REF has no candidates", async () => {
      expect((await reference("/delete_element", "AMBIGUOUS_REF")).hint).toBe(
        "Pass one of these instead, or a longer path; find_elements lists elements by name.",
      );
      expect((await reference("/delete_element", "AMBIGUOUS_REF", { candidates: 3 })).hint).toBe(
        "Pass one of these instead, or a longer path; find_elements lists elements by name.",
      );
    });

    it.each([
      [
        "/create_element",
        { existing: { _id: "C1", path: "Model/Shop/Order" } },
        "Model/Shop/Order exists already: refer to it by its path, rename the new one, or pass allowDuplicateNames: true to add a second.",
      ],
      [
        "/build_diagram",
        { existing: { _id: "C1" } },
        "C1 exists already: keep reuse on (the default) to show it again, rename the new one, or pass allowDuplicateNames: true to add a second.",
      ],
      [
        "/batch",
        { index: 2 },
        "A sibling of that kind has the name: refer to it by its path, rename the new one, or pass allowDuplicateNames: true to add a second.",
      ],
    ])(
      "suggests reuse or allowDuplicateNames for DUPLICATE_NAME from %s",
      async (slug, d, hint) => {
        expect((await reference(slug, "DUPLICATE_NAME", d)).hint).toBe(hint);
      },
    );

    it("explains SNAPSHOT_STALE and UNSUPPORTED_SYNTAX", async () => {
      expect((await reference("/restore_snapshot", "SNAPSHOT_STALE")).hint).toMatch(
        /^The undo history no longer reaches that snapshot .*take a new one with snapshot\.$/,
      );
      const syntax = await reference("/build_diagram", "UNSUPPORTED_SYNTAX");
      expect(syntax.status).toBe(422);
      expect(syntax.hint).toContain('describe_endpoints({names: ["build_diagram"]})');
    });

    it("explains STYLE_LOCKED with the strict profile's remedies, override last", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            code: "STYLE_LOCKED",
            error: "/move_views: the style profile 'uml-standard' is strict",
            details: { profile: "uml-standard", endpoint: "/move_views" },
          }),
          { status: 403 },
        ),
      );
      const error = await caught(new StarUMLClient().callExtension("/move_views", {}));

      // 403 is also FORBIDDEN_ORIGIN's status; the envelope's code decides.
      expect(error).toMatchObject({ code: "STYLE_LOCKED", status: 403 });
      expect(error.hint).toBe(
        "The style profile 'uml-standard' is strict: views are placed and styled by the profile and the quality loop, not by hand. " +
          "Rearrange with improve_diagram, restyle with apply_style_profile, or rebuild with build_diagram or derive_diagrams; " +
          "pass override: true only when the user asked for this exact change, or turn strict mode off with set_style_profile({patch: {strict: false}}).",
      );
      expect((await reference("/set_view_style", "STYLE_LOCKED")).hint).toMatch(
        /^The style profile is strict: /,
      );
    });

    it("explains SAVE_BLOCKED with the first lint errors and the override", async () => {
      const findings = [
        { rule: "M003", message: "cycle", path: "Shop/billing" },
        { rule: "U001", message: "no type", path: null },
        { rule: "U002", message: "x", path: "Shop/Order" },
        { rule: "U003", message: "y", path: "Shop/Item" },
      ];
      expect((await reference("/save_project", "SAVE_BLOCKED", { count: 4, findings })).hint).toBe(
        "4 lint errors (M003 Shop/billing, U001, U002 Shop/Order, ...) block saving and exporting under the style profile's blockSaveOnErrors. " +
          "Run uml_lint and model_lint, fix what they report, then retry; pass override: true to save or export anyway.",
      );
      expect(
        (await reference("/export_pdf", "SAVE_BLOCKED", { count: 1, findings: [findings[0]] }))
          .hint,
      ).toMatch(/^1 lint error \(M003 Shop\/billing\) blocks saving/);
      expect((await reference("/save_project", "SAVE_BLOCKED")).hint).toMatch(
        /^Lint errors block saving and exporting/,
      );
    });

    it("explains TEMPLATE_ONLY by what to leave out, for a build and for a derivation", async () => {
      const fields = { profile: "uml-standard", fields: ["layout", "spec.styles"] };
      expect((await reference("/build_diagram", "TEMPLATE_ONLY", fields)).hint).toBe(
        "Leave out layout, spec.styles: a strict project builds a diagram from a template name (list_templates) and content (spec, mermaid or text) only, or asks request_diagram for the view by intent.",
      );
      // No template at all: details.fields is empty.
      expect(
        (await reference("/build_diagram", "TEMPLATE_ONLY", { profile: "p", fields: [] })).hint,
      ).toMatch(/^a strict project builds a diagram from a template name/);
      expect(
        (await reference("/derive_diagrams", "TEMPLATE_ONLY", { fields: ["policy", 3] })).hint,
      ).toBe(
        "Leave out policy: what a derived diagram shows and how it looks is its template's; pass template or viewpoints to choose the diagrams.",
      );
      expect((await reference("/derive_diagrams", "TEMPLATE_ONLY")).hint).toMatch(
        /^what a derived diagram shows/,
      );
    });

    it("explains VIEWPOINT_REQUIRED with the three ways a strict project draws", async () => {
      const error = await reference("/create_diagram", "VIEWPOINT_REQUIRED", { profile: "p" });
      expect(error.hint).toContain("request_diagram({intent, scope})");
      expect(error.hint).toContain("build_diagram({template, spec})");
    });

    it("names the alternatives of VIEWPOINT_MISMATCH, with their templates and scopes", async () => {
      const alternatives = [
        {
          viewpoint: "runtime",
          kind: "activity",
          why: "the steps as an activity",
          candidates: ["Model/Telemetry", "Model/Rules", "Model/Alarms", "Model/Other"],
        },
        { viewpoint: "code", kind: "class", why: "What classes?", template: "code-classes" },
        { viewpoint: "data", kind: "erd", why: "What is stored?", candidates: [] },
        { viewpoint: "lifecycle", kind: "statemachine", why: "Which states?" },
        { viewpoint: "deployment", kind: "deployment", why: "Where does it run?" },
      ];
      const error = await reference("/request_diagram", "VIEWPOINT_MISMATCH", {
        reason: "scope",
        alternatives,
      });
      expect(error.hint).toBe(
        "Views that fit: runtime as activity in Model/Telemetry or Model/Rules or Model/Alarms (the steps as an activity); " +
          "code as class, template code-classes (What classes?); data as erd (What is stored?); " +
          "lifecycle as statemachine (Which states?); and 1 more in details.alternatives. " +
          "Ask request_diagram with an intent for one of them and its scope.",
      );
      expect(
        (await reference("/request_diagram", "VIEWPOINT_MISMATCH", { alternatives: [] })).hint,
      ).toMatch(/^Nothing in that scope has such a view; list_viewpoints/);
      expect((await reference("/build_diagram", "VIEWPOINT_MISMATCH")).hint).toMatch(
        /^Nothing in that scope/,
      );
      expect(
        (
          await reference("/build_diagram", "VIEWPOINT_MISMATCH", {
            alternatives: [alternatives[1]],
          })
        ).hint,
      ).toBe(
        "Views that fit: code as class, template code-classes (What classes?). Ask request_diagram with an intent for one of them and its scope.",
      );
    });

    it("explains DIAGRAM_DERIVED: change the model and derive again", async () => {
      expect(
        (
          await reference("/move_views", "DIAGRAM_DERIVED", {
            diagram: "D1",
            path: "Model/Orders",
            template: "code-classes",
          })
        ).hint,
      ).toBe(
        "Model/Orders is drawn from the model: change the model (build_model with upsert, or the model endpoints), then derive_diagrams or request_diagram draws it again.",
      );
      expect((await reference("/delete_element", "DIAGRAM_DERIVED")).hint).toMatch(
        /^The diagram is drawn from the model/,
      );
    });

    it("keeps the details of a success:false answer on HTTP 200", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, code: "NOT_FOUND", error: "x", details: { index: 0 } }),
          { status: 200 },
        ),
      );

      const error = await caught(new StarUMLClient().callExtension("/batch", {}));

      expect(error.details).toEqual({ index: 0 });
      expect(error.toJSON().details).toEqual({ index: 0 });
    });

    it("says a token that was sent was rejected", async () => {
      refusal("UNAUTHORIZED", 401);

      const error = await caught(
        new StarUMLClient({ extToken: "old" }).callExtension("/is_modified", {}),
      );

      expect(error.hint).toMatch(/^The extension rejected the access token this server sent\./);
      expect(error.hint).toContain("clear Preferences > MCP Extension > Access Token");
    });

    it("explains a refusal by status when a proxy answered without a code", async () => {
      mockTextResponse("Gateway Timeout", 504, "Gateway Timeout");

      const error = await caught(new StarUMLClient().callExtension("/export_pdf", {}));

      expect(error.code).toBe(ErrorCode.UpstreamError);
      expect(error.hint).toContain("Request Timeout (s)");
    });

    it("gives no extension hint for the built-in API", async () => {
      mockTextResponse("Unauthorized", 401);

      const error = await caught(new StarUMLClient().getAllDiagramsInfo());

      expect(error.code).toBe(ErrorCode.RequestRejected);
      expect(error.hint).toBeUndefined();
    });

    it.each([
      ["UNAUTHORIZED", 401],
      ["FORBIDDEN_ORIGIN", 403],
    ])("makes the banner probe throw %s, since every call would fail", async (code, status) => {
      refusal(code, status);

      const error = await caught(new StarUMLClient().extensionBanner());

      expect(error).toMatchObject({ code, status, slug: "/", upstream: "extension" });
    });

    it("treats another error status on GET / as no banner", async () => {
      mockTextResponse("oops", 500);

      await expect(new StarUMLClient().extensionBanner()).resolves.toBeUndefined();
    });
  });
});
