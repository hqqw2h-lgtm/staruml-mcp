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
import { closedPort, UpstreamFixture } from "./support/fixture.js";
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
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(tool.inputSchema.required).toBeUndefined();
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

describe("view_diagram for a client without MCP Apps", () => {
  it("returns the PNG image block get_diagram_image_by_id returns for the id a path names", async () => {
    builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: PNG } });
    serveSvg();

    const result = await plain.call("view_diagram", { diagram: "Model/Main" });

    expect(result).toEqual({
      content: [{ type: "image", data: PNG, mimeType: "image/png" }],
    });
    expect(extension.requests).toEqual([
      { method: "POST", path: "/get_element_by_id", body: { ref: "Model/Main" } },
    ]);
    expect(builtin.requests).toEqual([
      { method: "POST", path: "/get_diagram_image_by_id", body: { diagramId: "D1" } },
    ]);
  });

  it("passes the reference on as an id when the extension does not answer", async () => {
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
    } finally {
      await mcp.close();
    }
  });

  it("reports a path the extension cannot resolve", async () => {
    extension.reply("/get_element_by_id", {
      status: 409,
      body: {
        success: false,
        code: "AMBIGUOUS_REF",
        error: "Element Main names 2 elements; pass one of their ids or a longer path",
      },
    });

    const result = await plain.call("view_diagram", { diagram: "Main" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "AMBIGUOUS_REF" } });
    expect(builtin.requests).toEqual([]);
  });

  it("looks up the current diagram without an id", async () => {
    builtin.reply("/get_current_diagram_info", {
      body: { success: true, data: { id: "D7", type: "UMLClassDiagram", name: "Main" } },
    });
    builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: PNG } });

    const result = await plain.call("view_diagram");

    expect(result.isError).toBeFalsy();
    expect(builtin.requests.map((r) => [r.path, r.body])).toEqual([
      ["/get_current_diagram_info", {}],
      ["/get_diagram_image_by_id", { diagramId: "D7" }],
    ]);
  });

  it("asks for an id when no diagram is open", async () => {
    builtin.reply("/get_current_diagram_info", { body: { success: true, data: null } });

    const result = await plain.call("view_diagram");

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Failed to view diagram: No diagram is open in StarUML. [INVALID_ARGUMENT]\n" +
        "Hint: Pass diagram; get_all_diagrams_info lists the diagrams.",
    );
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
    expect(extension.requests).toEqual([
      { method: "POST", path: "/export_diagram", body: { format: "png", annotate: "ids" } },
    ]);
    expect(builtin.requests).toEqual([]);
  });

  it("keeps the built-in PNG for annotate none", async () => {
    builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: PNG } });
    serveSvg();

    const result = await plain.call("view_diagram", { diagram: "D1", annotate: "none" });

    expect(result.content).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
    expect(extension.requests.map((r) => r.path)).toEqual(["/get_element_by_id"]);
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
