import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bundledCatalog, CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST, compileManifest } from "../src/manifest.js";
import {
  declaresUi,
  UI_EXTENSION,
  VIEWER_HTML,
  VIEWER_MIME_TYPE,
  VIEWER_URI,
} from "../src/viewer.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closedPort, UpstreamFixture, type Reply } from "./support/fixture.js";
import { connect, text, UI_CAPABILITIES, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="411" height="197"><text>Book</text></svg>';
const EXPORTED = {
  diagram: "D1",
  format: "svg",
  mimeType: "image/svg+xml",
  width: 411,
  height: 197,
  bytes: SVG.length,
  base64: Buffer.from(SVG).toString("base64"),
};
const PNG = "iVBORw0KGgo=";

const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
const config = () => ({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
let ui: ConnectedClient;
let plain: ConnectedClient;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  ui = await connect(config(), UI_CAPABILITIES);
  plain = await connect(config());
});

afterEach(() => {
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await Promise.all([ui.close(), plain.close()]);
  await Promise.all([builtin.stop(), extension.stop()]);
});

function serveSvg(name: string | null = "Main"): void {
  extension.reply("/export_diagram", { body: { success: true, data: EXPORTED } });
  extension.reply("/get_element_by_id", {
    body: { success: true, data: { _id: "D1", _type: "UMLClassDiagram", name, _parent: "M1" } },
  });
}

describe("declaresUi", () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ extensions: {} }, false],
    [{ extensions: { [UI_EXTENSION]: {} } }, false],
    [{ extensions: { [UI_EXTENSION]: { mimeTypes: "text/html;profile=mcp-app" } } }, false],
    [{ extensions: { [UI_EXTENSION]: { mimeTypes: ["text/html"] } } }, false],
    [UI_CAPABILITIES, true],
  ])("%j → %s", (capabilities, expected) => {
    expect(declaresUi(capabilities)).toBe(expected);
  });
});

describe("view_diagram listing", () => {
  it("names the viewer in the tool's _meta, in the current and the legacy key", async () => {
    const { tools } = await plain.client.listTools();
    const tool = tools.find((t) => t.name === "view_diagram")!;

    expect(tool._meta).toEqual({ ui: { resourceUri: VIEWER_URI }, "ui/resourceUri": VIEWER_URI });
    // path writes and overwrites a file, so the tool is not read-only (#19).
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(tool.inputSchema.required).toBeUndefined();
    expect(tool.inputSchema.properties).toMatchObject({
      path: { description: "Absolute file to write instead." },
    });
    // maxWidth is accepted unlisted, to keep the core tier under 2,000 tokens.
    expect(tool.inputSchema.properties).not.toHaveProperty("maxWidth");
  });

  it("serves the viewer page as an MCP Apps resource", async () => {
    // A client that read the page gets the viewer from then on, so not the shared plain one.
    const mcp = await connect(config());
    const { contents } = await mcp.client.readResource({ uri: VIEWER_URI });
    await mcp.close();

    expect(contents).toEqual([
      {
        uri: VIEWER_URI,
        mimeType: VIEWER_MIME_TYPE,
        text: VIEWER_HTML,
        _meta: { ui: { prefersBorder: true } },
      },
    ]);
  });
});

describe("view_diagram for a client that renders MCP Apps", () => {
  it("exports the SVG for the viewer and tells the model only what was shown", async () => {
    serveSvg();

    const result = await ui.call("view_diagram", { diagram: "Model/Main" });

    expect(result.isError).toBeFalsy();
    expect(extension.requests).toEqual([
      { method: "POST", path: "/export_diagram", body: { diagram: "Model/Main", format: "svg" } },
      { method: "POST", path: "/get_element_by_id", body: { ref: "D1" } },
    ]);
    expect(result.structuredContent).toEqual({
      diagram: "D1",
      name: "Main",
      width: 411,
      height: 197,
      svg: SVG,
    });
    expect(JSON.parse(text(result))).toEqual({
      diagram: "D1",
      name: "Main",
      width: 411,
      height: 197,
      viewer: VIEWER_URI,
    });
    expect(builtin.requests).toEqual([]);
  });

  it("shows the current diagram without an id, and an unnamed one with an empty name", async () => {
    serveSvg(null);

    const result = await ui.call("view_diagram");

    expect(extension.requests[0]!.body).toEqual({ format: "svg" });
    expect(result.structuredContent).toMatchObject({ name: "" });
  });

  it("reports an export answered without the image", async () => {
    const { base64: _omitted, ...rest } = EXPORTED;
    extension.reply("/export_diagram", { body: { success: true, data: rest } });

    const result = await ui.call("view_diagram", { id: "D1" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "INVALID_RESPONSE",
        message: "export_diagram answered without the image",
        endpoint: "/export_diagram",
        upstream: "extension",
      },
    });
  });

  it("passes the extension's error through", async () => {
    extension.reply("/export_diagram", {
      status: 404,
      body: { success: false, code: "NOT_FOUND", error: "Diagram not found: X" },
    });

    const result = await ui.call("view_diagram", { id: "X" });

    expect(text(result)).toBe(
      "Failed to view diagram: Diagram not found: X [NOT_FOUND, /export_diagram, HTTP 404]",
    );
  });

  it.each([
    ["the extension is incompatible", { ...bundledCatalog(), enabled: false }],
    [
      "the manifest has no /export_diagram",
      {
        ...bundledCatalog(),
        compiled: compileManifest({
          ...BUNDLED_MANIFEST,
          endpoints: BUNDLED_MANIFEST.endpoints.filter((e) => e.path !== "/export_diagram"),
        }),
      },
    ],
  ])("falls back to the PNG when %s", async (_case, catalog) => {
    builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: PNG } });
    const mcp = await connect({ ...config(), catalog: new CatalogState(catalog) }, UI_CAPABILITIES);
    try {
      const result = await mcp.call("view_diagram", { id: "D1" });

      expect(result.content).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
      expect(extension.requests).toEqual([]);
    } finally {
      await mcp.close();
    }
  });
});

/** A PNG header naming its size, all pngSize reads (PNG spec, 11.2.2). */
function pngOf(width: number, height: number): string {
  const head = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head.toString("base64");
}

/** /export_diagram answers of a PNG `width` pixels wide, in turn. */
function servePng(...widths: number[]): void {
  extension.reply(
    "/export_diagram",
    ...(widths.map((width) => ({
      body: {
        success: true,
        data: {
          diagram: "D1",
          format: "png",
          mimeType: "image/png",
          width,
          height: width / 2,
          bytes: 24,
          base64: pngOf(width, width / 2),
        },
      },
    })) as [Reply, ...Reply[]]),
  );
}

const exports = () =>
  extension.requests.filter((r) => r.path === "/export_diagram").map((r) => r.body);

describe("view_diagram for a client without MCP Apps", () => {
  it("returns the extension's PNG export of the diagram a path names", async () => {
    servePng(800);

    const result = await plain.call("view_diagram", { diagram: "Model/Main" });

    expect(result).toEqual({
      content: [{ type: "image", data: pngOf(800, 400), mimeType: "image/png" }],
    });
    expect(exports()).toEqual([{ diagram: "Model/Main", format: "png" }]);
    expect(builtin.requests).toEqual([]);
  });

  it("exports a diagram wider than the profile's page again at the page's width", async () => {
    extension.reply("/get_style_profile", {
      body: { success: true, data: { profile: { layout: { page: { width: 1123 } } } } },
    });
    servePng(4492, 1123);

    const result = await plain.call("view_diagram", { diagram: "D1" });

    expect(exports()).toEqual([
      { diagram: "D1", format: "png" },
      { diagram: "D1", format: "png", scale: 0.25 },
    ]);
    expect(result.content).toEqual([
      { type: "image", data: pngOf(1123, 561.5), mimeType: "image/png" },
      { type: "text", text: '{"width":1123,"height":561.5,"fullWidth":4492}' },
    ]);
  });

  it.each([
    ["no profile can be read", { status: 404, body: { success: false, error: "No handler" } }],
    ["the profile has no page", { body: { success: true, data: { profile: {} } } }],
    ["the answer has no profile", { body: { success: true, data: null } }],
  ])("caps at 1,600 px when %s", async (_, reply) => {
    extension.reply("/get_style_profile", reply);
    servePng(3200, 1600);

    await plain.call("view_diagram", { diagram: "D1" });

    expect(exports().at(-1)).toEqual({ diagram: "D1", format: "png", scale: 0.5 });
  });

  it.each([
    ["a page width of 0", { profile: { layout: { page: { width: 0 } } } }],
    ["a page width that is no number", { profile: { layout: { page: { width: "900" } } } }],
  ])("caps at 1,600 px for %s", async (_, data) => {
    extension.reply("/get_style_profile", { body: { success: true, data } });
    servePng(3200, 1600);

    await plain.call("view_diagram", { diagram: "D1" });

    expect(exports().at(-1)).toEqual({ diagram: "D1", format: "png", scale: 0.5 });
  });

  it("exports once when the image is exactly as wide as the cap, or says no width", async () => {
    servePng(1600);
    await plain.call("view_diagram", { diagram: "D1" });
    expect(exports()).toHaveLength(1);

    extension.requests.length = 0;
    extension.reply("/export_diagram", { body: { success: true, data: { base64: PNG } } });
    await plain.call("view_diagram", { diagram: "D1" });
    expect(exports()).toHaveLength(1);
  });

  it("rounds the scale down, and never below 1/100", async () => {
    servePng(4801, 1599);
    await plain.call("view_diagram", { diagram: "D1" });
    // 1600 / 4801 = 0.33326...: at 0.333 the image is 1,599 px, under the cap.
    expect(exports().at(-1)).toMatchObject({ scale: 0.333 });

    extension.requests.length = 0;
    servePng(1_000_000, 10_000);
    await plain.call("view_diagram", { diagram: "D1" });
    expect(exports().at(-1)).toMatchObject({ scale: 0.01 });
  });

  it("takes the call's maxWidth over the server's, and 0 as full size", async () => {
    const mcp = await connect({ ...config(), imageMaxWidth: 500 });
    try {
      servePng(2000, 1000);
      await mcp.call("view_diagram", { diagram: "D1" });
      expect(exports().at(-1)).toMatchObject({ scale: 0.25 });

      extension.requests.length = 0;
      servePng(2000, 400);
      await mcp.call("view_diagram", { diagram: "D1", maxWidth: 400 });
      expect(exports().at(-1)).toMatchObject({ scale: 0.2 });

      extension.requests.length = 0;
      servePng(2000);
      const full = await mcp.call("view_diagram", { diagram: "D1", maxWidth: 0 });
      expect(exports()).toEqual([{ diagram: "D1", format: "png" }]);
      expect(full.content).toHaveLength(1);
      // The server's cap is used as it is: no profile read.
      expect(extension.requests.map((r) => r.path)).not.toContain("/get_style_profile");
    } finally {
      await mcp.close();
    }
  });

  it.each([[-1], [1.5], ["800"], [null]])(
    "refuses maxWidth %j before anything is sent",
    async (maxWidth) => {
      const result = await plain.call("view_diagram", { diagram: "D1", maxWidth });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: "INVALID_ARGUMENT",
          message: "maxWidth: expected a whole number of pixels, 0 or more",
        },
      });
      expect(extension.requests).toEqual([]);
    },
  );

  it("falls back to StarUML's own PNG, passing the reference as an id, when the extension does not answer", async () => {
    builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: PNG } });
    const mcp = await connect({ ...config(), extPort: await closedPort() });
    try {
      const result = await mcp.call("view_diagram", { id: "D1" });

      expect(result.content).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
      expect(builtin.requests.at(-1)).toEqual({
        method: "POST",
        path: "/get_diagram_image_by_id",
        body: { diagramId: "D1" },
      });
      // Labels need the extension; without it they are an error, not a picture without.
      const labelled = await mcp.call("view_diagram", { id: "D1", annotate: "ids" });
      expect(labelled.structuredContent).toMatchObject({
        error: { code: "EXTENSION_UNREACHABLE" },
      });
    } finally {
      await mcp.close();
    }
  });

  it("picks the one diagram among an ambiguous name's candidates (a derived sequence diagram)", async () => {
    const candidate = (_id: string, _type: string) => ({ _id, _type, path: `Clinic/${_id}` });
    extension.reply(
      "/export_diagram",
      {
        status: 409,
        body: {
          success: false,
          code: "AMBIGUOUS_REF",
          error: "Element Booking names 3 elements; pass one of their ids or a longer path",
          details: {
            candidates: [
              candidate("C1", "UMLCollaboration"),
              candidate("I1", "UMLInteraction"),
              candidate("D7", "UMLSequenceDiagram"),
            ],
          },
        },
      },
      { body: { success: true, data: { diagram: "D7", width: 300, height: 200, base64: PNG } } },
    );

    const result = await plain.call("view_diagram", { diagram: "Booking" });

    expect(result.content).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
    expect(exports()).toEqual([
      { diagram: "Booking", format: "png" },
      { diagram: "D7", format: "png" },
    ]);
  });

  it.each([
    [
      "two diagrams",
      {
        candidates: [
          { _id: "D1", _type: "UMLClassDiagram" },
          { _id: "D2", _type: "UMLSequenceDiagram" },
        ],
      },
    ],
    [
      "no diagram",
      {
        candidates: [
          { _id: "C1", _type: "UMLClass" },
          { _id: "C2", _type: "UMLClass" },
        ],
      },
    ],
    ["a diagram without an id", { candidates: [{ _type: "UMLClassDiagram" }, { _id: "C2" }] }],
    ["no candidates", undefined],
    ["candidates that are no list", { candidates: "D1" }],
  ])("keeps AMBIGUOUS_REF with %s among the candidates", async (_, details) => {
    extension.reply("/export_diagram", {
      status: 409,
      body: { success: false, code: "AMBIGUOUS_REF", error: "ambiguous", details },
    });

    const result = await plain.call("view_diagram", { diagram: "Main" });

    expect(result.structuredContent).toMatchObject({ error: { code: "AMBIGUOUS_REF" } });
    expect(exports()).toHaveLength(1);
    expect(builtin.requests).toEqual([]);
  });

  it("reports a diagram the extension does not find", async () => {
    extension.reply("/export_diagram", {
      status: 404,
      body: { success: false, code: "NOT_FOUND", error: "Element not found: Nope" },
    });

    const result = await plain.call("view_diagram", { diagram: "Nope" });

    expect(result.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(builtin.requests).toEqual([]);
  });

  it("exports the current diagram without an id", async () => {
    servePng(300);

    const result = await plain.call("view_diagram");

    expect(result.isError).toBeFalsy();
    expect(exports()).toEqual([{ format: "png" }]);
  });

  describe("without the extension", () => {
    const disabled = () => new CatalogState({ ...bundledCatalog(), enabled: false });

    it("looks up the current diagram without an id", async () => {
      builtin.reply("/get_current_diagram_info", {
        body: { success: true, data: { id: "D7", type: "UMLClassDiagram", name: "Main" } },
      });
      builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: PNG } });
      const mcp = await connect({ ...config(), catalog: disabled() });
      try {
        const result = await mcp.call("view_diagram");

        expect(result.isError).toBeFalsy();
        expect(builtin.requests.map((r) => [r.path, r.body])).toEqual([
          ["/get_current_diagram_info", {}],
          ["/get_diagram_image_by_id", { diagramId: "D7" }],
        ]);
      } finally {
        await mcp.close();
      }
    });

    it("asks for an id when no diagram is open", async () => {
      builtin.reply("/get_current_diagram_info", { body: { success: true, data: null } });
      const mcp = await connect({ ...config(), catalog: disabled() });
      try {
        const result = await mcp.call("view_diagram");

        expect(result.isError).toBe(true);
        expect(text(result)).toBe(
          "Failed to view diagram: No diagram is open in StarUML. [INVALID_ARGUMENT]\n" +
            "Hint: Pass diagram; get_all_diagrams_info lists the diagrams.",
        );
      } finally {
        await mcp.close();
      }
    });

    it("writes StarUML's PNG to a path, parents created, and answers its path and size", async () => {
      builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: pngOf(640, 320) } });
      const file = join(mkdtempSync(join(tmpdir(), "staruml-mcp-view-")), "a", "b", "main.png");
      const mcp = await connect({ ...config(), catalog: disabled() });
      try {
        const result = await mcp.call("view_diagram", { diagram: "D1", path: file });

        // The diagram and the file are the call's own, so they are not echoed.
        expect(JSON.parse(text(result))).toEqual({ width: 640, height: 320, bytes: 24 });
        expect(readFileSync(file).toString("base64")).toBe(pngOf(640, 320));
      } finally {
        await mcp.close();
      }
    });

    it("answers no size for bytes that are not a PNG", async () => {
      builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: PNG } });
      builtin.reply("/get_current_diagram_info", {
        body: { success: true, data: { id: "D7", type: "UMLClassDiagram", name: "Main" } },
      });
      const file = join(mkdtempSync(join(tmpdir(), "staruml-mcp-view-")), "short.png");
      const mcp = await connect({ ...config(), catalog: disabled() });
      try {
        const result = await mcp.call("view_diagram", { path: file });

        expect(JSON.parse(text(result))).toEqual({ diagram: "D7", bytes: 8 });
      } finally {
        await mcp.close();
      }
    });

    it("answers no size for 24 bytes or more that are not a PNG", async () => {
      const notPng = Buffer.alloc(32, 7).toString("base64");
      builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: notPng } });
      const file = join(mkdtempSync(join(tmpdir(), "staruml-mcp-view-")), "odd.png");
      const mcp = await connect({ ...config(), catalog: disabled() });
      try {
        const result = await mcp.call("view_diagram", { diagram: "D1", path: file });

        expect(JSON.parse(text(result))).toEqual({ bytes: 32 });
      } finally {
        await mcp.close();
      }
    });

    it.each([["/tmp/main.svg"], ["/tmp/main.JPG"]])(
      "refuses %s, which only the extension writes",
      async (file) => {
        const mcp = await connect({ ...config(), catalog: disabled() });
        try {
          const result = await mcp.call("view_diagram", { diagram: "D1", path: file });

          expect(result.structuredContent).toMatchObject({ error: { code: "EXTENSION_REQUIRED" } });
          expect(builtin.requests).toEqual([]);
        } finally {
          await mcp.close();
        }
      },
    );
  });

  describe("with path", () => {
    const written = (format: string, width: number, path: string) => ({
      body: {
        success: true,
        data: {
          diagram: "D1",
          format,
          mimeType: `image/${format}`,
          width,
          height: 100,
          bytes: 5120,
          path,
        },
      },
    });

    it.each([
      ["/tmp/out/main.png", "png"],
      ["/tmp/out/main.svg", "svg"],
      ["/tmp/out/main.jpeg", "jpeg"],
      ["/tmp/out/main.jpg", "jpeg"],
      ["/tmp/out/main", "png"],
    ])("has the extension write %s as %s and answers its path and size", async (file, format) => {
      extension.reply("/export_diagram", written(format, 5800, file));

      const result = await plain.call("view_diagram", { diagram: "Main", path: file });

      expect(exports()).toEqual([{ diagram: "Main", format, path: file }]);
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            diagram: "D1",
            width: 5800,
            height: 100,
            bytes: 5120,
          }),
        },
      ]);
    });

    it("writes the labelled image, capped only when the call asks", async () => {
      extension.reply(
        "/export_diagram",
        written("png", 4000, "/tmp/x.png"),
        written("png", 1000, "/tmp/x.png"),
      );

      const result = await plain.call("view_diagram", {
        path: "/tmp/x.png",
        annotate: "paths",
        maxWidth: 1000,
      });

      expect(exports()).toEqual([
        { format: "png", annotate: "paths", path: "/tmp/x.png" },
        { format: "png", annotate: "paths", path: "/tmp/x.png", scale: 0.25 },
      ]);
      expect(JSON.parse(text(result))).toMatchObject({ width: 1000, fullWidth: 4000 });
    });

    it("writes an SVG whole, whatever maxWidth says", async () => {
      extension.reply("/export_diagram", written("svg", 4000, "/tmp/x.svg"));

      await plain.call("view_diagram", { path: "/tmp/x.svg", maxWidth: 100 });

      expect(exports()).toEqual([{ format: "svg", path: "/tmp/x.svg" }]);
    });

    it("refuses a relative path before anything is sent", async () => {
      const result = await plain.call("view_diagram", { path: "out/main.png" });

      expect(result.structuredContent).toEqual({
        error: {
          code: "INVALID_ARGUMENT",
          message: 'path: must be an absolute path, got "out/main.png"',
          hint: "Pass an absolute file such as /tmp/diagram.png; the extension writes it.",
        },
      });
      expect(extension.requests).toEqual([]);
    });

    it("writes the file even for a client that renders the viewer", async () => {
      extension.reply("/export_diagram", written("png", 300, "/tmp/v.png"));

      const result = await ui.call("view_diagram", { path: "/tmp/v.png" });

      expect(result.structuredContent).toBeUndefined();
      expect(exports()).toEqual([{ format: "png", path: "/tmp/v.png" }]);
    });
  });

  it("rejects an empty diagram before calling StarUML", async () => {
    const result = await plain.call("view_diagram", { diagram: "" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Input validation error/);
    expect(builtin.requests).toEqual([]);
  });

  it("switches to the viewer once the client has fetched the viewer page", async () => {
    const mcp = await connect(config());
    try {
      await mcp.client.readResource({ uri: VIEWER_URI });
      serveSvg();

      const result = await mcp.call("view_diagram", { id: "D1" });

      expect(result.structuredContent).toMatchObject({ svg: SVG });
    } finally {
      await mcp.close();
    }
  });
});

describe("view_diagram with annotate (extension #24)", () => {
  const LABELLED = { ...EXPORTED, format: "png", mimeType: "image/png", base64: PNG };

  it("asks the SVG export for labels in the viewer", async () => {
    serveSvg();

    const result = await ui.call("view_diagram", { diagram: "Main", annotate: "paths" });

    expect(result.isError).toBeFalsy();
    expect(extension.requests[0]!.body).toEqual({
      diagram: "Main",
      format: "svg",
      annotate: "paths",
    });
  });

  it("draws the labelled PNG with the extension, since the built-in PNG has none", async () => {
    extension.reply("/export_diagram", { body: { success: true, data: LABELLED } });

    const result = await plain.call("view_diagram", { annotate: "ids" });

    expect(result).toEqual({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(exports()).toEqual([{ format: "png", annotate: "ids" }]);
    expect(builtin.requests).toEqual([]);
  });

  it("exports the PNG without labels for annotate none", async () => {
    servePng(300);

    const result = await plain.call("view_diagram", { diagram: "D1", annotate: "none" });

    expect(result.content).toEqual([
      { type: "image", data: pngOf(300, 150), mimeType: "image/png" },
    ]);
    expect(exports()).toEqual([{ diagram: "D1", format: "png" }]);
  });

  it("reports a labelled export answered without the image", async () => {
    const { base64: _omitted, ...rest } = LABELLED;
    extension.reply("/export_diagram", { body: { success: true, data: rest } });

    const result = await plain.call("view_diagram", { annotate: "paths" });

    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_RESPONSE" } });
  });

  it("refuses labels without the extension's export instead of showing a picture without", async () => {
    const catalog = new CatalogState({ ...bundledCatalog(), enabled: false });
    const mcp = await connect({ ...config(), catalog });
    try {
      const result = await mcp.call("view_diagram", { annotate: "paths" });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "EXTENSION_REQUIRED" } });
      expect(builtin.requests).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  it("rejects an unknown mode before calling StarUML", async () => {
    const result = await plain.call("view_diagram", { annotate: "names" });

    expect(text(result)).toMatch(/Input validation error/);
    expect(extension.requests).toEqual([]);
  });

  it("lists annotate by reference to export_diagram", async () => {
    const { tools } = await plain.client.listTools();
    const tool = tools.find((t) => t.name === "view_diagram")!;

    expect(tool.inputSchema.properties).toMatchObject({
      annotate: { description: "As export_diagram's." },
    });
  });
});
