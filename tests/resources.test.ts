import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST } from "../src/manifest.js";
import { diagramImageUri, PATTERNS_URI, patternUri } from "../src/server.js";
import { closedPort, UpstreamFixture } from "./support/fixture.js";
import { connect, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
// Real 7.1.1 ids are base64-like and can contain `/` and `=`.
const DIAGRAM_ID = "AAAAAAGhCh/2wd1CFIY=";
const DIAGRAMS = [
  { id: DIAGRAM_ID, type: "UMLClassDiagram", name: "Main", description: "" },
  { id: "D2", type: "UMLSequenceDiagram", name: "Flow", description: "" },
];

const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;
/** Its catalogue cache is emptied after each test, which serves the metamodel differently. */
const catalog = new CatalogState();

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  mcp = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port, catalog });
});

afterEach(() => {
  catalog.reads.clear();
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await mcp.close();
  await Promise.all([builtin.stop(), extension.stop()]);
});

async function readError(uri: string): Promise<McpError> {
  const error: unknown = await mcp.client.readResource({ uri }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

describe("diagramImageUri", () => {
  it("percent-encodes characters an id may contain", () => {
    expect(diagramImageUri("a/b+c=")).toBe("staruml://diagram/a%2Fb%2Bc%3D.png");
  });
});

describe("resources/list", () => {
  it("lists the static resources and one PNG per diagram", async () => {
    builtin.reply("/get_all_diagrams_info", { body: { success: true, data: DIAGRAMS } });

    const { resources } = await mcp.client.listResources();

    expect(resources).toEqual([
      expect.objectContaining({
        uri: "staruml://diagrams",
        name: "diagrams",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "staruml://project",
        name: "project",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "staruml://project/tree",
        name: "project-tree",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "staruml://introspect/metamodel",
        name: "metamodel",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "staruml://introspect/endpoints",
        name: "endpoints",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "staruml://patterns",
        name: "patterns",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "ui://staruml/viewer.html",
        name: "viewer",
        mimeType: "text/html;profile=mcp-app",
      }),
      expect.objectContaining({
        uri: "staruml://diagram/AAAAAAGhCh%2F2wd1CFIY%3D.png",
        name: "Main",
        mimeType: "image/png",
      }),
      expect.objectContaining({
        uri: "staruml://diagram/D2.png",
        name: "Flow",
        mimeType: "image/png",
      }),
    ]);
  });

  it("still lists the static resources when StarUML is unreachable", async () => {
    const down = await connect({ apiHost: HOST, apiPort: await closedPort() });
    try {
      const { resources } = await down.client.listResources();
      expect(resources.map((r) => r.uri)).toEqual([
        "staruml://diagrams",
        "staruml://project",
        "staruml://project/tree",
        "staruml://introspect/metamodel",
        "staruml://introspect/endpoints",
        "staruml://patterns",
        "ui://staruml/viewer.html",
      ]);
    } finally {
      await down.close();
    }
  });

  it("publishes the pattern, diagram image and text templates", async () => {
    const { resourceTemplates } = await mcp.client.listResourceTemplates();

    expect(resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate: "staruml://pattern/{name}",
        name: "pattern",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uriTemplate: "staruml://diagram/{id}.png",
        name: "diagram-image",
        mimeType: "image/png",
      }),
      expect.objectContaining({
        uriTemplate: "staruml://diagram/{id}.mmd",
        name: "diagram-mmd",
        mimeType: "text/plain",
      }),
      expect.objectContaining({
        uriTemplate: "staruml://diagram/{id}.puml",
        name: "diagram-puml",
        mimeType: "text/plain",
      }),
    ]);
  });
});

describe("staruml://diagrams", () => {
  it("returns compact JSON", async () => {
    builtin.reply("/get_all_diagrams_info", { body: { success: true, data: DIAGRAMS } });

    const { contents } = await mcp.client.readResource({ uri: "staruml://diagrams" });

    expect(contents).toEqual([
      {
        uri: "staruml://diagrams",
        mimeType: "application/json",
        text: JSON.stringify(DIAGRAMS),
      },
    ]);
  });

  it("fails with the structured StarUML error", async () => {
    builtin.reply("/get_all_diagrams_info", {
      status: 500,
      body: { success: false, error: "boom" },
    });

    const error = await readError("staruml://diagrams");

    expect(error.message).toContain(
      "Failed to read diagrams: boom [UPSTREAM_ERROR, /get_all_diagrams_info, HTTP 500]",
    );
    expect(error.data).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "boom",
        endpoint: "/get_all_diagrams_info",
        upstream: "builtin",
        status: 500,
      },
    });
  });
});

describe("staruml://project", () => {
  it("returns the extension's project info without null fields", async () => {
    extension.reply("/get_project_info", {
      body: {
        success: true,
        data: {
          filename: null,
          project: { _id: "P1", _type: "Project", name: "Untitled", _parent: null },
        },
      },
    });

    const { contents } = await mcp.client.readResource({ uri: "staruml://project" });

    expect(contents).toEqual([
      {
        uri: "staruml://project",
        mimeType: "application/json",
        text: '{"project":{"_id":"P1","_type":"Project","name":"Untitled"}}',
      },
    ]);
  });

  it("fails with EXTENSION_UNREACHABLE when the extension is missing", async () => {
    const noExt = await connect({
      apiHost: HOST,
      apiPort: builtin.port,
      extPort: await closedPort(),
    });
    try {
      const error: unknown = await noExt.client
        .readResource({ uri: "staruml://project" })
        .catch((e: unknown) => e);
      expect((error as McpError).data).toMatchObject({
        error: { code: "EXTENSION_UNREACHABLE", endpoint: "/get_project_info" },
      });
    } finally {
      await noExt.close();
    }
  });
});

describe("staruml://project/tree", () => {
  const summary = (_id: string, _type: string, name: string | null, _parent: string | null) => ({
    _id,
    _type,
    name,
    _parent,
  });

  it("nests every model element under its owner, reading all pages", async () => {
    const pages = [
      {
        count: 4,
        elements: [
          summary("P1", "Project", "Shop", null),
          summary("M1", "UMLModel", "Model", "P1"),
        ],
        nextCursor: "2",
      },
      {
        count: 4,
        elements: [
          summary("C1", "UMLClass", "Order", "M1"),
          summary("D1", "UMLClassDiagram", "", "M1"),
        ],
        nextCursor: null,
      },
    ];
    extension.reply(
      "/find_elements",
      { body: { success: true, data: pages[0] } },
      { body: { success: true, data: pages[1] } },
    );

    const { contents } = await mcp.client.readResource({ uri: "staruml://project/tree" });

    expect(extension.requests.map((r) => r.body)).toEqual([
      { type: "Model", limit: 1000 },
      { type: "Model", limit: 1000, cursor: "2" },
    ]);
    expect(JSON.parse((contents[0] as { text: string }).text)).toEqual([
      {
        _id: "P1",
        _type: "Project",
        name: "Shop",
        children: [
          {
            _id: "M1",
            _type: "UMLModel",
            name: "Model",
            children: [
              { _id: "C1", _type: "UMLClass", name: "Order" },
              { _id: "D1", _type: "UMLClassDiagram" },
            ],
          },
        ],
      },
    ]);
  });

  it("treats elements whose owner was not returned as roots", async () => {
    extension.reply("/find_elements", {
      body: {
        success: true,
        data: {
          count: 1,
          elements: [summary("C1", "UMLClass", "Orphan", "gone")],
          nextCursor: null,
        },
      },
    });

    const { contents } = await mcp.client.readResource({ uri: "staruml://project/tree" });

    expect((contents[0] as { text: string }).text).toBe(
      '[{"_id":"C1","_type":"UMLClass","name":"Orphan"}]',
    );
  });

  it("fails with the extension's error", async () => {
    extension.reply("/find_elements", {
      status: 409,
      body: { success: false, code: "NO_PROJECT", error: "No project is open" },
    });

    const error = await readError("staruml://project/tree");

    expect(error.data).toMatchObject({ error: { code: "NO_PROJECT", status: 409 } });
  });
});

describe("staruml://introspect/metamodel", () => {
  it("reads the metamodel section alone and keeps empty schema values", async () => {
    const data = {
      staruml: { version: "7.1.1", apiVersion: "7.1.1" },
      extension: { name: "staruml-mcp-extension", version: "0.3.0" },
      metamodel: { UMLClass: { kind: "class", super: null, supers: [], attributes: [] } },
    };
    extension.reply("/introspect", { body: { success: true, data } });

    const { contents } = await mcp.client.readResource({ uri: "staruml://introspect/metamodel" });

    expect(extension.requests.map((r) => r.body)).toEqual([{ include: ["metamodel"] }]);
    expect(contents).toEqual([
      {
        uri: "staruml://introspect/metamodel",
        mimeType: "application/json",
        text: JSON.stringify(data),
      },
    ]);
  });

  it("fails with the extension's error", async () => {
    extension.reply("/introspect", {
      status: 500,
      body: { success: false, code: "INTERNAL", error: "boom" },
    });

    const error = await readError("staruml://introspect/metamodel");

    expect(error.message).toContain("Failed to read metamodel: boom");
    expect(error.data).toMatchObject({ error: { code: "INTERNAL", status: 500 } });
  });
});

describe("staruml://introspect/endpoints", () => {
  it("serves the manifest the server uses, schemas intact, without calling StarUML", async () => {
    const { contents } = await mcp.client.readResource({ uri: "staruml://introspect/endpoints" });

    expect(JSON.parse((contents[0] as { text: string }).text)).toEqual(BUNDLED_MANIFEST);
    expect(extension.requests).toEqual([]);
  });
});

describe("staruml://diagram/{id}.png", () => {
  it("returns the PNG as a blob for a percent-encoded id", async () => {
    builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: "iVBORw0KGgo=" } });
    const uri = diagramImageUri(DIAGRAM_ID);

    const { contents } = await mcp.client.readResource({ uri });

    expect(contents).toEqual([{ uri, mimeType: "image/png", blob: "iVBORw0KGgo=" }]);
    expect(builtin.requests).toEqual([
      { method: "POST", path: "/get_diagram_image_by_id", body: { diagramId: DIAGRAM_ID } },
    ]);
  });

  it("fails with StarUML's error for an unknown diagram", async () => {
    builtin.reply("/get_diagram_image_by_id", {
      status: 500,
      body: { success: false, error: "Diagram not found" },
    });

    const error = await readError("staruml://diagram/nope.png");

    expect(error.data).toMatchObject({
      error: { code: "UPSTREAM_ERROR", message: "Diagram not found" },
    });
  });

  it("rejects a malformed percent-encoding without calling StarUML", async () => {
    const error = await readError("staruml://diagram/%E0%A4%A.png");

    expect(error.data).toMatchObject({ error: { code: "UNEXPECTED_ERROR" } });
    expect(builtin.requests).toEqual([]);
  });
});

/** Extension #30's /list_patterns and /describe_pattern answers, cut to one pattern. */
const PATTERNS = {
  count: 1,
  patterns: [
    {
      name: "Strategy",
      category: "behavioral",
      intent: "Define a family of algorithms, encapsulate each one and make them interchangeable.",
      roles: ["Context", "Strategy", "ConcreteStrategy*"],
      variants: ["abstract-class"],
      sequence: true,
    },
  ],
};
const ABSTRACT_FACTORY = {
  name: "Abstract Factory",
  category: "creational",
  intent: "Provide an interface for creating families of related objects.",
  roles: [{ name: "AbstractFactory", type: "UMLInterface", cardinality: "1" }],
  relationships: [],
};

describe("pattern resources (extension #30)", () => {
  it("lists the pattern library, read once until the catalog changes", async () => {
    extension.reply("/list_patterns", { body: { success: true, data: PATTERNS } });

    const first = await mcp.client.readResource({ uri: PATTERNS_URI });
    const again = await mcp.client.readResource({ uri: PATTERNS_URI });

    expect(first.contents).toEqual([
      { uri: PATTERNS_URI, mimeType: "application/json", text: JSON.stringify(PATTERNS) },
    ]);
    expect(again).toEqual(first);
    expect(extension.requests).toEqual([{ method: "POST", path: "/list_patterns", body: {} }]);
  });

  it("describes one pattern by its percent-encoded name", async () => {
    extension.reply("/describe_pattern", { body: { success: true, data: ABSTRACT_FACTORY } });
    const uri = patternUri("Abstract Factory");

    const { contents } = await mcp.client.readResource({ uri });

    expect(uri).toBe("staruml://pattern/Abstract%20Factory");
    // relationships: [] is pruned as in every answer; a missing list means an empty one.
    const { relationships: _empty, ...shown } = ABSTRACT_FACTORY;
    expect(contents).toEqual([{ uri, mimeType: "application/json", text: JSON.stringify(shown) }]);
    expect(extension.requests).toEqual([
      { method: "POST", path: "/describe_pattern", body: { name: "Abstract Factory" } },
    ]);
  });

  it("reports an unknown pattern and an unreachable extension as resource errors", async () => {
    extension.reply("/describe_pattern", {
      status: 404,
      body: { success: false, code: "NOT_FOUND", error: "No pattern Nope; see /list_patterns" },
    });
    extension.reply("/list_patterns", {
      status: 500,
      body: { success: false, code: "INTERNAL", error: "boom" },
    });

    const unknown = await readError(patternUri("Nope"));
    const list = await readError(PATTERNS_URI);

    expect(unknown.message).toContain("Failed to read pattern: No pattern Nope");
    expect(unknown.data).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(list.message).toContain("Failed to read patterns: boom");
  });
});
