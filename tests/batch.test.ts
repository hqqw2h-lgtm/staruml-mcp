import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BATCH_DESCRIPTION } from "../src/batch.js";
import { EXPORT_DIAGRAM_DESCRIPTION } from "../src/export-diagram.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  mcp = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
});

afterEach(() => {
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await mcp.close();
  await Promise.all([builtin.stop(), extension.stop()]);
});

const view = (id: string, type: string, parent: string) => ({
  _id: id,
  _type: type,
  name: null,
  _parent: parent,
});

/** A class diagram with two classes and an association, as an agent would send it. */
const classDiagram = [
  {
    path: "/create_diagram",
    body: { type: "UMLClassDiagram", parentId: "M1", name: "Shop" },
    as: "d",
  },
  {
    path: "/create_element_with_view",
    body: { type: "UMLClass", parentId: "M1", diagramId: "$d", name: "Order", x: 40, y: 40 },
    as: "order",
  },
  {
    path: "/create_element_with_view",
    body: { type: "UMLClass", parentId: "M1", diagramId: "$d", name: "Line", x: 300, y: 40 },
    as: "line",
  },
  { path: "/add_attribute", body: { ownerId: "$order.model", name: "id", type: "UUID" } },
  {
    path: "/create_edge_with_view",
    body: {
      type: "UMLAssociation",
      parentId: "M1",
      diagramId: "$d",
      tailViewId: "$order.view",
      headViewId: "$line.view",
    },
  },
];

const answer = {
  atomic: true,
  succeeded: 5,
  failed: 0,
  results: [
    {
      path: "/create_diagram",
      as: "d",
      success: true,
      data: { _id: "D1", _type: "UMLClassDiagram", name: "Shop", _parent: "M1" },
    },
    {
      path: "/create_element_with_view",
      as: "order",
      success: true,
      data: {
        view: view("V1", "UMLClassView", "D1"),
        model: { _id: "C1", _type: "UMLClass", name: "Order", _parent: "M1" },
      },
    },
    {
      path: "/create_element_with_view",
      as: "line",
      success: true,
      data: {
        view: view("V2", "UMLClassView", "D1"),
        model: { _id: "C2", _type: "UMLClass", name: "Line", _parent: "M1" },
      },
    },
    {
      path: "/add_attribute",
      success: true,
      data: { _id: "A1", _type: "UMLAttribute", name: "id", _parent: "C1" },
    },
    {
      path: "/create_edge_with_view",
      success: true,
      data: {
        view: view("V3", "UMLAssociationView", "D1"),
        model: { _id: "R1", _type: "UMLAssociation", name: "", _parent: "C1" },
      },
    },
  ],
};

describe("batch tool", () => {
  it("is listed in the core tier with a terse description and its own schema", async () => {
    const { tools } = await mcp.client.listTools();
    const batch = tools.find((t) => t.name === "batch")!;

    expect(batch.description).toBe(BATCH_DESCRIPTION);
    expect(BATCH_DESCRIPTION.length).toBeLessThanOrEqual(100);
    expect(Object.keys(batch.inputSchema.properties!)).toEqual(["ops", "atomic"]);
    expect(batch.inputSchema.required).toEqual(["ops"]);
    expect(batch.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it("sends a class diagram in one request and returns each result without its path", async () => {
    extension.reply("/batch", { body: { success: true, data: answer } });

    const result = await mcp.call("batch", { ops: classDiagram });

    expect(result.isError).toBeFalsy();
    expect(extension.requests).toEqual([
      { method: "POST", path: "/batch", body: { ops: classDiagram } },
    ]);
    const parsed = JSON.parse(text(result)) as { results: Record<string, unknown>[] };
    expect(parsed).toMatchObject({ atomic: true, succeeded: 5, failed: 0 });
    expect(parsed.results[0]).toEqual({
      as: "d",
      data: { _id: "D1", _type: "UMLClassDiagram", name: "Shop", _parent: "M1" },
    });
    expect(parsed.results[1]).toEqual({
      as: "order",
      data: {
        view: { _id: "V1", _type: "UMLClassView", _parent: "D1" },
        model: { _id: "C1", _type: "UMLClass", name: "Order", _parent: "M1" },
      },
    });
    expect(text(result)).not.toContain('"path"');
    expect(text(result)).not.toContain('"success"');
  });

  it("keeps success:false and the code of an op that failed in a non-atomic batch", async () => {
    extension.reply("/batch", {
      body: {
        success: true,
        data: {
          atomic: false,
          succeeded: 1,
          failed: 1,
          results: [
            { path: "/delete_element", success: true, data: { deleted: "E1" } },
            {
              path: "/delete_element",
              success: false,
              code: "NOT_FOUND",
              error: "Element not found: E2",
            },
          ],
        },
      },
    });

    const result = await mcp.call("batch", {
      ops: [
        { path: "/delete_element", body: { id: "E1" } },
        { path: "/delete_element", body: { id: "E2" } },
      ],
      atomic: false,
    });

    // atomic echoes the argument and is dropped.
    expect(text(result)).toBe(
      '{"succeeded":1,"failed":1,"results":[{"data":{"deleted":"E1"}},{"success":false,"code":"NOT_FOUND","error":"Element not found: E2"}]}',
    );
  });

  it("reports the extension's rollback of an atomic batch with its code and details", async () => {
    extension.reply("/batch", {
      status: 404,
      body: {
        success: false,
        code: "NOT_FOUND",
        error: "ops.1 /delete_element failed, batch rolled back: Element not found: E2",
        details: {
          index: 1,
          results: [
            { path: "/delete_element", success: true, data: { deleted: "E1", note: null } },
            {
              path: "/delete_element",
              success: false,
              code: "NOT_FOUND",
              error: "Element not found: E2",
            },
          ],
        },
      },
    });

    const result = await mcp.call("batch", {
      ops: [
        { path: "/delete_element", body: { id: "E1" } },
        { path: "/delete_element", body: { id: "E2" } },
      ],
    });

    expect(result.isError).toBe(true);
    // The results name rolled-back elements, so the text shows only the failing op's index.
    expect(text(result)).toBe(
      'Failed to batch: ops.1 /delete_element failed, batch rolled back: Element not found: E2 [NOT_FOUND, /batch, HTTP 404]\nDetails: {"index":1}',
    );
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "NOT_FOUND",
        details: {
          index: 1,
          results: [
            { data: { deleted: "E1" } },
            { success: false, code: "NOT_FOUND", error: "Element not found: E2" },
          ],
        },
      },
    });
  });

  it("accepts a reference where the schema wants another type, numeric segments, and $$ escapes", async () => {
    extension.reply("/batch", { body: { success: true, data: { results: [] } } });
    const ops = [
      { path: "/get_element_by_id", body: { id: "V1" }, as: "v" },
      { path: "/move_views", body: { ids: ["$v"], dx: "$v.left", dy: 0 } },
      { path: "/delete_element", body: { id: "$v.model.operands.0" } },
      { path: "/set_documentation", body: { elementId: "C1", documentation: "$$5 off" } },
    ];

    const result = await mcp.call("batch", { ops });

    expect(result.isError).toBeFalsy();
    expect(extension.requests[0]!.body).toEqual({ ops });
  });

  it.each([
    [
      "an op path the manifest lacks",
      [{ path: "/build_diagrams" }],
      "ops.0.path: no endpoint /build_diagrams",
      "describe_endpoints() lists the endpoints.",
    ],
    [
      "a body its endpoint's schema rejects",
      [{ path: "/create_diagram", body: { parentId: 7 } }],
      "ops.0.body.type: Invalid input: expected string, received undefined; body.parentId: Invalid input: expected string, received number",
      'describe_endpoints({names: ["create_diagram"]}) shows its schema.',
    ],
    [
      "an unknown key in an op body",
      [{ path: "/delete_element", body: { id: "E1", force: true } }],
      'ops.0.body: Unrecognized key: "force"',
      'describe_endpoints({names: ["delete_element"]}) shows its schema.',
    ],
    [
      "a reference to a later op",
      [
        { path: "/delete_element", body: { id: "$c" } },
        { path: "/create_element", body: { type: "UMLClass", parentId: "M1" }, as: "c" },
      ],
      "ops.0.body.id: $c names no earlier op",
      'describe_endpoints({names: ["delete_element"]}) shows its schema.',
    ],
    [
      "a reference to an unnamed op inside an array",
      [{ path: "/move_views", body: { ids: ["V1", "$x.view"], dx: 1, dy: 1 } }],
      "ops.0.body.ids.1: $x.view names no earlier op",
      'describe_endpoints({names: ["move_views"]}) shows its schema.',
    ],
  ])("rejects %s with INVALID_ARGUMENT before sending", async (_, ops, message, hint) => {
    const result = await mcp.call("batch", { ops });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "INVALID_ARGUMENT", message, endpoint: "/batch", hint },
    });
    expect(extension.requests).toEqual([]);
  });

  it("rejects an op path without a leading slash through the input schema", async () => {
    const result = await mcp.call("batch", { ops: [{ path: "delete_element" }] });

    expect(text(result)).toMatch(/Input validation error/);
    expect(extension.requests).toEqual([]);
  });

  it("checks the ops of a batch sent through call_endpoint too", async () => {
    const result = await mcp.call("call_endpoint", {
      name: "batch",
      body: { ops: [{ path: "/delete_element", body: {} }] },
    });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: "INVALID_ARGUMENT",
        message: "ops.0.body.ref: Invalid input: expected string, received undefined",
      },
    });
    expect(extension.requests).toEqual([]);
  });

  it("compacts a batch result reached through call_endpoint", async () => {
    extension.reply("/batch", { body: { success: true, data: answer } });

    const result = await mcp.call("call_endpoint", { name: "batch", body: { ops: classDiagram } });

    expect(text(result)).not.toContain('"path"');
  });
});

describe("export_diagram", () => {
  const meta = {
    diagram: "D1",
    format: "png",
    width: 640,
    height: 480,
    bytes: 1234,
  };

  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
  ])("returns a %s as an image block and the rest as text", async (format, mimeType) => {
    extension.reply("/export_diagram", {
      body: { success: true, data: { ...meta, format, mimeType, base64: "iVBORw0KGgo=" } },
    });

    const result = await mcp.call("export_diagram", { diagram: "Model/Main", format });

    expect(extension.requests[0]!.body).toEqual({ diagram: "Model/Main", format });
    expect(result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType },
      { type: "text", text: '{"diagram":"D1","width":640,"height":480,"bytes":1234}' },
    ]);
  });

  it("keeps an SVG as JSON, since MCP clients do not all render SVG images", async () => {
    const data = { ...meta, format: "svg", mimeType: "image/svg+xml", base64: "PHN2Zy8+" };
    extension.reply("/export_diagram", { body: { success: true, data } });

    const result = await mcp.call("export_diagram", { format: "svg" });

    expect(text(result)).toBe(
      '{"diagram":"D1","width":640,"height":480,"bytes":1234,"mimeType":"image/svg+xml","base64":"PHN2Zy8+"}',
    );
  });

  it("reports the file it wrote without an image", async () => {
    const data = { ...meta, mimeType: "image/png", path: "/tmp/d.png" };
    extension.reply("/export_diagram", { body: { success: true, data } });

    const result = await mcp.call("export_diagram", { path: "/tmp/d.png" });

    expect(result.content).toEqual([
      {
        type: "text",
        text: '{"diagram":"D1","format":"png","width":640,"height":480,"bytes":1234,"mimeType":"image/png"}',
      },
    ]);
  });

  it("lists a shorter schema of its own with every parameter", async () => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === "export_diagram")!;
    const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;

    expect(tool.description).toBe(EXPORT_DIAGRAM_DESCRIPTION);
    expect(Object.keys(properties)).toEqual(["diagram", "format", "scale", "background", "path"]);
    expect(properties.background).toEqual({
      description: "CSS colour, e.g. #fff; default transparent.",
    });
    // The bounds are left to the check against the whole request schema.
    expect(properties.scale).toEqual({
      description: "PNG/JPEG pixels per unit, up to 4; default 1.",
    });
  });

  it("checks the colour against the manifest's pattern before sending", async () => {
    const result = await mcp.call("export_diagram", { background: "url(x)" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "INVALID_ARGUMENT", endpoint: "/export_diagram" },
    });
    expect(text(result)).toMatch(/^Failed to export diagram: background: /);
    expect(extension.requests).toEqual([]);
  });

  it("returns an image reached through call_endpoint as an image block", async () => {
    extension.reply("/export_diagram", {
      body: { success: true, data: { ...meta, mimeType: "image/png", base64: "iVBORw0KGgo=" } },
    });

    const result = await mcp.call("call_endpoint", { name: "export_diagram", body: {} });

    expect(result.content[0]).toEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
  });
});
