import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BUILD_DIAGRAM_DESCRIPTION, buildDiagramInput, buildResult } from "../src/build-diagram.js";
import { CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST } from "../src/manifest.js";
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

const entry = BUNDLED_MANIFEST.endpoints.find((e) => e.path === "/build_diagram")!;

/** What extension 0.3.0 answers for a two-class diagram (src/handlers/build.ts). */
const answer = {
  diagram: { _id: "D1", _type: "UMLClassDiagram", name: "Shop" },
  kind: "class",
  upserted: false,
  created: 3,
  updated: 0,
  unchanged: 0,
  layout: "engine",
  ids: { Order: { model: "C1", view: "V1" }, Line: { model: "C2", view: "V2" } },
  edges: [{ key: "Order -> Line", model: "R1", view: "V3" }],
};

const mermaid = "---\ntitle: Shop\n---\nclassDiagram\n  Order --> Line";

describe("build_diagram tool", () => {
  it("is listed in the core tier with a terse description and a short schema", async () => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === "build_diagram")!;

    expect(tool.description).toBe(BUILD_DIAGRAM_DESCRIPTION);
    expect(BUILD_DIAGRAM_DESCRIPTION.length).toBeLessThanOrEqual(100);
    expect(Object.keys(tool.inputSchema.properties!)).toEqual([
      "kind",
      "spec",
      "mermaid",
      "name",
      "upsert",
      "prune",
      "dryRun",
      "direction",
      "layout",
    ]);
    expect(tool.inputSchema.required).toBeUndefined();
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("names a spec shape for every kind but requirement and c4, which describe_endpoints shows", async () => {
    const { tools } = await mcp.client.listTools();
    const spec = (
      tools.find((t) => t.name === "build_diagram")!.inputSchema.properties as {
        spec: { description: string };
      }
    ).spec.description;
    const kinds = (entry.request.properties as { kind: { enum: string[] } }).kind.enum;

    expect(kinds.filter((k) => !spec.includes(`${k}{`))).toEqual(["requirement", "c4"]);
    expect(spec).toContain("component{components[{name,provides,requires,ports}]");
  });

  it("lists the same short schema under --tools all", async () => {
    const all = await connect({ catalog: new CatalogState(undefined, parseToolSelection("all")) });
    try {
      const { tools } = await all.client.listTools();
      expect(tools.find((t) => t.name === "build_diagram")!.description).toBe(
        BUILD_DIAGRAM_DESCRIPTION,
      );
    } finally {
      await all.close();
    }
  });

  it("sends Mermaid in one request and returns the id map", async () => {
    extension.reply("/build_diagram", { body: { success: true, data: answer } });

    const result = await mcp.call("build_diagram", { mermaid, direction: "LR" });

    expect(result.isError).toBeFalsy();
    expect(extension.requests).toEqual([
      { method: "POST", path: "/build_diagram", body: { mermaid, direction: "LR" } },
    ]);
    expect(JSON.parse(text(result))).toEqual(answer);
  });

  it("sends a layout preset", async () => {
    extension.reply("/build_diagram", { body: { success: true, data: answer } });

    await mcp.call("build_diagram", { mermaid, layout: "flow-right" });

    expect(extension.requests[0]!.body).toEqual({ mermaid, layout: "flow-right" });
  });

  it("passes the unlisted parent alias and autoLayout through", async () => {
    extension.reply("/build_diagram", {
      body: { success: true, data: { ...answer, kind: "usecase" } },
    });
    const body = {
      kind: "usecase",
      spec: {
        actors: ["Customer"],
        useCases: ["Pay"],
        relations: [{ from: "Customer", to: "Pay" }],
      },
      name: "Checkout",
      upsert: true,
      parentId: "M1",
      autoLayout: false,
    };

    const result = await mcp.call("build_diagram", body);

    expect(result.isError).toBeFalsy();
    // parentId is the alias extension 0.3.0 keeps for parent; it is sent under the new name.
    const { parentId, ...rest } = body;
    expect(extension.requests[0]!.body).toEqual({ ...rest, parent: parentId });
    // kind echoes the argument and is dropped.
    expect(text(result)).not.toContain('"kind"');
  });

  it("answers a dry run's plan steps and counts its ops, without the placeholder ids", async () => {
    const ops = [
      { path: "/create_diagram", body: { type: "UMLClassDiagram", name: "Shop" }, as: "diagram" },
      { path: "/create_element_with_view", body: { diagram: "$diagram", name: "Order" }, as: "n0" },
    ];
    const plan = {
      ops,
      creates: [
        {
          op: "create_diagram",
          target: null,
          as: "diagram",
          type: "UMLClassDiagram",
          name: "Shop",
        },
        { op: "create_element_with_view", target: null, as: "n0", type: "UMLClass", name: "Order" },
      ],
      updates: [],
      deletes: [],
    };
    extension.reply("/build_diagram", {
      body: {
        success: true,
        data: {
          ...answer,
          diagram: { _id: "$diagram", _type: "UMLClassDiagram", name: "Shop" },
          ids: { Order: { model: "$n0.model", view: "$n0.view" } },
          edges: [],
          dryRun: true,
          plan,
        },
      },
    });

    const result = await mcp.call("build_diagram", { mermaid, dryRun: true });

    expect(extension.requests[0]!.body).toEqual({ mermaid, dryRun: true });
    const shown = JSON.parse(text(result)) as Record<string, unknown>;
    expect(shown).not.toHaveProperty("ids");
    expect(shown).not.toHaveProperty("edges");
    // Null targets and the empty lists are pruned, as everywhere.
    expect(shown.plan).toEqual({
      ops: 2,
      creates: plan.creates.map(({ target: _target, ...step }) => step),
    });
    expect(shown.created).toBe(3);
  });

  it("passes a real build's answer, and an answer without a plan, through as JSON", () => {
    expect(JSON.parse(text(buildResult(answer, {})))).toMatchObject({ ids: answer.ids });
    expect(text(buildResult({ dryRun: true }, {}))).toBe('{"dryRun":true}');
    expect(text(buildResult(null, {}))).toBe("null");
  });

  it.each([
    ["an unknown key", { mermaid, title: "Shop" }, 'body: Unrecognized key: "title"'],
    [
      "a spec that is not an object",
      { kind: "class", spec: "classes" },
      "spec: Invalid input: expected object, received string",
    ],
    ["a kind it does not build", { kind: "gantt", spec: {} }, "kind: Invalid option"],
    ["a layout preset it does not have", { mermaid, layout: "sideways" }, "layout: Invalid option"],
    [
      "a flag that is not a boolean",
      { mermaid, dryRun: "yes" },
      "dryRun: Invalid input: expected boolean, received string",
    ],
    [
      "a wrong-typed unlisted parameter",
      { mermaid, autoLayout: "no" },
      "autoLayout: Invalid input: expected boolean, received string",
    ],
  ])("rejects %s against the whole request schema before sending", async (_, args, message) => {
    const result = await mcp.call("build_diagram", args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "INVALID_ARGUMENT",
        endpoint: "/build_diagram",
        hint: 'describe_endpoints({names: ["build_diagram"]}) shows its schema.',
      },
    });
    expect((result.structuredContent as { error: { message: string } }).error.message).toContain(
      message,
    );
    expect(extension.requests).toEqual([]);
  });

  it("rejects a wrong-typed listed parameter through the input schema", async () => {
    const result = await mcp.call("build_diagram", { mermaid, name: 5 });

    expect(text(result)).toMatch(/Input validation error/);
    expect(extension.requests).toEqual([]);
  });

  it("reports a rolled-back build with the failing op's index", async () => {
    extension.reply("/build_diagram", {
      status: 404,
      body: {
        success: false,
        code: "NOT_FOUND",
        error:
          "build_diagram: ops.3 /create_relationship failed, batch rolled back: Element not found",
        details: { index: 3, results: [{ path: "/create_diagram", success: true, data: {} }] },
      },
    });

    const result = await mcp.call("build_diagram", { mermaid });

    expect(text(result)).toBe(
      'Failed to build diagram: build_diagram: ops.3 /create_relationship failed, batch rolled back: Element not found [NOT_FOUND, /build_diagram, HTTP 404]\nDetails: {"index":3}',
    );
    expect(result.structuredContent).toMatchObject({
      error: { details: { index: 3, results: [{}] } },
    });
  });

  it("is described in full by describe_endpoints", async () => {
    const result = await mcp.call("describe_endpoints", { names: ["build_diagram"] });

    const described = JSON.parse(text(result)) as {
      build_diagram: { request: { properties: Record<string, { description: string }> } };
    };
    expect(described.build_diagram.request.properties.spec!.description).toBe(
      (entry.request.properties as Record<string, { description: string }>).spec!.description,
    );
  });
});

describe("buildDiagramInput", () => {
  it("lists only the parameters the manifest entry has", () => {
    const properties = entry.request.properties as Record<string, unknown>;
    const {
      upsert: _upsert,
      prune: _prune,
      dryRun: _dryRun,
      direction: _direction,
      layout: _layout,
      ...rest
    } = properties;

    const schema = z.toJSONSchema(
      buildDiagramInput({ ...entry, request: { ...entry.request, properties: rest } }),
    ) as { properties: Record<string, unknown> };

    expect(Object.keys(schema.properties)).toEqual(["kind", "spec", "mermaid", "name"]);
  });

  it("lists spec, kind, layout and the flags without the types the whole schema checks", () => {
    const schema = z.toJSONSchema(buildDiagramInput(entry)) as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(Object.keys(schema.properties.spec!)).toEqual(["description"]);
    expect(Object.keys(schema.properties.kind!)).toEqual(["description"]);
    expect(Object.keys(schema.properties.layout!)).toEqual(["description"]);
    for (const flag of ["upsert", "prune", "dryRun"]) {
      expect(Object.keys(schema.properties[flag]!), flag).toEqual(["description"]);
    }
    expect(schema.properties.direction!.enum).toEqual(["TB", "BT", "LR", "RL"]);
  });

  it("lists nothing for an entry without properties", () => {
    const schema = z.toJSONSchema(buildDiagramInput({ ...entry, request: { type: "object" } })) as {
      properties: Record<string, unknown>;
    };

    expect(schema.properties).toEqual({});
  });
});
