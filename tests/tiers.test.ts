import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bundledCatalog,
  CatalogState,
  describe as describeEndpoints,
  tierCheck,
  unlistedTools,
} from "../src/extension-tools.js";
import {
  BUNDLED_MANIFEST,
  compileManifest,
  listedRequestSchema,
  terseDescription,
  toolName,
  withoutTrivialKeywords,
} from "../src/manifest.js";
import {
  CORE_ENDPOINTS,
  endpointGroup,
  ENDPOINT_GROUPS,
  parseToolSelection,
  selects,
} from "../src/tiers.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

const summary = { _id: "D9", _type: "UMLClassDiagram", name: "Main", _parent: "M1" };
const entryOf = (name: string) => BUNDLED_MANIFEST.endpoints.find((e) => e.path === `/${name}`)!;

/** The endpoints of extension 0.3.0 that only call_endpoint reaches under the core tier. */
const EXTENDED: string[] = BUNDLED_MANIFEST.endpoints
  .map((e) => toolName(e.path))
  .filter((n) => !CORE_ENDPOINTS.includes(n));

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

describe("parseToolSelection", () => {
  it("expands core to the core endpoints", () => {
    expect(parseToolSelection("core")).toEqual({
      all: false,
      names: new Set(CORE_ENDPOINTS),
      label: "core",
      closed: false,
      reachable: new Set(),
    });
  });

  it("reads all, names and core mixed, ignoring blanks and spaces", () => {
    expect(parseToolSelection("all").all).toBe(true);
    const mixed = parseToolSelection(" core , create_diagram,,");
    expect(mixed.label).toBe("core,create_diagram");
    expect([...mixed.names]).toEqual([...CORE_ENDPOINTS, "create_diagram"]);
  });

  it.each(["", " , ", "Create", "a-b", "core;all"])("rejects %j", (value) => {
    expect(() => parseToolSelection(value)).toThrow(`Invalid --tools: "${value}".`);
  });

  it("reads a token named like an Object.prototype member as a tool name", () => {
    // An object literal of tiers read `constructor` from its prototype (tests/properties.test.ts).
    for (const token of ["constructor", "tostring", "valueof", "hasownproperty"]) {
      expect([...parseToolSelection(token).names]).toEqual([token]);
    }
    expect([...parseToolSelection("oo,constructor").names]).toContain("constructor");
  });

  it("closes the oo tier unless core or all is given too", () => {
    expect(parseToolSelection("oo").closed).toBe(true);
    expect(parseToolSelection("oo,save_project").closed).toBe(true);
    expect(parseToolSelection("oo,core").closed).toBe(false);
    expect(parseToolSelection("all,oo").closed).toBe(false);
    expect(parseToolSelection("save_project").closed).toBe(false);
    expect(parseToolSelection("core").reachable.size).toBe(0);
  });

  it("names the source of the value", () => {
    expect(() => parseToolSelection("?", "tools")).toThrow('Invalid tools: "?".');
  });

  it("selects every name under all, listed names otherwise", () => {
    expect(selects(parseToolSelection("all"), "anything")).toBe(true);
    expect(selects(parseToolSelection("save_project"), "save_project")).toBe(true);
    expect(selects(parseToolSelection("save_project"), "new_project")).toBe(false);
  });
});

describe("endpointGroup", () => {
  it("groups every endpoint of the 103-endpoint manifest", () => {
    const groups: Record<string, string[]> = {};
    for (const e of BUNDLED_MANIFEST.endpoints) {
      (groups[endpointGroup(toolName(e.path))] ??= []).push(toolName(e.path));
    }
    expect(groups).toEqual({
      command: ["get_all_commands", "describe_commands", "execute_command"],
      project: [
        "get_project_info",
        "save_project",
        "save_project_as",
        "new_project",
        "open_project",
        "list_templates",
        "new_from_template",
        "get_project_metadata",
        "set_project_metadata",
        "get_preference",
        "set_preference",
        "list_extensions",
        "list_working_diagrams",
        "close_diagrams",
        "is_modified",
      ],
      io: ["export_fragment", "import_fragment", "export_xmi", "import_xmi"],
      perf: ["performance_stats"],
      element: [
        "quick_find",
        "get_element_by_id",
        "find_elements",
        "create_element",
        "update_element",
        "delete_element",
        "create_relationship",
        "set_stereotype",
        "set_documentation",
        "get_relationships_of",
        "get_refs_to",
        "batch",
      ],
      diagram: [
        "create_element_with_view",
        "create_edge_with_view",
        "create_diagram",
        "switch_diagram",
        "close_diagram",
        "get_views_of",
        "get_edge_views_of",
        "get_connected_node_views",
        "layout_diagram",
        "route_edges",
        "move_views",
        "resize_node",
        "set_z_order",
        "divide_fragment",
        "create_view_of",
        "export_diagram",
        "export_diagrams",
        "export_pdf",
        "export_html",
        "export_text",
        "build_diagram",
        "describe_diagram",
      ],
      feature: [
        "add_attribute",
        "add_operation",
        "add_parameter",
        "add_enumeration_literal",
        "add_template_parameter",
        "add_slot",
        "add_tag",
      ],
      style: [
        "set_view_style",
        "apply_theme",
        "get_style_profile",
        "set_style_profile",
        "apply_style_profile",
        "explain_style_violation",
      ],
      editor: ["get_selection", "set_selection", "get_editor_state", "set_editor_state"],
      code: ["list_code_generators", "generate_code", "reverse_code"],
      history: ["undo", "redo", "snapshot", "diff_since", "restore_snapshot"],
      meta: ["search_types", "describe_type", "introspect", "debug"],
      quality: [
        "validate_model",
        "lint_diagram",
        "uml_lint",
        "diff_diagram",
        "model_lint",
        "diagram_quality",
        "improve_diagram",
      ],
      model: [
        "build_model",
        "sync_operations",
        "check_messages",
        "derive_diagrams",
        "explain_model",
      ],
      patterns: [
        "list_patterns",
        "describe_pattern",
        "apply_pattern",
        "detect_patterns",
        "apply_preset",
      ],
    });
  });

  it("places endpoints of a newer extension in a group", () => {
    expect(endpointGroup("export_sequence_diagram")).toBe("diagram");
    expect(endpointGroup("merge_elements")).toBe("element");
    expect(endpointGroup("explain_pattern")).toBe("patterns");
    expect(endpointGroup("set_font")).toBe("style");
    expect(endpointGroup("derive_operations")).toBe("model");
    expect(endpointGroup("reset_style_profile")).toBe("style");
    expect(endpointGroup("reset_preferences")).toBe("project");
    expect(ENDPOINT_GROUPS).toEqual([
      "quality",
      "history",
      "io",
      "perf",
      "project",
      "command",
      "meta",
      "patterns",
      "model",
      "style",
      "feature",
      "editor",
      "code",
      "diagram",
      "element",
    ]);
  });
});

describe("core tier (default)", () => {
  it("lists the built-in tools, the core endpoints and the two generic tools", async () => {
    const { tools } = await mcp.client.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      "generate_diagram",
      "get_all_diagrams_info",
      "get_current_diagram_info",
      "get_diagram_image_by_id",
      "view_diagram",
      "diagram_as_text",
      "doctor",
      "get_element_by_id",
      "find_elements",
      "update_element",
      "export_diagram",
      "batch",
      "build_diagram",
      "build_model",
      "diagram_quality",
      "improve_diagram",
      "describe_endpoints",
      "call_endpoint",
    ]);
  });

  it("describes every tool in one line of at most 100 characters", async () => {
    const { tools } = await mcp.client.listTools();
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/^[^\n]{1,100}$/);
      expect(tool.inputSchema, tool.name).not.toHaveProperty("$schema");
    }
  });

  it("costs at most 2,000 definition tokens with the instructions", async () => {
    const { tools } = await mcp.client.listTools();
    const forwarded = tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));

    const tokens =
      countTokens(JSON.stringify(forwarded)) + countTokens(mcp.client.getInstructions()!);

    expect(tokens).toBeLessThanOrEqual(2000);
  });

  it("points to the generic tools in the instructions", () => {
    expect(mcp.client.getInstructions()).toContain(
      "Endpoints without a tool: describe_endpoints, then call_endpoint.",
    );
  });

  it("does not list an extended endpoint as a tool", async () => {
    const result = await mcp.call("create_diagram", { type: "UMLClassDiagram" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Tool create_diagram not found/);
    expect(extension.requests).toEqual([]);
  });
});

describe("introspect (summary)", () => {
  const data = {
    staruml: { version: "7.1.1", apiVersion: "7.1.1" },
    extension: { name: "staruml-mcp-extension", version: "0.3.0" },
  };
  // Listed only when named since 0.6.0.
  let mcp: ConnectedClient;

  beforeAll(async () => {
    mcp = await connect({
      apiHost: HOST,
      apiPort: builtin.port,
      extPort: extension.port,
      catalog: new CatalogState(undefined, parseToolSelection("core,introspect")),
    });
  });

  afterAll(async () => {
    await mcp.close();
  });

  it.each([
    ["versions only by default", {}, { include: [] }],
    [
      "the metamodel when types are given",
      { types: ["UMLClass"] },
      { types: ["UMLClass"], include: ["metamodel"] },
    ],
    [
      "the sections asked for",
      { include: ["factory", "toolbox"], inherited: true },
      { include: ["factory", "toolbox"], inherited: true },
    ],
  ])("asks for %s", async (_, args, body) => {
    extension.reply("/introspect", { body: { success: true, data } });

    const result = await mcp.call("introspect", args);

    expect(extension.requests.map((r) => r.body)).toEqual([body]);
    expect(text(result)).toBe(JSON.stringify(data));
  });

  it.each([
    ["versions only by default", {}, { include: [] }],
    [
      "the metamodel when types are given",
      { types: ["T"] },
      { types: ["T"], include: ["metamodel"] },
    ],
    ["the sections asked for", { include: ["toolbox"] }, { include: ["toolbox"] }],
  ])("gives call_endpoint the same defaults: %s", async (_, body, sent) => {
    const core = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
    extension.reply("/introspect", { body: { success: true, data } });

    const result = await core.call("call_endpoint", { name: "introspect", body });
    await core.close();

    expect(extension.requests.map((r) => r.body)).toEqual([sent]);
    expect(text(result)).toBe(JSON.stringify(data));
  });

  it("checks a call_endpoint body against the manifest before applying the defaults", async () => {
    const result = await mcp.call("call_endpoint", {
      name: "introspect",
      body: { include: ["nope"] },
    });

    expect(result.isError).toBe(true);
    expect(extension.requests).toEqual([]);
  });

  it("does not offer the endpoint manifest section", async () => {
    const result = await mcp.call("introspect", { include: ["endpoints"] });

    expect(text(result)).toMatch(/Input validation error/);
    expect(extension.requests).toEqual([]);
  });

  it("keeps the manifest's read-only annotation", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.find((t) => t.name === "introspect")!.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });
});

describe("describe_endpoints", () => {
  it("indexes the endpoints without a tool by group, one line each", async () => {
    const result = await mcp.call("describe_endpoints");

    const index = JSON.parse(text(result)) as Record<string, Record<string, string>>;
    expect(
      Object.values(index)
        .flatMap((g) => Object.keys(g))
        .sort(),
    ).toEqual([...EXTENDED].sort());
    expect(index.project!.save_project).toBe(terseDescription(entryOf("save_project").description));
    // introspect and search_types left the core tier in 0.6.0.
    expect(Object.keys(index.meta!)).toEqual([
      "search_types",
      "describe_type",
      "introspect",
      "debug",
    ]);
    expect(Object.keys(index.patterns!)).toEqual([
      "list_patterns",
      "describe_pattern",
      "apply_pattern",
      "detect_patterns",
      "apply_preset",
    ]);
    expect(Object.keys(index.model!)).toEqual([
      "sync_operations",
      "check_messages",
      "derive_diagrams",
      "explain_model",
    ]);
    expect(Object.keys(index.style!)).toEqual([
      "set_view_style",
      "apply_theme",
      "get_style_profile",
      "set_style_profile",
      "apply_style_profile",
      "explain_style_violation",
    ]);
  });

  it("describes named endpoints in full, listed ones included", async () => {
    const result = await mcp.call("describe_endpoints", {
      names: ["create_edge_with_view", "find_elements", "save_project"],
    });

    expect(JSON.parse(text(result))).toEqual({
      create_edge_with_view: {
        description: entryOf("create_edge_with_view").description,
        request: withoutTrivialKeywords(
          listedRequestSchema(entryOf("create_edge_with_view")).schema,
        ),
      },
      find_elements: {
        description: entryOf("find_elements").description,
        readOnly: true,
        request: withoutTrivialKeywords(listedRequestSchema(entryOf("find_elements")).schema),
      },
      save_project: {
        description: entryOf("save_project").description,
        destructive: true,
        request: withoutTrivialKeywords(listedRequestSchema(entryOf("save_project")).schema),
      },
    });
    expect(text(result)).not.toContain("propertyNames");
  });

  it("describes every endpoint of a group that has no tool", async () => {
    const result = await mcp.call("describe_endpoints", { group: "element" });

    expect(Object.keys(JSON.parse(text(result)) as object)).toEqual([
      "quick_find",
      "create_element",
      "delete_element",
      "create_relationship",
      "set_stereotype",
      "set_documentation",
      "get_relationships_of",
      "get_refs_to",
    ]);
  });

  it("describes the checks and the history in groups of their own", async () => {
    const group = async (name: string) =>
      Object.keys(
        JSON.parse(text(await mcp.call("describe_endpoints", { group: name }))) as object,
      );

    // diagram_quality and improve_diagram are core tools, so the group lists the rest.
    expect(await group("quality")).toEqual([
      "validate_model",
      "lint_diagram",
      "uml_lint",
      "diff_diagram",
      "model_lint",
    ]);
    expect(await group("history")).toEqual([
      "undo",
      "redo",
      "snapshot",
      "diff_since",
      "restore_snapshot",
    ]);
  });

  it("combines names and a group", async () => {
    const result = await mcp.call("describe_endpoints", { names: ["debug"], group: "command" });

    expect(Object.keys(JSON.parse(text(result)) as object)).toEqual([
      "debug",
      "get_all_commands",
      "describe_commands",
      "execute_command",
    ]);
  });

  it("reports an unknown name with UNKNOWN_ENDPOINT", async () => {
    const result = await mcp.call("describe_endpoints", { names: ["create_diagramm"] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "UNKNOWN_ENDPOINT",
        message: 'No endpoint "create_diagramm" in staruml-mcp-extension 0.3.0',
        hint: "describe_endpoints() lists the endpoints.",
      },
    });
  });

  it("rejects a group that does not exist", async () => {
    const result = await mcp.call("describe_endpoints", { group: "nope" });

    expect(text(result)).toMatch(/Input validation error/);
  });
});

describe("call_endpoint", () => {
  it("validates, forwards the body and returns the compact result", async () => {
    extension.reply("/create_diagram", { body: { success: true, data: summary } });

    const result = await mcp.call("call_endpoint", {
      name: "create_diagram",
      body: { type: "UMLClassDiagram", parentId: "M1", name: "Main" },
    });

    expect(result.isError).toBeFalsy();
    // parentId is extension 0.3.0's alias of parent, sent under the canonical name.
    expect(extension.requests).toEqual([
      {
        method: "POST",
        path: "/create_diagram",
        body: { type: "UMLClassDiagram", parent: "M1", name: "Main" },
      },
    ]);
    // The name echoes the body and is dropped, as with a dedicated tool.
    expect(text(result)).toBe('{"_id":"D9","_type":"UMLClassDiagram","_parent":"M1"}');
  });

  it("sends {} when the body is left out", async () => {
    extension.reply("/save_project", { body: { success: true, data: { filename: "/a.mdj" } } });

    const result = await mcp.call("call_endpoint", { name: "save_project" });

    expect(extension.requests[0]!.body).toEqual({});
    expect(text(result)).toBe('{"filename":"/a.mdj"}');
  });

  it("accepts the projection a writing endpoint does not list", async () => {
    extension.reply("/set_documentation", { body: { success: true, data: summary } });
    const body = { ref: "Model/Order", documentation: "Doc.", fields: ["documentation"], depth: 0 };

    await mcp.call("call_endpoint", { name: "set_documentation", body });

    expect(extension.requests[0]!.body).toEqual(body);
  });

  it("calls a core endpoint too", async () => {
    extension.reply("/delete_element", { body: { success: true, data: { deleted: "E1" } } });

    const result = await mcp.call("call_endpoint", { name: "delete_element", body: { id: "E1" } });

    expect(text(result)).toBe('{"deleted":"E1"}');
  });

  it.each([
    [
      "a missing required parameter",
      "create_diagram",
      { parentId: "M1" },
      "type: Invalid input: expected string, received undefined",
    ],
    [
      "a wrong type",
      "create_element_with_view",
      { type: "UMLClass", diagramId: "D1", x: "10" },
      "x: Invalid input: expected number, received string",
    ],
    ["an unknown key", "save_project", { file: "/a.mdj" }, 'body: Unrecognized key: "file"'],
  ])(
    "rejects %s with INVALID_ARGUMENT before calling the extension",
    async (_, name, body, message) => {
      const result = await mcp.call("call_endpoint", { name, body });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: "INVALID_ARGUMENT",
          message,
          endpoint: `/${name}`,
          hint: `describe_endpoints({names: ["${name}"]}) shows its schema.`,
        },
      });
      expect(text(result)).toBe(
        `Failed to ${name.replaceAll("_", " ")}: ${message} [INVALID_ARGUMENT, /${name}]\nHint: describe_endpoints({names: ["${name}"]}) shows its schema.`,
      );
      expect(extension.requests).toEqual([]);
    },
  );

  it("reports an unknown endpoint with UNKNOWN_ENDPOINT", async () => {
    const result = await mcp.call("call_endpoint", { name: "build_diagrams", body: {} });

    expect(result.structuredContent).toEqual({
      error: {
        code: "UNKNOWN_ENDPOINT",
        message: 'No endpoint "build_diagrams" in staruml-mcp-extension 0.3.0',
        hint: "describe_endpoints() lists the endpoints.",
      },
    });
    expect(extension.requests).toEqual([]);
  });

  it("points a built-in tool's name at the tool", async () => {
    const result = await mcp.call("call_endpoint", { name: "generate_diagram" });

    expect(result.structuredContent).toMatchObject({
      error: { code: "UNKNOWN_ENDPOINT", hint: "generate_diagram is a tool; call it directly." },
    });
  });

  it("passes the extension's error through like a dedicated tool", async () => {
    extension.reply("/switch_diagram", {
      status: 404,
      body: { success: false, code: "NOT_FOUND", error: "Element not found: D1" },
    });

    const result = await mcp.call("call_endpoint", { name: "switch_diagram", body: { id: "D1" } });

    expect(text(result)).toBe(
      "Failed to switch diagram: Element not found: D1 [NOT_FOUND, /switch_diagram, HTTP 404]",
    );
  });

  it("requires a name", async () => {
    const result = await mcp.call("call_endpoint", { body: {} });

    expect(text(result)).toMatch(/Input validation error/);
  });

  it("states only openWorldHint, since the endpoint decides the rest", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.find((t) => t.name === "call_endpoint")!.annotations).toEqual({
      openWorldHint: false,
    });
  });
});

describe("selections", () => {
  async function namesFor(selection: string, catalog = bundledCatalog()): Promise<string[]> {
    const client = await connect({
      catalog: new CatalogState(catalog, parseToolSelection(selection)),
    });
    try {
      return (await client.client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }

  it("lists named endpoints and leaves introspect to call_endpoint unless named", async () => {
    const state = new CatalogState(bundledCatalog(), parseToolSelection("create_diagram"));

    expect(await namesFor("create_diagram")).toEqual([
      "generate_diagram",
      "get_all_diagrams_info",
      "get_current_diagram_info",
      "get_diagram_image_by_id",
      "view_diagram",
      "diagram_as_text",
      "doctor",
      "create_diagram",
      "describe_endpoints",
      "call_endpoint",
    ]);
    expect(unlistedTools(state).map((t) => t.name)).toContain("introspect");
    expect(describeEndpoints(state, {})).toMatchObject({
      meta: { introspect: expect.any(String) },
    });
  });

  it("drops the generic tools when every endpoint has a tool", async () => {
    const names = await namesFor("all");

    expect(names).toHaveLength(7 + BUNDLED_MANIFEST.endpoints.length);
    expect(names).not.toContain("call_endpoint");
  });

  it("skips the introspect summary when the manifest has no /introspect", async () => {
    const catalog = {
      ...bundledCatalog(),
      compiled: compileManifest({
        ...BUNDLED_MANIFEST,
        endpoints: [entryOf("find_elements"), entryOf("save_project")],
      }),
    };

    expect(await namesFor("core", catalog)).toEqual([
      "generate_diagram",
      "get_all_diagrams_info",
      "get_current_diagram_info",
      "get_diagram_image_by_id",
      "view_diagram",
      "diagram_as_text",
      "doctor",
      "find_elements",
      "describe_endpoints",
      "call_endpoint",
    ]);
  });

  it("knows no endpoint while the extension is incompatible", () => {
    const state = new CatalogState({ ...bundledCatalog(), enabled: false });

    expect(unlistedTools(state)).toEqual([]);
    expect(() => describeEndpoints(state, { names: ["find_elements"] })).toThrow(
      'No endpoint "find_elements" in staruml-mcp-extension 0.3.0',
    );
  });
});

describe("tierCheck", () => {
  it("counts listed and unlisted endpoints", () => {
    expect(tierCheck(new CatalogState())).toEqual({
      name: "tier",
      status: "ok",
      detail: `core: ${CORE_ENDPOINTS.length} extension tools listed, ${EXTENDED.length} endpoints through call_endpoint`,
    });
  });

  it("warns about names that are neither endpoints nor tools", () => {
    const state = new CatalogState(undefined, parseToolSelection("core,doctor,save_projekt"));

    expect(tierCheck(state)).toEqual({
      name: "tier",
      status: "warn",
      detail: `core,doctor,save_projekt: ${CORE_ENDPOINTS.length} extension tools listed, ${EXTENDED.length} endpoints through call_endpoint; unknown: save_projekt`,
      remedy: "Check the names against describe_endpoints() or staruml://introspect/endpoints.",
    });
  });

  it("counts nothing while the extension is incompatible", () => {
    const state = new CatalogState({ ...bundledCatalog(), enabled: false });

    expect(tierCheck(state).detail).toBe(
      "core: 0 extension tools listed, 0 endpoints through call_endpoint",
    );
  });
});
