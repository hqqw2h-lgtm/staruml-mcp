import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST, listedRequestSchema, toolName } from "../src/manifest.js";
import { createServer, type ServerConfig } from "../src/server.js";
import { parseToolSelection } from "../src/tiers.js";
import { closedPort, UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";
import { invalidArgs, sampleArgs, withExplicitDefaults } from "./support/schema.js";

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

const json = (value: unknown): string => JSON.stringify(value);
const ok = [{ type: "text", text: "ok" }];
const textContent = (value: string) => [{ type: "text", text: value }];
/** An element summary as extension 0.3.0 returns it; null fields are pruned from results. */
const summary = { _id: "E1", _type: "UMLClass", name: null, _parent: "P1" };

const cases: ToolCase[] = [
  {
    tool: "generate_diagram",
    upstream: "builtin",
    args: { code: "flowchart LR\n  A --> B" },
    slug: "/generate_diagram",
    body: { code: "flowchart LR\n  A --> B" },
    data: undefined,
    content: ok,
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
    content: textContent(json([{ id: "D1", type: "UMLClassDiagram", name: "Main" }])),
    action: "get all diagrams info",
  },
  {
    tool: "get_current_diagram_info",
    upstream: "builtin",
    args: {},
    slug: "/get_current_diagram_info",
    body: {},
    data: { id: "D1", name: "Main" },
    content: textContent(json({ id: "D1", name: "Main" })),
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
];

/**
 * Every endpoint with a tool of its own (`--tools all`); /introspect is listed as the summary
 * tool, tested in tiers.test.ts.
 */
const ENDPOINTS = BUNDLED_MANIFEST.endpoints.filter((e) => e.path !== "/introspect");

/** Arguments for endpoints whose sample from the schema is refused before it is sent. */
const ARGS: Record<string, Record<string, unknown>> = {
  // An op path must name an endpoint of the manifest (src/batch.ts).
  "/batch": { ops: [{ path: "/find_elements" }] },
};

/**
 * Invalid arguments for tools that list a shorter schema than the manifest's; their schema
 * sample would pass the listing and be refused by the check against the whole schema instead.
 */
const INVALID: Record<string, Record<string, unknown>> = {
  "/build_diagram": { name: 5 },
  "/export_diagram": { format: "gif" },
  "/find_elements": { type: 5 },
  "/update_element": { ref: 5 },
  "/search_types": { query: 5 },
  "/describe_diagram": { diagram: 5 },
  "/validate_model": { scope: 5 },
  "/build_model": {},
  "/apply_pattern": { pattern: 5 },
};

/** Endpoints listed with a hand-written schema, tested in their own files. */
const SHORT = new Set([
  "/batch",
  "/get_element_by_id",
  "/delete_element",
  "/lint_diagram",
  "/build_diagram",
  "/export_diagram",
  "/find_elements",
  "/update_element",
  "/search_types",
  "/describe_diagram",
  "/validate_model",
  "/build_model",
  "/apply_pattern",
]);

/** One case per manifest endpoint: required arguments only, an element summary as the answer. */
const generated: ToolCase[] = ENDPOINTS.map((entry) => {
  const args = ARGS[entry.path] ?? sampleArgs(entry.request);
  return {
    tool: toolName(entry.path),
    upstream: "extension",
    args,
    slug: entry.path,
    body: args,
    data: summary,
    content: textContent('{"_id":"E1","_type":"UMLClass","_parent":"P1"}'),
    action: toolName(entry.path).replaceAll("_", " "),
    invalid: INVALID[entry.path] ?? invalidArgs(listedRequestSchema(entry).schema),
  };
});

const all = [...cases, ...generated];

const UNDESCRIBED = new Set([
  "set_editor_state.gridVisible",
  "set_editor_state.snapToGrid",
  "diff_diagram.mermaid",
  "diff_diagram.format",
  "list_patterns.category",
  "describe_pattern.variant",
  "apply_preset.dryRun",
  "apply_theme.dryRun",
  "derive_diagrams.dryRun",
  "apply_style_profile.dryRun",
  "improve_diagram.dryRun",
]);

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

function fixtureFor(upstream: Upstream): UpstreamFixture {
  return upstream === "builtin" ? builtin : extension;
}

/** A server listing every endpoint as a tool. */
const connectAll = (config: ServerConfig) =>
  connect({ ...config, catalog: new CatalogState(undefined, parseToolSelection("all")) });

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  mcp = await connectAll({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
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
  it("lists the built-in tools and, with --tools all, one tool per manifest endpoint", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "doctor",
        "generate_diagram",
        "get_all_diagrams_info",
        "get_current_diagram_info",
        "get_diagram_image_by_id",
        "view_diagram",
        "diagram_as_text",
        ...BUNDLED_MANIFEST.endpoints.map((e) => toolName(e.path)),
      ].sort(),
    );
    expect(BUNDLED_MANIFEST.endpoints).toHaveLength(88);
  });

  it("lists no $schema on any input schema", async () => {
    const { tools } = await mcp.client.listTools();
    for (const tool of tools) expect(tool.inputSchema, tool.name).not.toHaveProperty("$schema");
  });

  it("describes every tool, generated ones included, in one line of at most 100 characters", async () => {
    const { tools } = await mcp.client.listTools();
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/^[^\n]{1,100}$/);
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [name, schema] of Object.entries(properties)) {
        const label = `${tool.name}.${name}`;
        // Extension 0.3.0 leaves these undescribed; their names say what they do.
        if (UNDESCRIBED.has(label)) expect(schema.description, label).toBeUndefined();
        else expect(schema.description, label).toMatch(/^[^\n]+$/);
      }
    }
  });

  // SHORT endpoints list shorter schemas of their own (tests/batch.test.ts, build-diagram.test.ts,
  // and reads.test.ts).
  it.each(ENDPOINTS.filter((e) => !SHORT.has(e.path)))(
    "lists $path's request schema as the manifest defines it",
    async (entry) => {
      const { tools } = await mcp.client.listTools();
      const tool = tools.find((t) => t.name === toolName(entry.path))!;

      const listed = tool.inputSchema as Record<string, unknown>;
      // A loose root lists no additionalProperties (manifest.ts untrivial).
      expect(listed).toEqual(withExplicitDefaults(listedRequestSchema(entry).schema));
    },
  );

  it.each(BUNDLED_MANIFEST.endpoints)("annotates $path from its manifest flags", async (entry) => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === toolName(entry.path))!;

    expect(tool.annotations).toEqual(
      entry.readOnly
        ? { readOnlyHint: true, openWorldHint: false }
        : { readOnlyHint: false, destructiveHint: entry.destructive, openWorldHint: false },
    );
  });

  it("marks the destructive endpoints of extension 0.3.0", async () => {
    const { tools } = await mcp.client.listTools();
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive.sort()).toEqual([
      "batch",
      "delete_element",
      "execute_command",
      "export_diagram",
      "export_diagrams",
      "export_html",
      "export_pdf",
      "generate_code",
      "new_project",
      "open_project",
      "redo",
      "restore_snapshot",
      "save_project",
      "save_project_as",
      "set_documentation",
      "set_stereotype",
      "undo",
      "update_element",
    ]);
  });

  it("tells clients how results are shaped", () => {
    expect(mcp.client.getInstructions()).toMatch(/without null or empty fields/);
  });

  it("uses default name and version without config", async () => {
    const server = createServer();
    expect(server.server).toBeDefined();
    await server.close();
  });
});

describe.each(all)("$tool", (c) => {
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

describe.each(all.filter((c) => c.invalid !== undefined))("$tool input schema", (c) => {
  it("rejects invalid arguments without calling StarUML", async () => {
    const result = await mcp.call(c.tool, c.invalid);

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Input validation error/);
    expect(builtin.requests).toEqual([]);
    expect(extension.requests).toEqual([]);
  });
});

describe("extension 0.3.0 contract", () => {
  it("find_elements passes paging and projection through and keeps the page compact", async () => {
    extension.reply("/find_elements", {
      body: {
        success: true,
        data: {
          count: 3,
          elements: [
            { _id: "C1", _type: "UMLClass", name: "A", _parent: "M1", attributes: [] },
            { _id: "C2", _type: "UMLClass", name: "B", _parent: "M1", attributes: [] },
          ],
          nextCursor: "2",
        },
      },
    });
    const args = {
      type: "UMLClass",
      limit: 2,
      cursor: "0",
      fields: ["name", "attributes"],
      depth: 1,
      summary: false,
    };

    const result = await mcp.call("find_elements", args);

    expect(extension.requests[0]!.body).toEqual(args);
    expect(text(result)).toBe(
      '{"count":3,"elements":[{"_id":"C1","_type":"UMLClass","name":"A","_parent":"M1"},{"_id":"C2","_type":"UMLClass","name":"B","_parent":"M1"}],"nextCursor":"2"}',
    );
  });

  it("find_elements drops the null nextCursor and empty list of a miss", async () => {
    extension.reply("/find_elements", {
      body: { success: true, data: { count: 0, elements: [], nextCursor: null } },
    });

    expect(text(await mcp.call("find_elements", { name: "Nope" }))).toBe('{"count":0}');
  });

  it("create_element_with_view returns the view and model summaries", async () => {
    extension.reply("/create_element_with_view", {
      body: {
        success: true,
        data: {
          view: { _id: "V1", _type: "UMLClassView", name: null, _parent: "D1" },
          model: { _id: "C1", _type: "UMLClass", name: "Order", _parent: "M1" },
        },
      },
    });

    const result = await mcp.call("create_element_with_view", {
      type: "UMLClass",
      diagram: "D1",
      name: "Order",
      x: 10,
      y: 20,
    });

    expect(text(result)).toBe(
      '{"view":{"_id":"V1","_type":"UMLClassView","_parent":"D1"},"model":{"_id":"C1","_type":"UMLClass","name":"Order","_parent":"M1"}}',
    );
  });

  it("drops arguments the manifest does not define before calling the extension", async () => {
    extension.reply("/route_edges", { body: { success: true, data: {} } });

    await mcp.call("route_edges", { lineStyle: "curve", bogus: true });

    expect(extension.requests[0]!.body).toEqual({ lineStyle: "curve" });
  });

  it("forwards the unlisted projection of a writing tool", async () => {
    extension.reply("/set_documentation", { body: { success: true, data: summary } });
    const args = { ref: "E1", documentation: "Doc.", fields: ["documentation"], depth: 0 };

    await mcp.call("set_documentation", args);

    expect(extension.requests[0]!.body).toEqual(args);
  });

  it("lists the projection on no tool and forwards it from a read-only one", async () => {
    const { tools } = await mcp.client.listTools();
    const withProjection = tools.filter((t) =>
      ["summary", "fields", "depth"].some((p) => (t.inputSchema.properties ?? {})[p] !== undefined),
    );
    expect(withProjection.map((t) => t.name)).toEqual([]);

    extension.reply("/get_element_by_id", { body: { success: true, data: summary } });
    const args = { ref: "E1", fields: ["documentation"], depth: 1, summary: false };
    await mcp.call("get_element_by_id", args);
    expect(extension.requests[0]!.body).toEqual(args);
  });

  it("rejects a wrong-typed field before the extension sees it", async () => {
    const result = await mcp.call("get_views_of", { ref: 10 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Input validation error/);
    expect(extension.requests).toEqual([]);
  });

  it.each([
    ["NOT_FOUND", 404, "Element not found: X"],
    ["NO_PROJECT", 409, "No project is open"],
    ["STARUML_ERROR", 422, "Invalid connection (UMLGeneralization)"],
    ["INVALID_ARGUMENT", 400, "id: Invalid input: expected string, received number"],
  ])("surfaces %s (HTTP %d) with its code and status", async (code, status, error) => {
    extension.reply("/create_relationship", { status, body: { success: false, code, error } });

    const result = await mcp.call("create_relationship", {
      type: "UMLGeneralization",
      tail: "A",
      head: "B",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `Failed to create relationship: ${error} [${code}, /create_relationship, HTTP ${status}]`,
    );
    expect(result.structuredContent).toEqual({
      error: {
        code,
        message: error,
        endpoint: "/create_relationship",
        upstream: "extension",
        status,
      },
    });
  });

  it("reports UNKNOWN_ENDPOINT with an upgrade hint", async () => {
    extension.reply("/add_tag", {
      status: 404,
      body: { success: false, code: "UNKNOWN_ENDPOINT", error: "No handler for /add_tag" },
    });

    const result = await mcp.call("add_tag", {
      ref: "E1",
      name: "n",
      kind: "string",
      value: "v",
    });

    expect(result.structuredContent).toMatchObject({ error: { code: "UNKNOWN_ENDPOINT" } });
    expect(text(result)).toContain(
      "Hint: The installed staruml-mcp-extension does not provide /add_tag",
    );
  });
});

describe("tool-specific responses", () => {
  it("get_current_diagram_info reports when no diagram is active", async () => {
    builtin.reply("/get_current_diagram_info", { body: { success: true, data: null } });

    const result = await mcp.call("get_current_diagram_info");

    expect(result.content).toEqual(textContent("null"));
  });

  it("execute_command forwards positional args and returns only the command's result", async () => {
    extension.reply("/execute_command", {
      body: { success: true, data: { id: "edit:select-all", result: { selected: 2 } } },
    });

    const result = await mcp.call("execute_command", { id: "edit:select-all", args: [1, "two"] });

    expect(extension.requests[0]!.body).toEqual({ id: "edit:select-all", args: [1, "two"] });
    expect(text(result)).toBe('{"result":{"selected":2}}');
  });

  it("save_project without filename saves in place and reports where", async () => {
    extension.reply("/save_project", { body: { success: true, data: { filename: "/a.mdj" } } });

    const result = await mcp.call("save_project");

    expect(extension.requests[0]!.body).toEqual({});
    expect(text(result)).toBe('{"filename":"/a.mdj"}');
  });

  it("find_elements drops null and empty properties of each element", async () => {
    extension.reply("/find_elements", {
      body: {
        success: true,
        data: {
          count: 1,
          elements: [
            {
              _id: "C1",
              _parent: { _id: "P1", name: "Pkg" },
              name: "A",
              documentation: "",
              stereotype: null,
              tags: [],
              attributes: [{ _id: "A1", name: "id" }],
              isAbstract: false,
            },
          ],
        },
      },
    });

    const result = await mcp.call("find_elements", { type: "UMLClass" });

    expect(text(result)).toBe(
      '{"count":1,"elements":[{"_id":"C1","_parent":{"_id":"P1","name":"Pkg"},"name":"A","documentation":"","attributes":[{"_id":"A1","name":"id"}],"isAbstract":false}]}',
    );
  });

  it("get_diagram_image_by_id rejects a non-string image as INVALID_RESPONSE", async () => {
    builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: 42 } });

    const result = await mcp.call("get_diagram_image_by_id", { diagramId: "D1" });

    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_RESPONSE" } });
  });

  it("reports ENDPOINT_NOT_FOUND with an upgrade hint when the extension lacks an endpoint", async () => {
    const result = await mcp.call("close_diagram", { diagram: "D1" });

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
    both = await connectAll({ apiHost: HOST, apiPort: refused, extPort: refused });
    extOnly = await connectAll({ apiHost: HOST, apiPort: builtin.port, extPort: refused });
  });

  afterAll(async () => {
    await both.close();
    await extOnly.close();
  });

  it.each(all)("$tool reports STARUML_UNREACHABLE when StarUML is not running", async (c) => {
    const result = await both.call(c.tool, c.args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "STARUML_UNREACHABLE", endpoint: c.slug, upstream: c.upstream },
    });
    expect(text(result)).toMatch(/\nHint: Start StarUML 7\.0\.0\+ with its API server enabled/);
  });

  it.each(generated)(
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
