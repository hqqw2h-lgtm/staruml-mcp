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
});
