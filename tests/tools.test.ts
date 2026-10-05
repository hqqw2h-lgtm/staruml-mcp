import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { closedPort, UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

type Upstream = "builtin" | "extension";

interface ToolCase {
  tool: string;
  upstream: Upstream;
  args: Record<string, unknown>;
  slug: string;
  body: unknown;
  data: unknown;
  content: unknown[];
  action: string;
  /** Arguments that fail the tool's input schema; absent for tools without required input. */
  invalid?: Record<string, unknown>;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);
const textContent = (value: string) => [{ type: "text", text: value }];
const element = { _id: "E1", _type: "UMLClass", name: "User" };

const cases: ToolCase[] = [
  {
    tool: "generate_diagram",
    upstream: "builtin",
    args: { code: "flowchart LR\n  A --> B" },
    slug: "/generate_diagram",
    body: { code: "flowchart LR\n  A --> B" },
    data: undefined,
    content: textContent("Diagram successfully generated in StarUML."),
    action: "generate diagram",
    invalid: { code: "" },
  },
  {
    tool: "get_all_diagrams_info",
    upstream: "builtin",
    args: {},
    slug: "/get_all_diagrams_info",
    body: {},
    data: [{ id: "D1", type: "UMLClassDiagram", name: "Main" }],
    content: textContent(
      `Diagrams: ${json([{ id: "D1", type: "UMLClassDiagram", name: "Main" }])}`,
    ),
    action: "get all diagrams info",
  },
  {
    tool: "get_current_diagram_info",
    upstream: "builtin",
    args: {},
    slug: "/get_current_diagram_info",
    body: {},
    data: { id: "D1", name: "Main" },
    content: textContent(`Current diagram: ${json({ id: "D1", name: "Main" })}`),
    action: "get current diagram info",
  },
  {
    tool: "get_diagram_image_by_id",
    upstream: "builtin",
    args: { diagramId: "D1" },
    slug: "/get_diagram_image_by_id",
    body: { diagramId: "D1" },
    data: "iVBORw0KGgo=",
    content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    action: "get diagram image",
    invalid: {},
  },
  {
    tool: "get_all_commands",
    upstream: "extension",
    args: {},
    slug: "/get_all_commands",
    body: {},
    data: ["project:save"],
    content: textContent(`Commands: ${json(["project:save"])}`),
    action: "get commands",
  },
  {
    tool: "execute_command",
    upstream: "extension",
    args: { id: "view:fit-to-window" },
    slug: "/execute_command",
    body: { id: "view:fit-to-window", args: [] },
    data: { executed: "view:fit-to-window" },
    content: textContent(`Executed: ${json({ executed: "view:fit-to-window" })}`),
    action: "execute command",
    invalid: { id: 7 },
  },
  {
    tool: "get_project_info",
    upstream: "extension",
    args: {},
    slug: "/get_project_info",
    body: {},
    data: { filename: "/tmp/a.mdj" },
    content: textContent(json({ filename: "/tmp/a.mdj" })),
    action: "get project info",
  },
  {
    tool: "save_project",
    upstream: "extension",
    args: { filename: "/tmp/a.mdj" },
    slug: "/save_project",
    body: { filename: "/tmp/a.mdj" },
    data: { filename: "/tmp/a.mdj" },
    content: textContent(`Saved: ${JSON.stringify({ filename: "/tmp/a.mdj" })}`),
    action: "save project",
    invalid: { filename: 1 },
  },
  {
    tool: "save_project_as",
    upstream: "extension",
    args: { filename: "/tmp/b.mdj" },
    slug: "/save_project_as",
    body: { filename: "/tmp/b.mdj" },
    data: { filename: "/tmp/b.mdj" },
    content: textContent(`Saved as: ${JSON.stringify({ filename: "/tmp/b.mdj" })}`),
    action: "save project as",
    invalid: { filename: "" },
  },
  {
    tool: "new_project",
    upstream: "extension",
    args: {},
    slug: "/new_project",
    body: {},
    data: null,
    content: textContent("New project created."),
    action: "create new project",
  },
  {
    tool: "open_project",
    upstream: "extension",
    args: { filename: "/tmp/c.mdj" },
    slug: "/open_project",
    body: { filename: "/tmp/c.mdj" },
    data: { filename: "/tmp/c.mdj" },
    content: textContent(`Opened: ${JSON.stringify({ filename: "/tmp/c.mdj" })}`),
    action: "open project",
    invalid: {},
  },
  {
    tool: "get_element_by_id",
    upstream: "extension",
    args: { id: "E1" },
    slug: "/get_element_by_id",
    body: { id: "E1" },
    data: element,
    content: textContent(json(element)),
    action: "get element",
    invalid: { id: "" },
  },
  {
    tool: "find_elements",
    upstream: "extension",
    args: { type: "UMLClass", name: "User" },
    slug: "/find_elements",
    body: { type: "UMLClass", name: "User" },
    data: { count: 1, elements: [element] },
    content: textContent(json({ count: 1, elements: [element] })),
    action: "find elements",
    invalid: { type: 3 },
  },
  {
    tool: "create_element",
    upstream: "extension",
    args: { type: "UMLClass", parentId: "M1", name: "User" },
    slug: "/create_element",
    body: { type: "UMLClass", parentId: "M1", name: "User" },
    data: element,
    content: textContent(`Created: ${json(element)}`),
    action: "create element",
    invalid: { type: "UMLClass" },
  },
  {
    tool: "create_element_with_view",
    upstream: "extension",
    args: {
      type: "UMLActor",
      parentId: "M1",
      diagramId: "D1",
      name: "A",
      x: 1,
      y: 2,
      x2: 3,
      y2: 4,
    },
    slug: "/create_element_with_view",
    body: {
      type: "UMLActor",
      parentId: "M1",
      diagramId: "D1",
      name: "A",
      x: 1,
      y: 2,
      x2: 3,
      y2: 4,
    },
    data: { view: { _id: "V1" }, model: { _id: "E2" } },
    content: textContent(`Created: ${json({ view: { _id: "V1" }, model: { _id: "E2" } })}`),
    action: "create element with view",
    invalid: { type: "UMLActor", parentId: "M1", diagramId: "D1", x: "left" },
  },
  {
    tool: "create_edge_with_view",
    upstream: "extension",
    args: {
      type: "UMLAssociation",
      parentId: "M1",
      diagramId: "D1",
      tailViewId: "V1",
      headViewId: "V2",
      y: 120,
    },
    slug: "/create_edge_with_view",
    body: {
      type: "UMLAssociation",
      parentId: "M1",
      diagramId: "D1",
      tailViewId: "V1",
      headViewId: "V2",
      y: 120,
    },
    data: { view: { _id: "V3" } },
    content: textContent(`Created edge: ${json({ view: { _id: "V3" } })}`),
    action: "create edge",
    invalid: { type: "UMLAssociation", parentId: "M1", diagramId: "D1", tailViewId: "V1" },
  },
  {
    tool: "update_element",
    upstream: "extension",
    args: { id: "E1", field: "name", value: "Account" },
    slug: "/update_element",
    body: { id: "E1", field: "name", value: "Account" },
    data: { ...element, name: "Account" },
    content: textContent(json({ ...element, name: "Account" })),
    action: "update element",
    invalid: { id: "E1", field: "" },
  },
  {
    tool: "delete_element",
    upstream: "extension",
    args: { id: "E1" },
    slug: "/delete_element",
    body: { id: "E1" },
    data: { deleted: "E1", models_deleted: 1, views_deleted: 0 },
    content: textContent(JSON.stringify({ deleted: "E1", models_deleted: 1, views_deleted: 0 })),
    action: "delete element",
    invalid: {},
  },
  {
    tool: "create_diagram",
    upstream: "extension",
    args: { type: "UMLClassDiagram", parentId: "M1", name: "Domain" },
    slug: "/create_diagram",
    body: { type: "UMLClassDiagram", parentId: "M1", name: "Domain" },
    data: { _id: "D2" },
    content: textContent(`Created diagram: ${json({ _id: "D2" })}`),
    action: "create diagram",
    invalid: { type: "UMLClassDiagram" },
  },
  {
    tool: "switch_diagram",
    upstream: "extension",
    args: { id: "D1" },
    slug: "/switch_diagram",
    body: { id: "D1" },
    data: { _id: "D1" },
    content: textContent(JSON.stringify({ _id: "D1" })),
    action: "switch diagram",
    invalid: { id: "" },
  },
  {
    tool: "close_diagram",
    upstream: "extension",
    args: { id: "D1" },
    slug: "/close_diagram",
    body: { id: "D1" },
    data: { _id: "D1" },
    content: textContent(JSON.stringify({ _id: "D1" })),
    action: "close diagram",
    invalid: {},
  },
];

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

function fixtureFor(upstream: Upstream): UpstreamFixture {
  return upstream === "builtin" ? builtin : extension;
}

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

describe("tool registry", () => {
  it("registers exactly the documented tools", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(cases.map((c) => c.tool).sort());
  });

  it("uses default name and version without config", async () => {
    const server = createServer();
    expect(server.server).toBeDefined();
    await server.close();
  });
});

describe.each(cases)("$tool", (c) => {
  it("posts the expected body and returns the expected content", async () => {
    fixtureFor(c.upstream).reply(c.slug, { body: { success: true, data: c.data } });

    const result = await mcp.call(c.tool, c.args);

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual(c.content);
    expect(fixtureFor(c.upstream).requests).toEqual([
      { method: "POST", path: c.slug, body: c.body },
    ]);
  });

  it("surfaces the JSON error body of an HTTP 400 with a structured code", async () => {
    fixtureFor(c.upstream).reply(c.slug, {
      status: 400,
      body: { success: false, error: "Required field 'x' missing" },
    });

    const result = await mcp.call(c.tool, c.args);

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `Failed to ${c.action}: Required field 'x' missing [REQUEST_REJECTED, ${c.slug}, HTTP 400]`,
    );
    expect(result.structuredContent).toEqual({
      error: {
        code: "REQUEST_REJECTED",
        message: "Required field 'x' missing",
        endpoint: c.slug,
        upstream: c.upstream,
        status: 400,
      },
    });
  });

  it("maps success:false on HTTP 200 to an error result", async () => {
    fixtureFor(c.upstream).reply(c.slug, {
      body: { success: false, error: "Element not found: X", code: "NOT_FOUND" },
    });

    const result = await mcp.call(c.tool, c.args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "NOT_FOUND", message: "Element not found: X", status: 200 },
    });
  });
});

describe.each(cases.filter((c) => c.invalid !== undefined))("$tool input schema", (c) => {
  it("rejects invalid arguments without calling StarUML", async () => {
    const result = await mcp.call(c.tool, c.invalid);

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Input validation error/);
    expect(builtin.requests).toEqual([]);
    expect(extension.requests).toEqual([]);
  });
});

describe("tool-specific responses", () => {
  it("get_current_diagram_info reports when no diagram is active", async () => {
    builtin.reply("/get_current_diagram_info", { body: { success: true, data: null } });

    const result = await mcp.call("get_current_diagram_info");

    expect(result.content).toEqual(textContent("No diagram is currently active."));
  });

  it("execute_command forwards positional args", async () => {
    extension.reply("/execute_command", { body: { success: true, data: null } });

    await mcp.call("execute_command", { id: "edit:select-all", args: [1, "two"] });

    expect(extension.requests[0]!.body).toEqual({ id: "edit:select-all", args: [1, "two"] });
  });

  it("save_project without filename saves in place", async () => {
    extension.reply("/save_project", { body: { success: true, data: { filename: "/a.mdj" } } });

    await mcp.call("save_project");

    expect(extension.requests[0]!.body).toEqual({});
  });

  it("get_diagram_image_by_id rejects a non-string image as INVALID_RESPONSE", async () => {
    builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: 42 } });

    const result = await mcp.call("get_diagram_image_by_id", { diagramId: "D1" });

    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_RESPONSE" } });
  });

  it("reports ENDPOINT_NOT_FOUND with an upgrade hint when the extension lacks an endpoint", async () => {
    const result = await mcp.call("close_diagram", { id: "D1" });

    expect(result.structuredContent).toMatchObject({
      error: { code: "ENDPOINT_NOT_FOUND", status: 404, message: "No handler for /close_diagram" },
    });
    expect(text(result)).toContain(`Hint: The installed staruml-mcp-extension does not provide`);
  });
});

describe("connectivity failures", () => {
  let refused: number;
  let both: ConnectedClient;
  let extOnly: ConnectedClient;

  beforeAll(async () => {
    refused = await closedPort();
    both = await connect({ apiHost: HOST, apiPort: refused, extPort: refused });
    extOnly = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: refused });
  });

  afterAll(async () => {
    await both.close();
    await extOnly.close();
  });

  it.each(cases)("$tool reports STARUML_UNREACHABLE when StarUML is not running", async (c) => {
    const result = await both.call(c.tool, c.args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "STARUML_UNREACHABLE", endpoint: c.slug, upstream: c.upstream },
    });
    expect(text(result)).toMatch(/\nHint: Start StarUML 7\.0\.0\+ with its API server enabled/);
  });

  it.each(cases.filter((c) => c.upstream === "extension"))(
    "$tool reports EXTENSION_UNREACHABLE when only the extension is missing",
    async (c) => {
      const result = await extOnly.call(c.tool, c.args);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "EXTENSION_UNREACHABLE", endpoint: c.slug, upstream: "extension" },
      });
      expect(text(result)).toContain(`nothing answers at ${HOST}:${refused}`);
      expect(text(result)).toContain("Hint: Install staruml-mcp-extension");
    },
  );
});
