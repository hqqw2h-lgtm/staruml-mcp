import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CatalogState } from "../src/extension-tools.js";
import {
  DESCRIBE_DIAGRAM_DESCRIPTION,
  describeResult,
  SEARCH_TYPES_DESCRIPTION,
  searchResult,
  VALIDATE_MODEL_DESCRIPTION,
} from "../src/reads.js";
import { FIND_ELEMENTS_DESCRIPTION, UPDATE_ELEMENT_DESCRIPTION } from "../src/elements.js";
import { parseToolSelection } from "../src/tiers.js";
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

async function listed(name: string) {
  const { tools } = await mcp.client.listTools();
  return tools.find((t) => t.name === name)!;
}

/** Hits as extension 0.3.0's /search_types answers them (live, StarUML 7.1.1). */
const HIT = {
  id: "UMLComposition",
  category: "relationship",
  title: "Composition",
  description: 'Palette edge "Composition" in "Class"; creates UMLAssociation',
  example: { path: "/create_relationship", body: { type: "UMLComposition" } },
  score: 1000,
};

describe("short listings", () => {
  it.each([
    [
      "search_types",
      SEARCH_TYPES_DESCRIPTION,
      {
        query: { type: "string", description: "Words or part of an id." },
        limit: { description: "Default 10." },
        categories: { description: "Any of diagram, palette, relationship, model, enum, command." },
      },
      ["query"],
    ],
    [
      "describe_diagram",
      DESCRIBE_DIAGRAM_DESCRIPTION,
      {
        diagramId: { type: "string", description: "Diagram _id." },
        maxChars: { description: "Default 4000." },
      },
      ["diagramId"],
    ],
    [
      "validate_model",
      VALIDATE_MODEL_DESCRIPTION,
      {
        scope: { type: "string", description: "Element _id: only it and what it owns." },
        limit: { description: "Default 200." },
      },
      undefined,
    ],
    [
      "find_elements",
      FIND_ELEMENTS_DESCRIPTION,
      {
        type: { type: "string", description: "e.g. UMLClass." },
        name: { type: "string", description: "Exact name." },
        limit: { description: "Page size; default 100." },
        cursor: { type: "string", description: "nextCursor of the previous page." },
      },
      undefined,
    ],
  ])(
    "lists %s with its own description and parameters",
    async (name, description, properties, required) => {
      const tool = await listed(name);

      expect(tool.description).toBe(description);
      expect(tool.inputSchema).toEqual({
        type: "object",
        properties,
        ...(required === undefined ? {} : { required }),
      });
      expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    },
  );

  it("lists update_element's operations compressed, id required", async () => {
    const tool = await listed("update_element");

    expect(tool.description).toBe(UPDATE_ELEMENT_DESCRIPTION);
    expect(Object.keys(tool.inputSchema.properties!)).toEqual([
      "id",
      "op",
      "field",
      "value",
      "index",
      "parentId",
    ]);
    expect(tool.inputSchema.required).toEqual(["id"]);
    expect((tool.inputSchema.properties!.op as { enum: string[] }).enum).toEqual([
      "set",
      "add",
      "remove",
      "reorder",
      "relocate",
    ]);
  });

  it("lists the same under --tools all", async () => {
    const all = await connect({ catalog: new CatalogState(undefined, parseToolSelection("all")) });
    try {
      const { tools } = await all.client.listTools();
      expect(tools.find((t) => t.name === "search_types")!.description).toBe(
        SEARCH_TYPES_DESCRIPTION,
      );
    } finally {
      await all.close();
    }
  });

  it.each([
    ["search_types", { query: "x", limit: 0 }, "limit: Too small: expected number to be >=1"],
    [
      "search_types",
      { query: "x", categories: ["shape"] },
      'categories.0: Invalid option: expected one of "diagram"|"palette"|"relationship"|"model"|"enum"|"command"',
    ],
    [
      "describe_diagram",
      { diagramId: "" },
      "diagramId: Too small: expected string to have >=1 characters",
    ],
    [
      "describe_diagram",
      { diagramId: "D1", maxChars: 50 },
      "maxChars: Too small: expected number to be >=200",
    ],
    ["validate_model", { limit: 2000 }, "limit: Too big: expected number to be <=1000"],
    ["find_elements", { limit: "10" }, "limit: Invalid input: expected number, received string"],
    [
      "update_element",
      { id: "E1", op: "reorder", index: -1 },
      "index: Too small: expected number to be >=0",
    ],
    ["update_element", { id: "E1", bogus: 1 }, 'body: Unrecognized key: "bogus"'],
  ])("checks %s %j against the whole request schema", async (name, args, message) => {
    const result = await mcp.call(name, args);

    expect(result.structuredContent).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message,
        endpoint: `/${name}`,
        hint: `describe_endpoints({names: ["${name}"]}) shows its schema.`,
      },
    });
    expect(extension.requests).toEqual([]);
  });
});

describe("search_types", () => {
  it("answers the hits without their scores or the echoed query", async () => {
    extension.reply("/search_types", {
      body: { success: true, data: { query: "composition", total: 1, results: [HIT] } },
    });

    const result = await mcp.call("search_types", { query: "composition", limit: 3 });

    expect(extension.requests[0]!.body).toEqual({ query: "composition", limit: 3 });
    const { score: _score, ...hit } = HIT;
    expect(JSON.parse(text(result))).toEqual({ total: 1, results: [hit] });
  });

  it("leaves an answer without results as it is", () => {
    expect(text(searchResult({ total: 0 }, {}))).toBe('{"total":0}');
    expect(text(searchResult(null, {}))).toBe("null");
  });
});

describe("describe_diagram", () => {
  const TEXT =
    'UMLClassDiagram "Probe" in "Model1": 2 nodes, 1 edges\nNodes:\n- UMLClass "Order" { +id: UUID }\n- UMLClass "Customer"\nEdges:\n- "Customer" -[UMLAssociation "places"]-> "Order"';

  it("answers the summary text alone", async () => {
    extension.reply("/describe_diagram", {
      body: {
        success: true,
        data: {
          diagram: { _id: "D1", _type: "UMLClassDiagram", name: "Probe" },
          nodes: 2,
          edges: 1,
          text: TEXT,
          truncated: false,
        },
      },
    });

    const result = await mcp.call("describe_diagram", { diagramId: "D1", maxChars: 1000 });

    expect(extension.requests[0]!.body).toEqual({ diagramId: "D1", maxChars: 1000 });
    expect(result.content).toEqual([{ type: "text", text: TEXT }]);
  });

  it("falls back to JSON for an answer without text", () => {
    expect(text(describeResult({ nodes: 0 }, {}))).toBe('{"nodes":0}');
    expect(text(describeResult(undefined, {}))).toBe("ok");
  });
});

describe("validate_model", () => {
  it("answers the problems as compact JSON", async () => {
    const problems = [
      { id: "C1", _type: "UMLClass", name: null, ruleId: "UML002", message: "Name expected" },
    ];
    extension.reply("/validate_model", {
      body: { success: true, data: { count: 1, rules: 61, problems } },
    });

    const result = await mcp.call("validate_model", { scope: "P1" });

    expect(extension.requests[0]!.body).toEqual({ scope: "P1" });
    expect(text(result)).toBe(
      '{"count":1,"rules":61,"problems":[{"id":"C1","_type":"UMLClass","ruleId":"UML002","message":"Name expected"}]}',
    );
  });
});
