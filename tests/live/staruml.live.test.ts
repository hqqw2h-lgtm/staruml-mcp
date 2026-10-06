/**
 * Runs every tool and every manifest endpoint against a real StarUML (built-in API on 58321) and
 * staruml-mcp-extension 0.3.x (58322). Enabled with STARUML_LIVE=1; skipped otherwise so CI needs
 * no StarUML. The server lists the default core tier, so endpoints without a tool are called
 * through call_endpoint, as an agent would.
 *
 * The suite saves the open project to a temp file, works in a fresh project and reopens the
 * original file at the end. Unsaved changes of the original survive only in the temp copy,
 * whose path is printed.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { diagnose, healthy } from "../../src/doctor.js";
import { CatalogState } from "../../src/extension-tools.js";
import { main, type RunningServer } from "../../src/index.js";
import { BUNDLED_MANIFEST, toolName } from "../../src/manifest.js";
import {
  diagramImageUri,
  diagramTextUri,
  ENDPOINTS_URI,
  METAMODEL_URI,
  PATTERNS_URI,
  patternUri,
} from "../../src/server.js";
import { StarUMLClient } from "../../src/staruml-client.js";
import { VIEWER_URI } from "../../src/viewer.js";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { CORE_ENDPOINTS, OO_TOOLS, parseToolSelection } from "../../src/tiers.js";
import { closedPort } from "../support/fixture.js";
import { decodePng, differingRows } from "../support/png.js";
import { connect, text, UI_CAPABILITIES, type ConnectedClient } from "../support/mcp.js";
import { SKILL_PATH, skillExamples } from "../support/skill.js";
import { loadViewer } from "../support/viewer.js";
import { rpc } from "../support/sse.js";

const LIVE = process.env.STARUML_LIVE === "1";

const PNG_SIGNATURE = "89504e470d0a1a0a";

interface Summary {
  _id: string;
  _type: string;
  name?: string;
  _parent?: string;
  path?: string;
  [field: string]: unknown;
}

interface Created {
  view?: Summary;
  model?: Summary;
}

function ok(result: CallToolResult): string {
  expect(result.isError, text(result)).toBeFalsy();
  return text(result);
}

/** Tool texts are minified JSON, or `ok` when nothing is left to report. */
function payload<T>(result: CallToolResult): T {
  return JSON.parse(ok(result)) as T;
}

function failure(result: CallToolResult): { code: string; message: string; status?: number } {
  expect(result.isError, text(result)).toBe(true);
  return (result.structuredContent as { error: { code: string; message: string } }).error;
}

describe.runIf(LIVE).sequential("live StarUML 7.1.1 + staruml-mcp-extension 0.3", () => {
  const dir = mkdtempSync(join(tmpdir(), "staruml-mcp-live-"));
  const snapshot = join(dir, "snapshot.mdj");
  const called = new Set<string>();
  let mcp: ConnectedClient;
  let catalog: CatalogState;
  let originalFile: string | null = null;
  let projectId: string;
  let modelId: string;
  let generatedDiagramId: string;
  let classDiagramId: string;
  let packageId: string;
  const ids: Record<string, string> = {};

  let listed: Set<string>;

  /** The class views of a model element; /get_views_of also lists their compartment views. */
  const classViews = async (id: string) =>
    payload<{ elements: Summary[] }>(await call("get_views_of", { ref: id }))
      .elements.filter((v) => v._type === "UMLClassView")
      .map((v) => v._id);

  /**
   * execute_command through `target`, waiting out RATE_LIMITED: the extension allows 60 commands a
   * minute from all clients together, and other clients of the same StarUML count too.
   */
  const command = async (target: ConnectedClient, body: Record<string, unknown>) => {
    called.add("execute_command");
    for (let attempt = 0; ; attempt++) {
      const result = await target.call("call_endpoint", { name: "execute_command", body });
      const error = (result.structuredContent as { error?: { code: string } } | undefined)?.error;
      if (error?.code !== "RATE_LIMITED" || attempt === 3) return result;
      const wait = Number(/Retry in (\d+) s/.exec(text(result))?.[1] ?? 10);
      console.info(`[live] execute_command rate limited; retrying in ${wait} s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  };

  /** The tool of that name, or call_endpoint for an endpoint without one. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    called.add(name);
    return listed.has(name)
      ? mcp.call(name, args)
      : mcp.call("call_endpoint", { name, body: args });
  };

  beforeAll(async () => {
    const diagnosis = await diagnose(new StarUMLClient());
    expect(healthy(diagnosis.checks), JSON.stringify(diagnosis.checks)).toBe(true);
    catalog = new CatalogState(diagnosis.catalog);
    mcp = await connect({ catalog });
    listed = new Set((await mcp.client.listTools()).tools.map((t) => t.name));
    // A null filename (never saved) is pruned from the result.
    const info = payload<{ filename?: string }>(await call("get_project_info"));
    originalFile = info.filename ?? null;
    ok(await call("save_project", { filename: snapshot }));
    console.info(`[live] open project saved to ${snapshot}; original file: ${originalFile}`);
    ok(await call("new_project"));
    projectId = payload<{ project: Summary }>(await call("get_project_info")).project._id;
  }, 30_000);

  afterAll(async () => {
    // open_project is not in the core tier; calling it as a tool left StarUML on the suite's
    // last project until 0.6.0.
    const reopened = await mcp.call("call_endpoint", {
      name: "open_project",
      body: { filename: originalFile ?? snapshot },
    });
    if (reopened.isError) console.warn(`[live] could not reopen ${snapshot}: ${text(reopened)}`);
    await mcp.close();
  }, 30_000);

  describe("setup", () => {
    it("reads the live manifest and lists the core tier", async () => {
      expect(catalog.current.source).toBe("live");
      expect(catalog.current.compiled.manifest.extension.version).toMatch(/^0\.3\./);
      const { tools } = await mcp.client.listTools();
      const endpoints = catalog.current.compiled.manifest.endpoints.map((e) => toolName(e.path));
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "generate_diagram",
          "get_all_diagrams_info",
          "get_current_diagram_info",
          "get_diagram_image_by_id",
          "view_diagram",
          "diagram_as_text",
          "doctor",
          "describe_endpoints",
          "call_endpoint",
          ...endpoints.filter((e) => CORE_ENDPOINTS.includes(e)),
        ].sort(),
      );
      for (const tool of tools) {
        expect(tool.description, tool.name).toMatch(/^[^\n]{1,100}$/);
        expect(tool.inputSchema, tool.name).not.toHaveProperty("$schema");
      }
    });

    it("lists one tool per endpoint with --tools all", async () => {
      const all = await connect({
        catalog: new CatalogState(catalog.current, parseToolSelection("all")),
      });
      try {
        const names = (await all.client.listTools()).tools.map((t) => t.name);
        const endpoints = catalog.current.compiled.manifest.endpoints.map((e) => toolName(e.path));
        expect(names.length).toBe(7 + endpoints.length);
        expect(names).toEqual(expect.arrayContaining(endpoints));
        expect(
          payload<{ count: number }>(await all.call("get_all_commands")).count,
        ).toBeGreaterThan(100);
      } finally {
        await all.close();
      }
    });

    it("doctor reports every check ok", async () => {
      const report = ok(await call("doctor"));
      expect(report).toMatch(/^node +ok/);
      expect(report).toMatch(/staruml +ok +7\./);
      expect(report).toMatch(/tier +ok +core: /);
      expect(report).not.toMatch(/ fail /);
    });

    it("doctor switches the tier and back", async () => {
      const state = new CatalogState(catalog.current);
      const other = await connect({ catalog: state });
      try {
        // The core endpoints the running extension has, introspect included, and create_diagram.
        const live = catalog.current.compiled.manifest.endpoints.map((e) => toolName(e.path));
        const listed = live.filter((e) => CORE_ENDPOINTS.includes(e)).length + 1;
        expect(ok(await other.call("doctor", { tools: "core,create_diagram" }))).toMatch(
          new RegExp(`tier +ok +core,create_diagram: ${listed} extension tools listed`),
        );
        const names = (await other.client.listTools()).tools.map((t) => t.name);
        expect(names).toContain("create_diagram");
        ok(await other.call("doctor", { tools: "core" }));
        expect((await other.client.listTools()).tools.map((t) => t.name)).not.toContain(
          "create_diagram",
        );
      } finally {
        await other.close();
      }
    });
  });

  describe("built-in API (58321)", () => {
    it("lists diagrams of the fresh project", async () => {
      const diagrams = payload<{ id: string }[]>(await call("get_all_diagrams_info"));
      expect(Array.isArray(diagrams)).toBe(true);
    });

    it("reports the current diagram", async () => {
      expect(ok(await call("get_current_diagram_info"))).toMatch(/^(\{"id":|null$)/);
    });

    it("generates a class diagram from Mermaid", async () => {
      const before = payload<{ id: string }[]>(await call("get_all_diagrams_info"));

      expect(
        ok(
          await call("generate_diagram", {
            code: "classDiagram\n  class LiveA\n  class LiveB\n  LiveA --> LiveB",
          }),
        ),
      ).toBe("ok");

      const after = payload<{ id: string }[]>(await call("get_all_diagrams_info"));
      const added = after.filter((d) => !before.some((b) => b.id === d.id));
      expect(added).toHaveLength(1);
      generatedDiagramId = added[0]!.id;
    });

    it("exports the generated diagram as PNG", async () => {
      const result = await call("get_diagram_image_by_id", { diagramId: generatedDiagramId });

      expect(result.isError).toBeFalsy();
      const image = result.content[0] as { type: string; data: string; mimeType: string };
      expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    });

    it("surfaces StarUML's error for an unknown diagram id", async () => {
      const error = failure(await call("get_diagram_image_by_id", { diagramId: "nope" }));

      expect(error.code).toBe("UPSTREAM_ERROR");
      expect(error.message).toContain("Diagram not found");
    });

    it("surfaces StarUML's error for unsupported Mermaid", async () => {
      const error = failure(await call("generate_diagram", { code: "bogus" }));

      expect(error.message).toContain("Unsupported diagram type");
    });
  });

  describe("resources", () => {
    it("lists the generated diagram as a PNG resource", async () => {
      const { resources } = await mcp.client.listResources();

      expect(resources.map((r) => r.uri)).toEqual(
        expect.arrayContaining([
          "staruml://diagrams",
          "staruml://project",
          "staruml://project/tree",
          diagramImageUri(generatedDiagramId),
        ]),
      );
    });

    it("reads the diagram PNG as a blob", async () => {
      const uri = diagramImageUri(generatedDiagramId);
      const { contents } = await mcp.client.readResource({ uri });

      const image = contents[0] as { uri: string; mimeType: string; blob: string };
      expect(image).toMatchObject({ uri, mimeType: "image/png" });
      expect(Buffer.from(image.blob, "base64").subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    });

    it("reads the project summary and its ownership tree", async () => {
      const project = await mcp.client.readResource({ uri: "staruml://project" });
      expect(JSON.parse((project.contents[0] as { text: string }).text)).toMatchObject({
        project: { _id: projectId, _type: "Project" },
      });

      const tree = await mcp.client.readResource({ uri: "staruml://project/tree" });
      const roots = JSON.parse((tree.contents[0] as { text: string }).text) as {
        _id: string;
        children?: unknown[];
      }[];
      expect(roots.map((r) => r._id)).toEqual([projectId]);
      expect(JSON.stringify(roots)).toContain(generatedDiagramId);
      expect(JSON.stringify(roots)).not.toContain("View");
    });
  });

  describe("extension (58322)", () => {
    it("lists commands", async () => {
      const listed = payload<{ count: number; ids: string[] }>(await call("get_all_commands"));
      expect(listed.ids).toHaveLength(listed.count);
      expect(listed.ids).toContain("project:save");
    });

    it("executes a registered command and rejects an unknown one with NOT_FOUND", async () => {
      expect(ok(await command(mcp, { id: "view:fit-to-window" }))).toBe("ok");

      expect(failure(await command(mcp, { id: "nope:nope" }))).toMatchObject({
        code: "NOT_FOUND",
        status: 404,
        message: "Command not registered: nope:nope",
      });
    }, 150_000);

    it("finds or creates a model", async () => {
      const found = payload<{ count: number; elements?: Summary[] }>(
        await call("find_elements", { type: "UMLModel" }),
      );
      if (found.count > 0) {
        modelId = found.elements![0]!._id;
        return;
      }
      // ProjectManager.newProject() can leave the project without a model, unlike File > New.
      modelId = payload<Summary>(
        await call("create_element", { type: "UMLModel", parent: projectId, name: "Live" }),
      )._id;
    });

    it("creates, reads, renames and finds a package as compact summaries", async () => {
      const created = payload<Summary>(
        await call("create_element", { type: "UMLPackage", parent: modelId, name: "LivePkg" }),
      );
      // The name echoes the argument and is dropped; summaries carry the path besides.
      expect(created).toEqual({
        _id: expect.any(String),
        _type: "UMLPackage",
        _parent: modelId,
        path: expect.stringMatching(/\/LivePkg$/),
      });
      packageId = created._id;

      // Paths resolve wherever an id is taken (extension #20).
      expect(payload<Summary>(await call("get_element_by_id", { ref: created.path! }))).toEqual({
        _id: packageId,
        _type: "UMLPackage",
        name: "LivePkg",
        _parent: modelId,
        path: created.path,
      });
      expect(
        payload<Summary>(
          await call("update_element", { ref: packageId, field: "name", value: "LivePkg2" }),
        ).name,
      ).toBe("LivePkg2");
      expect(
        payload<{ count: number }>(
          await call("find_elements", { type: "UMLPackage", name: "LivePkg2" }),
        ).count,
      ).toBe(1);
    });

    it("pages find_elements with limit and cursor", async () => {
      const first = payload<{ count: number; elements: Summary[]; nextCursor?: string }>(
        await call("find_elements", { type: "Model", limit: 1 }),
      );
      expect(first.count).toBeGreaterThan(1);
      expect(first.elements).toHaveLength(1);

      const second = payload<{ elements: Summary[] }>(
        await call("find_elements", { type: "Model", limit: 1, cursor: first.nextCursor }),
      );
      expect(second.elements[0]!._id).not.toBe(first.elements[0]!._id);
    });

    it("passes projection fields and depth through", async () => {
      const model = payload<Summary>(
        await call("get_element_by_id", {
          ref: modelId,
          fields: ["name", "ownedElements"],
          depth: 1,
        }),
      );
      expect(model.ownedElements).toEqual(
        expect.arrayContaining([expect.objectContaining({ _id: packageId, name: "LivePkg2" })]),
      );
      const full = payload<Summary>(
        await call("get_element_by_id", { ref: packageId, summary: false }),
      );
      expect(full.visibility).toBe("public");
    });

    it("creates, switches to and closes a diagram", async () => {
      const diagram = payload<Summary>(
        await call("create_diagram", {
          type: "UMLClassDiagram",
          parent: packageId,
          name: "LiveDiagram",
        }),
      );
      classDiagramId = diagram._id;

      expect(payload<Summary>(await call("switch_diagram", { diagram: classDiagramId }))._id).toBe(
        classDiagramId,
      );
      ok(await call("close_diagram", { diagram: classDiagramId }));
      ok(await call("switch_diagram", { diagram: classDiagramId }));
    });

    it("creates classes with views and connects them", async () => {
      const place = async (name: string, x: number) =>
        payload<Created>(
          await call("create_element_with_view", {
            type: "UMLClass",
            parent: packageId,
            diagram: classDiagramId,
            name,
            x,
            y: 100,
          }),
        );
      const book = await place("Book", 100);
      const author = await place("Author", 400);
      expect(book.view!._type).toBe("UMLClassView");
      expect(book.model!._type).toBe("UMLClass");
      ids.book = book.model!._id;
      ids.author = author.model!._id;
      ids.bookView = book.view!._id;
      ids.authorView = author.view!._id;

      const edge = payload<Created>(
        await call("create_edge_with_view", {
          type: "UMLAssociation",
          diagram: classDiagramId,
          tail: book.view!._id,
          head: author.view!._id,
          name: "writtenBy",
        }),
      );
      expect(edge.model!._type).toBe("UMLAssociation");
      ids.edgeView = edge.view!._id;

      const generalization = payload<Created>(
        await call("create_relationship", {
          type: "UMLDependency",
          tail: ids.book,
          head: ids.author,
        }),
      );
      expect(generalization.model!._type).toBe("UMLDependency");
      expect(generalization.view).toBeUndefined();
    });

    it("reports StarUML's refusal of an invalid connection as STARUML_ERROR", async () => {
      const ucd = payload<Summary>(
        await call("create_diagram", { type: "UMLUseCaseDiagram", parent: modelId }),
      );
      const actor = payload<Created>(
        await call("create_element_with_view", {
          type: "UMLActor",
          parent: modelId,
          diagram: ucd._id,
        }),
      );
      const useCase = payload<Created>(
        await call("create_element_with_view", {
          type: "UMLUseCase",
          parent: modelId,
          diagram: ucd._id,
          x: 300,
        }),
      );

      expect(
        failure(
          await call("create_relationship", {
            type: "UMLInclude",
            diagram: ucd._id,
            tail: actor.view!._id,
            head: useCase.view!._id,
          }),
        ),
      ).toMatchObject({ code: "STARUML_ERROR", status: 422 });
    });

    it("adds attributes, operations, parameters and template parameters", async () => {
      ids.title = payload<Summary>(
        await call("add_attribute", { ref: ids.book, name: "title", type: "String" }),
      )._id;
      const lend = payload<Summary>(
        await call("add_operation", {
          ref: ids.book,
          name: "lend",
          parameters: [{ name: "days", type: "int" }],
          returnType: "boolean",
        }),
      );
      expect(lend._type).toBe("UMLOperation");
      expect(
        payload<Summary>(
          await call("add_parameter", { ref: lend._id, name: "note", type: "String" }),
        )._type,
      ).toBe("UMLParameter");
      expect(
        payload<Summary>(await call("add_template_parameter", { ref: ids.book, name: "T" }))._type,
      ).toBe("UMLTemplateParameter");
    });

    it("adds enumeration literals, slots and tags", async () => {
      const color = payload<Summary>(
        await call("create_element", { type: "UMLEnumeration", parent: modelId, name: "Color" }),
      );
      expect(
        payload<Summary>(await call("add_enumeration_literal", { ref: color._id, name: "RED" }))
          ._type,
      ).toBe("UMLEnumerationLiteral");

      const copy = payload<Summary>(
        await call("create_element", {
          type: "UMLObject",
          parent: modelId,
          name: "dune",
          properties: { classifier: { $ref: ids.book } },
        }),
      );
      expect(
        payload<Summary>(
          await call("add_slot", {
            ref: copy._id,
            definingFeature: ids.title,
            value: '"Dune"',
          }),
        )._type,
      ).toBe("UMLSlot");
      expect(
        payload<Summary>(
          await call("add_tag", { ref: ids.book, name: "pages", kind: "number", value: 412 }),
        )._type,
      ).toBe("Tag");
    });

    it("sets stereotype and documentation", async () => {
      // Requested fields equal to an argument are dropped like any echo, so read them back.
      ok(await call("set_stereotype", { ref: ids.book, stereotype: "entity" }));
      ok(
        await call("set_documentation", {
          ref: ids.book,
          documentation: "A published work.",
          fields: ["documentation"],
        }),
      );

      expect(
        payload<Summary>(
          await call("get_element_by_id", {
            ref: ids.book,
            fields: ["stereotype", "documentation"],
          }),
        ),
      ).toMatchObject({ stereotype: "entity", documentation: "A published work." });
    });

    it("builds a class diagram with one batch call, one undo step", async () => {
      const built = payload<{
        succeeded: number;
        results: { as?: string; data: Created & Summary }[];
      }>(
        await call("batch", {
          result: "full",
          ops: [
            {
              path: "/create_diagram",
              body: { type: "UMLClassDiagram", parent: packageId, name: "Batched" },
              as: "d",
            },
            ...["Shelf", "Copy"].map((name, i) => ({
              path: "/create_element_with_view",
              body: {
                type: "UMLClass",
                parent: packageId,
                diagram: "$d",
                name,
                x: 100 + 250 * i,
                y: 100,
              },
              as: name.toLowerCase(),
            })),
            { path: "/add_attribute", body: { ref: "$shelf.model", name: "code" } },
            {
              path: "/create_edge_with_view",
              body: {
                type: "UMLAssociation",
                diagram: "$d",
                tail: "$shelf.view",
                head: "$copy.view",
              },
            },
          ],
        }),
      );
      expect(built.succeeded).toBe(5);
      // No op result repeats the op's endpoint path; element summaries carry element paths.
      expect(JSON.stringify(built)).not.toMatch(/"path":"\//);
      const shelf = built.results[1]!.data.model!._id;
      ids.batchedDiagram = built.results[0]!.data._id;
      expect(await classViews(shelf)).toHaveLength(1);

      expect(payload<{ modified: boolean }>(await call("is_modified")).modified).toBe(true);
      ok(await call("undo"));
      expect(failure(await call("get_element_by_id", { ref: shelf })).code).toBe("NOT_FOUND");
      ok(await call("redo"));
      expect(payload<Summary>(await call("get_element_by_id", { ref: shelf })).name).toBe("Shelf");
    });

    it("refuses a dangling batch reference locally and rolls back an atomic failure", async () => {
      expect(
        failure(
          await call("batch", { ops: [{ path: "/delete_element", body: { ref: "$nope" } }] }),
        ),
      ).toMatchObject({
        code: "INVALID_ARGUMENT",
        message: "ops.0.body.ref: $nope names no earlier op",
      });

      const error = failure(
        await call("batch", {
          ops: [
            {
              path: "/create_element",
              body: { type: "UMLClass", parent: packageId, name: "Ghost" },
            },
            { path: "/delete_element", body: { ref: "missing-id" } },
          ],
        }),
      );
      expect(error).toMatchObject({ code: "NOT_FOUND", status: 404 });
      expect(error.message).toContain("ops.1 /delete_element failed, batch rolled back");
      expect(
        payload<{ count: number }>(await call("find_elements", { type: "UMLClass", name: "Ghost" }))
          .count,
      ).toBe(0);
    });

    it("looks up views, edges, relationships and references", async () => {
      const count = async (name: string, args: Record<string, unknown>) =>
        payload<{ count: number }>(await call(name, args)).count;

      expect(await classViews(ids.book!)).toEqual([ids.bookView]);
      expect(await count("get_edge_views_of", { ref: ids.bookView })).toBeGreaterThan(0);
      expect(await count("get_relationships_of", { ref: ids.book })).toBeGreaterThanOrEqual(2);
      expect(await count("get_refs_to", { ref: ids.book })).toBeGreaterThan(0);
      expect(await count("get_connected_node_views", { ref: ids.bookView })).toBe(1);
    });

    it("lays out, moves, resizes, styles and reorders views", async () => {
      ok(await call("layout_diagram", { diagram: classDiagramId, direction: "LR" }));
      // preset echoes the argument and is dropped from the answer.
      const laid = payload<{ separations: { node: number; rank: number }; fitted: number }>(
        await call("layout_diagram", {
          diagram: classDiagramId,
          preset: "hierarchy-right",
          nodeSeparation: 40,
          rankSeparation: 80,
          fit: true,
        }),
      );
      expect(laid.separations).toMatchObject({ node: 40, rank: 80 });
      expect(laid.fitted).toBeGreaterThan(0);
      expect(
        payload<{ edges: number }>(
          await call("route_edges", { diagram: classDiagramId, lineStyle: "rectilinear" }),
        ).edges,
      ).toBeGreaterThan(0);
      // EdgeView.lineStyle 0 is LS_RECTILINEAR (StarUML core/graphics.js).
      expect(
        payload<Summary>(
          await call("get_element_by_id", { ref: ids.edgeView, fields: ["lineStyle"] }),
        ).lineStyle,
      ).toBe(0);
      ok(await call("move_views", { refs: [ids.bookView], dx: 10, dy: 5 }));
      ok(await call("resize_node", { ref: ids.bookView, width: 180, height: 90 }));
      ok(await call("set_view_style", { refs: [ids.bookView], fillColor: "#ffeecc" }));
      ok(await call("set_z_order", { refs: [ids.bookView], position: "front" }));

      const view = payload<Summary>(
        await call("get_element_by_id", { ref: ids.bookView, fields: ["width", "fillColor"] }),
      );
      // StarUML widens a class view to fit its compartments when it is next drawn.
      expect(view.fillColor, JSON.stringify(view)).toBe("#ffeecc");
      expect(view.width, JSON.stringify(view)).toBeGreaterThanOrEqual(180);
    });

    it("sets and reads the selection and editor state", async () => {
      ok(await call("switch_diagram", { diagram: classDiagramId }));
      ok(await call("set_selection", { views: [ids.bookView] }));
      expect(JSON.stringify(payload(await call("get_selection")))).toContain(ids.bookView);

      ok(await call("set_editor_state", { zoom: 1.5 }));
      expect(payload<{ zoom: number }>(await call("get_editor_state")).zoom).toBe(1.5);
      ok(await call("set_editor_state", { zoom: 1 }));
    });

    it("exports a diagram as a PNG image block, to a file, to PDF and to HTML", async () => {
      const result = await call("export_diagram", { diagram: classDiagramId });
      ok(result);
      const image = result.content[0] as { type: string; data: string; mimeType: string };
      expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
      expect(JSON.parse(text({ content: result.content.slice(1) }))).toMatchObject({
        width: expect.any(Number),
        bytes: expect.any(Number),
      });

      const svg = join(dir, "diagram.svg");
      ok(await call("export_diagram", { diagram: classDiagramId, format: "svg", path: svg }));
      expect(existsSync(svg)).toBe(true);
      const pdf = join(dir, "diagram.pdf");
      ok(await call("export_pdf", { path: pdf, diagrams: [classDiagramId] }));
      expect(existsSync(pdf)).toBe(true);
      const html = join(dir, "html");
      ok(await call("export_html", { path: html }));
      expect(existsSync(join(html, "index.html"))).toBe(true);
    }, 60_000);

    it("reads a diagram back as text, searches types and validates the model (#11)", async () => {
      const described = ok(await call("describe_diagram", { diagram: classDiagramId }));
      expect(described.split("\n")[0]).toMatch(
        /^UMLClassDiagram "LiveDiagram" in ".+": 2 nodes, \d+ edges$/,
      );
      expect(described).toContain('"Book" -[UMLAssociation "writtenBy"]-> "Author"');

      for (const format of ["mermaid", "plantuml"]) {
        const exported = payload<{ kind: string; text: string }>(
          await call("export_text", { diagram: classDiagramId, format }),
        );
        expect(exported.kind).toBe("class");
        expect(exported.text).toContain("Book");
      }

      const found = payload<{ results: Record<string, unknown>[] }>(
        await call("search_types", { query: "composition", limit: 3 }),
      );
      expect(found.results.map((r) => r.id)).toContain("UMLComposition");
      expect(found.results[0]).not.toHaveProperty("score");
      expect(found.results[0]).toHaveProperty("example");

      const validated = payload<{ count?: number; rules: number }>(
        await call("validate_model", { scope: packageId, limit: 5 }),
      );
      expect(validated.rules).toBeGreaterThan(0);
    });

    it("diagram_as_text writes Mermaid and PlantUML, also as resources, and round-trips (#11)", async () => {
      const mermaid = await call("diagram_as_text", { diagram: classDiagramId });
      ok(mermaid);
      const source = (mermaid.content[0] as { text: string }).text;
      expect(source).toMatch(/^---\ntitle: "LiveDiagram"\n---\nclassDiagram\n/);
      expect(source).toContain("Book -- Author : writtenBy");
      expect(JSON.parse((mermaid.content[1] as { text: string }).text)).toEqual({ kind: "class" });

      const plantuml = await call("diagram_as_text", {
        diagram: classDiagramId,
        format: "plantuml",
      });
      expect(ok(plantuml)).toMatch(/^@startuml\ntitle LiveDiagram\n[\s\S]*@enduml\n/);

      ok(await call("switch_diagram", { diagram: classDiagramId }));
      const current = await call("diagram_as_text");
      expect(JSON.parse((current.content[1] as { text: string }).text)).toEqual({
        id: classDiagramId,
        kind: "class",
      });

      const mmd = await mcp.client.readResource({ uri: diagramTextUri(classDiagramId, "mermaid") });
      expect(mmd.contents[0]).toMatchObject({ mimeType: "text/plain", text: source });
      const puml = await mcp.client.readResource({
        uri: diagramTextUri(classDiagramId, "plantuml"),
      });
      expect(puml.contents[0]).toMatchObject({
        text: (plantuml.content[0] as { text: string }).text,
      });

      // The Mermaid is the form build_diagram reads: built again, it describes the same diagram.
      const rebuilt = payload<{ diagram: Summary }>(
        await call("build_diagram", {
          result: "full",
          mermaid: source,
          name: "LiveRoundTrip",
          parent: packageId,
        }),
      );
      const again = ok(await call("describe_diagram", { diagram: rebuilt.diagram._id }));
      expect(again).toContain('"Book" -[UMLAssociation "writtenBy"]-> "Author"');
      // Every node and edge line of the original comes back. Extension builds that reuse
      // same-named elements elsewhere in the project also draw their other relationships (here
      // the Book -> Author dependency, which has no view on LiveDiagram).
      const original = ok(await call("describe_diagram", { diagram: classDiagramId }));
      expect(again.split("\n").slice(1)).toEqual(
        expect.arrayContaining(original.split("\n").slice(1)),
      );
    });

    it("prompts name the reads, which run against StarUML as written (#11)", async () => {
      const { prompts } = await mcp.client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual([
        "model-codebase",
        "review-diagram",
        "improve-diagram",
        "apply-pattern",
        "model-first",
      ]);

      const review = await mcp.client.getPrompt({
        name: "review-diagram",
        arguments: { diagram: classDiagramId },
      });
      const steps = (review.messages[0]!.content as { text: string }).text;
      expect(steps).toContain(
        `call_endpoint({name: "describe_diagram", body: {diagram: "${classDiagramId}"}})`,
      );
      expect(steps).toContain(`diagram_as_text({diagram: "${classDiagramId}"})`);
      // Step 2 as the prompt describes it: the diagram's owner from get_element_by_id.
      const owner = payload<Summary>(
        await call("get_element_by_id", { ref: classDiagramId }),
      )._parent;
      expect(owner).toBe(packageId);
      expect(
        payload<{ rules: number }>(await call("validate_model", { scope: owner })).rules,
      ).toBeGreaterThan(0);

      const model = await mcp.client.getPrompt({
        name: "model-codebase",
        arguments: { path: join(dir, "java"), language: "java" },
      });
      const text = (model.messages[0]!.content as { text: string }).text;
      expect(text).toContain('call_endpoint({name: "list_code_generators", body: {}})');
      expect(text).toContain(`path: "${join(dir, "java")}"`);
    });

    it("view_diagram shows the SVG export in the viewer, and a PNG without MCP Apps (#10)", async () => {
      const app = await connect({ catalog }, UI_CAPABILITIES);
      try {
        const result = await app.call("view_diagram", { diagram: classDiagramId });
        const shown = result.structuredContent as { svg: string; name: string; diagram: string };
        expect(result.isError, text(result)).toBeFalsy();
        expect(shown).toMatchObject({ diagram: classDiagramId, name: "LiveDiagram" });
        expect(shown.svg).toMatch(/^<svg [\s\S]*<\/svg>$/);
        expect(shown.svg).toContain(">Book<");
        expect(shown.svg).toContain(">Author<");
        expect(JSON.parse(text(result))).toMatchObject({ viewer: VIEWER_URI });

        // The page the host would render, driven as the host would.
        const page = await app.client.readResource({ uri: VIEWER_URI });
        const viewer = loadViewer((page.contents[0] as { text: string }).text);
        viewer.receive({ jsonrpc: "2.0", id: 1, result: { hostContext: {} } });
        await viewer.settle();
        viewer.receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
        const src = viewer.elements.diagram.src;
        expect(decodeURIComponent(src.slice(src.indexOf(",") + 1))).toBe(shown.svg);
        expect(viewer.elements.name.textContent).toBe("LiveDiagram");
      } finally {
        await app.close();
      }

      const fallback = await call("view_diagram", { diagram: classDiagramId });
      const image = fallback.content[0] as { type: string; data: string };
      expect(image.type).toBe("image");
      expect(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    });

    it("labels the views of an export and a view by path (#24)", async () => {
      const exported = await call("export_diagram", { diagram: classDiagramId, annotate: "paths" });
      ok(exported);
      expect(exported.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      const { annotations } = JSON.parse(text({ content: exported.content.slice(1) })) as {
        annotations: { text: string; ref?: string; width: number }[];
      };
      expect(annotations.map((a) => a.text)).toEqual(
        expect.arrayContaining([expect.stringMatching(/Book$/), expect.stringMatching(/Author$/)]),
      );
      // Each label's text is a reference: the server drops the id beside it.
      expect(annotations.every((a) => a.ref === undefined && a.width > 0)).toBe(true);
      const book = annotations.find((a) => a.text.endsWith("Book"))!;
      const bookModel = payload<Summary>(await call("get_element_by_id", { ref: book.text }));
      expect(bookModel.name).toBe("Book");

      const app = await connect({ catalog }, UI_CAPABILITIES);
      try {
        const viewed = await app.call("view_diagram", { diagram: classDiagramId, annotate: "ids" });
        const svg = (viewed.structuredContent as { svg: string }).svg;
        expect(viewed.isError, text(viewed)).toBeFalsy();
        expect(svg).toContain(bookModel._id);
      } finally {
        await app.close();
      }

      const labelled = await call("view_diagram", { diagram: classDiagramId, annotate: "paths" });
      const image = labelled.content[0] as { type: string; data: string };
      expect(image.type).toBe("image");
      expect(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    });

    it("introspects versions and the debug surface", async () => {
      const info = payload<{
        staruml: { version: string };
        extension: { version: string };
        metamodel?: unknown;
      }>(await call("introspect"));
      expect(info.staruml.version).toMatch(/^7\./);
      expect(info.extension.version).toMatch(/^0\.3\./);
      expect(info.metamodel).toBeUndefined();

      const typed = payload<{ metamodel: Record<string, unknown> }>(
        await call("introspect", { types: ["UMLClass"] }),
      );
      expect(Object.keys(typed.metamodel)).toEqual(["UMLClass"]);

      expect(payload<{ app_keys: string[] }>(await call("debug")).app_keys).toContain("project");
    });

    it("refuses commands that would open a dialog with DIALOG_REQUIRED, a hint and details", async () => {
      const always = await command(mcp, { id: "help:about" });
      expect(failure(always)).toMatchObject({ code: "DIALOG_REQUIRED", status: 422 });
      expect(text(always)).toContain("Hint: StarUML would have opened a dialog");

      const needsArgs = await command(mcp, { id: "format:fill-color" });
      expect(failure(needsArgs)).toMatchObject({
        code: "DIALOG_REQUIRED",
        details: { dialog: "without-args" },
      });
      expect(text(needsArgs)).toMatch(/\nDetails: \{"dialog":"without-args","args":\[/);

      const described = payload<{ commands: { id: string; dialog: string; avoidWith?: number }[] }>(
        await call("describe_commands", { ids: ["format:fill-color", "help:about"] }),
      );
      expect(described.commands).toEqual([
        expect.objectContaining({ id: "format:fill-color", dialog: "without-args", avoidWith: 1 }),
        expect.objectContaining({ id: "help:about", dialog: "always" }),
      ]);
    }, 150_000);

    it("passes a rolled-back batch's details through and resolves numeric reference segments", async () => {
      const error = failure(
        await call("batch", {
          ops: [
            {
              path: "/create_element",
              body: { type: "UMLClass", parent: modelId, name: "Gone" },
            },
            { path: "/delete_element", body: { ref: "missing-id" } },
          ],
        }),
      ) as { details?: { index: number; results: unknown[] } };
      expect(error.details).toMatchObject({ index: 1, results: [{ data: { name: "Gone" } }, {}] });

      const read = payload<{ results: { data: Summary }[] }>(
        await call("batch", {
          result: "full",
          ops: [
            {
              path: "/get_element_by_id",
              body: { ref: modelId, fields: ["ownedElements"] },
              as: "m",
            },
            { path: "/get_element_by_id", body: { ref: "$m.ownedElements.0" } },
          ],
        }),
      );
      expect(read.results[1]!.data._parent).toBe(modelId);
    });

    it("builds a diagram from a spec and from Mermaid with build_diagram", async () => {
      const fromSpec = payload<{
        diagram: Summary;
        created: number;
        preset: string;
        ids: Record<string, unknown>;
      }>(
        await call("build_diagram", {
          result: "full",
          kind: "class",
          spec: {
            classes: [{ name: "Shelf2", attributes: ["+code: String"] }, { name: "Copy2" }],
            relations: [{ from: "Shelf2", to: "Copy2", type: "composition" }],
          },
          name: "LiveBuilt",
          parent: packageId,
          layout: "hierarchy-right",
        }),
      );
      expect(fromSpec.diagram.name).toBe("LiveBuilt");
      expect(fromSpec.preset).toBe("hierarchy-right");
      expect(fromSpec.created).toBe(3);
      expect(Object.keys(fromSpec.ids).sort()).toEqual(["Copy2", "Shelf2"]);

      const upserted = payload<{ upserted: boolean; created: number }>(
        await call("build_diagram", {
          mermaid: "classDiagram\n  Shelf2 --> Copy2\n  Copy2 --> Tag2",
          name: "LiveBuilt",
          parent: packageId,
          upsert: true,
        }),
      );
      expect(upserted.upserted).toBe(true);
      expect(upserted.created).toBeGreaterThan(0);
    });

    it(
      "addresses elements by path, shows one again, divides a fragment and checkpoints (#20, #22)",
      { timeout: 20_000 },
      async () => {
        const book = payload<Summary>(await call("get_element_by_id", { ref: ids.book! }));
        expect(book.path).toMatch(/\/Book$/);
        expect(payload<Summary>(await call("get_element_by_id", { ref: book.path! }))._id).toBe(
          ids.book,
        );
        // The diagram tools take paths too; without the viewer, view_diagram resolves one to the
        // id StarUML's built-in PNG export needs.
        const diagramPath = payload<Summary>(
          await call("get_element_by_id", { ref: classDiagramId }),
        ).path!;
        const asText = await call("diagram_as_text", { diagram: diagramPath });
        expect(text({ content: asText.content.slice(1) })).toContain(`"id":"${classDiagramId}"`);
        const png = await call("view_diagram", { diagram: diagramPath });
        expect(png.content[0]!.type).toBe("image");
        expect(
          ok(await call("describe_diagram", { diagram: diagramPath })).split("\n")[0],
        ).toContain("UMLClassDiagram");

        const taken = payload<{ label: string; elements: number }>(
          await call("snapshot", { label: "live-2g" }),
        );
        expect(taken.elements).toBeGreaterThan(10);

        const shown = payload<Created>(
          await call("create_view_of", { ref: book.path!, diagram: ids.batchedDiagram!, x: 420 }),
        );
        expect(shown.view!._type).toBe("UMLClassView");
        expect(shown.view!.path).toMatch(/\/Book@/);

        const sequence = payload<{ diagram: Summary }>(
          await call("build_diagram", {
            result: "full",
            kind: "sequence",
            name: "Live fragments",
            parent: packageId,
            spec: {
              participants: ["A", "B"],
              messages: [
                { from: "A", to: "B", text: "ping()" },
                { from: "B", to: "A", text: "pong", kind: "reply" },
              ],
              fragments: [{ operator: "alt", guard: "ok", operands: ["else"], from: 0, to: 1 }],
            },
          }),
        );
        const { ownedViews } = payload<{ ownedViews: Summary[] }>(
          await call("get_element_by_id", {
            ref: sequence.diagram._id,
            fields: ["ownedViews"],
            depth: 1,
          }),
        );
        const fragment = ownedViews.find((v) => v._type === "UMLCombinedFragmentView")!;
        const box = payload<{ top: number; height: number }>(
          await call("get_element_by_id", { ref: fragment._id, fields: ["top", "height"] }),
        );
        const divided = payload<{ views: Summary[] }>(
          await call("divide_fragment", {
            ref: fragment._id,
            at: [Math.round(box.top + box.height / 3)],
          }),
        );
        expect(divided.views.length).toBeGreaterThan(0);

        const since = payload<{ counts: { added: number; changed: number; removed: number } }>(
          await call("diff_since", { snapshot: "live-2g" }),
        );
        expect(since.counts.added).toBeGreaterThan(0);
        const restored = payload<{ undone: number; remaining: Record<string, number> }>(
          await call("restore_snapshot", { snapshot: "live-2g" }),
        );
        expect(restored.undone).toBeGreaterThan(0);
        expect(restored.remaining).toEqual({ added: 0, changed: 0, removed: 0 });
        expect(failure(await call("get_element_by_id", { ref: sequence.diagram._id })).code).toBe(
          "NOT_FOUND",
        );
        // One redo brings every undone operation back.
        ok(await call("redo"));
        expect(
          payload<Summary>(await call("get_element_by_id", { ref: sequence.diagram._id })).name,
        ).toBe("Live fragments");
      },
    );

    it("lints a diagram and the model, and diffs a diagram against a spec (#21, #22)", async () => {
      const lint = payload<{ count: number; findings?: { rule: string; paths: string[] }[] }>(
        await call("lint_diagram", { diagram: ids.batchedDiagram! }),
      );
      expect(lint.count).toBeGreaterThanOrEqual(0);
      const uml = payload<{ count: number; findings: { rule: string; path: string | null }[] }>(
        await call("uml_lint", { scope: packageId }),
      );
      // The batch's association has no multiplicities (U001).
      expect(uml.findings.map((f) => f.rule)).toContain("U001");

      const diff = payload<{ identical?: boolean; added: { nodes: string[] } }>(
        await call("diff_diagram", {
          diagram: ids.batchedDiagram!,
          kind: "class",
          spec: { classes: [{ name: "Shelf" }, { name: "Copy" }, { name: "Loan" }] },
        }),
      );
      expect(diff.identical).toBe(false);
      expect(diff.added.nodes).toEqual(["Loan"]);
    });

    it(
      "runs improve-diagram's quality loop as written: look, score, improve, look (#16)",
      { timeout: 30_000 },
      async () => {
        // Three classes stacked at one point, as an agent placing views by hand leaves them.
        const messy = payload<{ results: { data: Created & Summary }[] }>(
          await call("batch", {
            result: "full",
            ops: [
              {
                path: "/create_diagram",
                body: { type: "UMLClassDiagram", parent: packageId, name: "Messy" },
                as: "d",
              },
              ...["Cart", "Item", "Price"].map((name) => ({
                path: "/create_element_with_view",
                body: { type: "UMLClass", parent: packageId, diagram: "$d", name, x: 100, y: 100 },
                as: name,
              })),
              {
                path: "/create_edge_with_view",
                body: {
                  type: "UMLAssociation",
                  diagram: "$d",
                  tail: "$Cart.view",
                  head: "$Item.view",
                },
              },
            ],
          }),
        );
        const messyId = messy.results[0]!.data._id;

        const prompt = await mcp.client.getPrompt({
          name: "improve-diagram",
          arguments: { diagram: messyId },
        });
        const steps = (prompt.messages[0]!.content as { text: string }).text;
        for (const step of [
          `1. view_diagram({diagram: "${messyId}"})`,
          `2. diagram_quality({ref: "${messyId}"})`,
          `3. improve_diagram({ref: "${messyId}"})`,
          `4. view_diagram({diagram: "${messyId}"})`,
        ]) {
          expect(steps).toContain(step);
        }

        // The steps as written.
        expect((await call("view_diagram", { diagram: messyId })).content[0]!.type).toBe("image");
        interface Scored {
          score: number;
          target: number;
          penalties?: Record<string, number>;
          findings?: Record<string, number>;
        }
        const before = payload<Scored>(await call("diagram_quality", { ref: messyId }));
        expect(before.score).toBeLessThan(before.target);
        expect(Object.keys(before.penalties ?? {})).toContain("overlap");
        // dryRun: true echoes the argument and is dropped from the answer.
        const planned = payload<{ quality: Scored }>(
          await call("improve_diagram", { ref: messyId, dryRun: true }),
        );
        expect(payload<Scored>(await call("diagram_quality", { ref: messyId })).score).toBe(
          before.score,
        );
        const improved = payload<{ diagram: string; quality: Scored & { iterations: number } }>(
          await call("improve_diagram", { ref: messyId }),
        );
        expect(improved.diagram).toBe("Messy");
        expect(improved.quality.score).toBeGreaterThanOrEqual(improved.quality.target);
        expect(improved.quality.score).toBe(planned.quality.score);
        const after = payload<Scored>(await call("diagram_quality", { ref: messyId }));
        expect(after.score).toBe(improved.quality.score);
        expect((await call("view_diagram", { diagram: messyId })).content[0]!.type).toBe("image");

        // One undo step takes the whole loop back.
        ok(await call("undo"));
        expect(payload<Scored>(await call("diagram_quality", { ref: messyId })).score).toBe(
          before.score,
        );
        ok(await call("redo"));
      },
    );

    it("lints a messy diagram and sends its autofixes in one batch (#13)", async () => {
      interface Finding {
        rule: string;
        severity: string;
        autofix?: { path: string; body: Record<string, unknown> };
      }
      const drawn = payload<{ results: { data: Created & Summary }[] }>(
        await call("batch", {
          result: "full",
          ops: [
            {
              path: "/create_diagram",
              body: { type: "UMLClassDiagram", parent: packageId, name: "Stacked" },
              as: "d",
            },
            ...["LintShelf", "LintBin"].map((name) => ({
              path: "/create_element_with_view",
              body: { type: "UMLClass", parent: packageId, diagram: "$d", name, x: 40, y: 40 },
            })),
          ],
        }),
      );
      const stacked = drawn.results[0]!.data._id;
      const lint = async () =>
        payload<{ findings?: Finding[] }>(await call("lint_diagram", { diagram: stacked }));
      const before = await lint();
      expect(before.findings!.map((f) => f.rule)).toContain("L001");
      const owner = payload<Summary>(await call("get_element_by_id", { ref: stacked }))._parent!;
      expect(
        payload<{ findings?: unknown[] }>(await call("uml_lint", { scope: owner })).findings,
      ).toBeDefined();
      ok(await call("batch", { ops: before.findings!.flatMap((f) => f.autofix ?? []) }));
      expect(((await lint()).findings ?? []).map((f) => f.rule)).not.toContain("L001");
      ok(await call("delete_element", { ref: stacked }));
    });

    it("explains AMBIGUOUS_REF, DUPLICATE_NAME, SNAPSHOT_STALE and UNSUPPORTED_SYNTAX (#13)", async () => {
      const made = payload<{ results: { data: Summary }[] }>(
        await call("batch", {
          result: "full",
          ops: [
            {
              path: "/create_element",
              body: { type: "UMLPackage", parent: packageId, name: "AmbA" },
              as: "a",
            },
            {
              path: "/create_element",
              body: { type: "UMLPackage", parent: packageId, name: "AmbB" },
              as: "b",
            },
            { path: "/create_element", body: { type: "UMLClass", parent: "$a", name: "Twin" } },
            { path: "/create_element", body: { type: "UMLClass", parent: "$b", name: "Twin" } },
          ],
        }),
      );
      const twins = made.results.slice(2).map((r) => r.data.path!);

      const ambiguous = await call("get_element_by_id", { ref: "Twin" });
      expect(failure(ambiguous)).toMatchObject({ code: "AMBIGUOUS_REF", status: 409 });
      expect(text(ambiguous)).toContain(
        `Hint: Pass one of these instead, or a longer path: ${twins.join(", ")}.`,
      );
      expect(payload<Summary>(await call("get_element_by_id", { ref: twins[0]! }))._id).toBe(
        made.results[2]!.data._id,
      );

      const duplicate = await call("create_element", {
        type: "UMLClass",
        parent: twins[0]!.replace(/\/Twin$/, ""),
        name: "Twin",
      });
      expect(failure(duplicate).code).toBe("DUPLICATE_NAME");
      expect(text(duplicate)).toContain(
        `Hint: ${twins[0]} exists already: refer to it by its path`,
      );

      ok(await call("snapshot", { label: "stale" }));
      ok(await call("undo"));
      const stale = await call("restore_snapshot", { snapshot: "stale" });
      expect(failure(stale).code).toBe("SNAPSHOT_STALE");
      expect(text(stale)).toContain("Hint: The undo history no longer reaches that snapshot");
      ok(await call("redo"));

      const unsupported = await call("build_diagram", {
        text: '@startuml\nrobust "Web Browser" as WB\n@enduml',
        dryRun: true,
      });
      expect(failure(unsupported)).toMatchObject({ code: "UNSUPPORTED_SYNTAX", status: 422 });
      expect(text(unsupported)).toContain("Hint: The message names the construct and its line");
    });

    it("plans a build with dryRun without changing the model (#13)", async () => {
      const before = payload<{ count: number }>(
        await call("find_elements", { type: "UMLClass", name: "Planned" }),
      ).count;
      const planned = payload<{
        plan: { ops: number; creates: { op: string; name?: string }[] };
      }>(
        await call("build_diagram", {
          kind: "class",
          name: "Plan only",
          parent: packageId,
          dryRun: true,
          spec: { classes: [{ name: "Planned" }] },
        }),
      );
      // dryRun echoes the argument and is dropped; the plan says what would run.
      expect(planned.plan.ops).toBeGreaterThan(0);
      expect(planned.plan.creates.map((c) => c.name)).toContain("Planned");
      expect(
        payload<{ count: number }>(
          await call("find_elements", { type: "UMLClass", name: "Planned" }),
        ).count,
      ).toBe(before);
    });

    it("lists code generators, generates Java from a class and reverses it", async () => {
      const { generators } = payload<{ generators: { language: string; installed: boolean }[] }>(
        await call("list_code_generators"),
      );
      expect(generators.find((g) => g.language === "java")?.installed).toBe(true);

      const out = join(dir, "java");
      const generated = payload<{ count: number; files: string[] }>(
        await call("generate_code", { language: "java", ref: ids.book, path: out }),
      );
      expect(generated.files).toContain("Book.java");
      expect(existsSync(join(out, "Book.java"))).toBe(true);

      const reversed = payload<{ created: number; roots: Summary[] }>(
        await call("reverse_code", {
          language: "java",
          path: out,
          options: { typeHierarchy: false, packageOverview: false, packageStructure: false },
        }),
      );
      expect(reversed.created).toBeGreaterThan(0);
      expect(JSON.stringify(reversed.roots)).toContain("_id");
    }, 60_000);

    it("exports every diagram of a selection into a directory", async () => {
      const out = join(dir, "diagrams");
      const exported = payload<{ count: number; files: { file: string }[] }>(
        await call("export_diagrams", { path: out, diagrams: [classDiagramId] }),
      );
      expect(exported.count).toBe(1);
      expect(existsSync(exported.files[0]!.file)).toBe(true);
    }, 60_000);

    it("deletes the package and then reports it NOT_FOUND", async () => {
      expect(
        payload<{ models_deleted: number }>(await call("delete_element", { ref: packageId }))
          .models_deleted,
      ).toBeGreaterThan(0);

      expect(failure(await call("get_element_by_id", { ref: packageId }))).toMatchObject({
        code: "NOT_FOUND",
        status: 404,
        message: `Element not found: ${packageId}`,
      });
    });

    it("saves, creates and reopens projects", async () => {
      const saved = join(dir, "saved.mdj");
      const as = join(dir, "as.mdj");

      // The extension answers with the filename it was given, which is not echoed back.
      expect(ok(await call("save_project", { filename: saved }))).toBe("ok");
      expect(existsSync(saved)).toBe(true);
      expect(payload<{ filename: string }>(await call("save_project")).filename).toBe(saved);
      expect(ok(await call("save_project_as", { filename: as }))).toBe("ok");
      expect(existsSync(as)).toBe(true);

      expect(payload<{ project: Summary }>(await call("new_project")).project._type).toBe(
        "Project",
      );
      expect(payload<{ filename?: string }>(await call("get_project_info")).filename).toBe(
        undefined,
      );

      ok(await call("open_project", { filename: saved }));
      expect(payload<{ filename: string }>(await call("get_project_info")).filename).toBe(saved);
    });

    it("reports a broken file as STARUML_ERROR", async () => {
      const empty = join(dir, "empty.mdj");
      writeFileSync(empty, "");

      expect(failure(await call("open_project", { filename: empty }))).toMatchObject({
        code: "STARUML_ERROR",
        status: 422,
      });
    });

    /**
     * Model first and patterns (extension #23, #30; this server's #13): a model from an object
     * spec, a pattern applied to three of its classes by path and detected back, the pattern
     * resources and prompt, presets, themes, and messages synced into operations.
     */
    // StarUML answers more slowly once the ThingsBoard model is in the project.
    describe("model first and patterns (#13)", { timeout: 30_000 }, () => {
      const SHIPPING = {
        system: "Shipping",
        classes: [
          {
            name: "Order",
            responsibility: "Prices and ships one purchase",
            attributes: ["+weight: double"],
            operations: ["+shippingCost(): double"],
          },
          { name: "FlatRate", responsibility: "Charges one price per order" },
          { name: "ByWeight", responsibility: "Charges by the kilogram" },
        ],
        relationships: [{ from: "Order", to: "FlatRate", type: "uses" }],
      };
      const BINDINGS = {
        Context: "Shipping/Order",
        Strategy: "ShippingPolicy",
        ConcreteStrategy: ["Shipping/FlatRate", "Shipping/ByWeight"],
      };
      const policies = async () =>
        payload<{ count: number }>(
          await call("find_elements", { type: "UMLInterface", name: "ShippingPolicy" }),
        ).count;

      it("builds a model from an object spec: dry run, build, responsibilities as documentation", async () => {
        const planned = payload<{
          changes: { created: { path: string }[] };
          plan: { ops: number };
        }>(await call("build_model", { spec: SHIPPING, dryRun: true }));
        expect(planned.changes.created.map((c) => c.path)).toEqual(
          expect.arrayContaining(["Shipping", "Shipping/Order", "Shipping/Order#shippingCost()"]),
        );
        expect(planned.plan.ops).toBeGreaterThan(0);
        expect(
          payload<{ count: number }>(
            await call("find_elements", { type: "UMLModel", name: "Shipping" }),
          ).count,
        ).toBe(0);

        const built = payload<{ model: Summary; counts: { created: Record<string, number> } }>(
          await call("build_model", { spec: SHIPPING }),
        );
        expect(built.model.path).toBe("Shipping");
        expect(built.counts.created).toMatchObject({ UMLModel: 1, UMLClass: 3 });
        const order = payload<Summary>(
          await call("get_element_by_id", { ref: "Shipping/Order", fields: ["documentation"] }),
        );
        expect(order.documentation).toContain("Prices and ships one purchase");

        const again = payload<{ upserted: boolean; counts: { unchanged: number } }>(
          await call("build_model", { spec: SHIPPING, upsert: true }),
        );
        expect(again.upserted).toBe(true);
        expect(again.counts.unchanged).toBeGreaterThan(0);
      });

      // A dry run: building its 644 ops took 22 s on an idle StarUML 7.1.1 and over 110 s while
      // another client drove it, and the Shipping model above already builds for real.
      it("plans the ThingsBoard model from its 93-classifier object spec", async () => {
        const spec = JSON.parse(
          readFileSync(new URL("../fixtures/thingsboard.oo.json", import.meta.url), "utf8"),
        ) as { classes: unknown[]; system: string };
        const planned = payload<{
          model: { name: string; path: string; _id?: string };
          counts: { created: Record<string, number> };
          changes: { created: { path: string }[] };
          skipped?: { section: string }[];
          plan: { ops: number };
        }>(await call("build_model", { spec, dryRun: true }));
        expect(planned.model).toEqual({ name: spec.system, path: spec.system });
        const classifiers = ["UMLClass", "UMLInterface", "UMLEnumeration"]
          .map((t) => planned.counts.created[t] ?? 0)
          .reduce((a, b) => a + b);
        expect(classifiers).toBe(spec.classes.length);
        expect(planned.plan.ops).toBeGreaterThan(600);
        expect(planned.changes.created.map((c) => c.path)).toContain(`${spec.system}`);
        // Since extension #33 the view sections are stored with the model for derive_diagrams,
        // not skipped.
        expect(planned.skipped).toBeUndefined();
      });

      it("reads the pattern library as resources and through describe_pattern", async () => {
        const list = JSON.parse(
          ((await mcp.client.readResource({ uri: PATTERNS_URI })).contents[0] as { text: string })
            .text,
        ) as { count: number; patterns: { name: string; roles: string[] }[] };
        expect(list.count).toBeGreaterThanOrEqual(30);
        expect(list.patterns.find((p) => p.name === "Strategy")?.roles).toEqual([
          "Context",
          "Strategy",
          "ConcreteStrategy*",
        ]);
        const strategy = JSON.parse(
          (
            (await mcp.client.readResource({ uri: patternUri("Strategy") })).contents[0] as {
              text: string;
            }
          ).text,
        ) as { roles: { name: string }[]; relationships: unknown[] };
        expect(strategy.roles.map((r) => r.name)).toEqual([
          "Context",
          "Strategy",
          "ConcreteStrategy",
        ]);
        // The tool drops the name it was asked for, as every echo.
        const { name: _echo, ...described } = strategy as { name?: string };
        expect(payload(await call("describe_pattern", { name: "Strategy" }))).toEqual(described);
        expect(
          payload<{ count: number }>(await call("list_patterns", { category: "behavioral" })).count,
        ).toBeGreaterThan(5);
        const abstractFactory = await mcp.client.readResource({
          uri: patternUri("Abstract Factory"),
        });
        expect((abstractFactory.contents[0] as { text: string }).text).toContain("AbstractFactory");
      });

      it(
        "applies Strategy to three existing classes by path and detects it back",
        { timeout: 30_000 },
        async () => {
          const planned = payload<{
            roles: Record<string, string[]>;
            properties: Record<string, Record<string, unknown>>;
            plan: { ops: number };
          }>(
            await call("apply_pattern", {
              pattern: "Strategy",
              bindings: BINDINGS,
              parent: "Shipping",
              dryRun: true,
            }),
          );
          expect(planned.roles).toEqual({
            Context: ["Shipping/Order"],
            Strategy: ["Shipping/ShippingPolicy"],
            ConcreteStrategy: ["Shipping/FlatRate", "Shipping/ByWeight"],
          });
          expect(planned.plan.ops).toBeGreaterThan(0);
          expect(await policies()).toBe(0);

          const applied = payload<{
            created: number;
            diagram: string;
            sequenceDiagram: string;
            properties: Record<string, Record<string, unknown>>;
          }>(
            await call("apply_pattern", {
              pattern: "Strategy",
              bindings: BINDINGS,
              parent: "Shipping",
              diagram: "Shipping strategy",
              sequence: true,
            }),
          );
          expect(applied.created).toBeGreaterThan(0);
          expect(await policies()).toBe(1);
          // The properties Strategy prescribes, set on the association's ends.
          const ends = Object.entries(applied.properties).filter(([path]) => path.includes(" -> "));
          expect(Object.fromEntries(ends)).toMatchObject({
            "Shipping/Order -> Shipping/ShippingPolicy.end1": {
              aggregation: "shared",
              navigable: "notNavigable",
            },
            "Shipping/Order -> Shipping/ShippingPolicy.end2": {
              name: "strategy",
              navigable: "navigable",
              multiplicity: "1",
            },
          });
          expect(applied.properties["Shipping/ShippingPolicy#execute()"]).toEqual({
            isAbstract: true,
          });

          const { detections } = payload<{
            detections: { pattern: string; confidence: number; roles: Record<string, string[]> }[];
          }>(await call("detect_patterns", { scope: "Shipping", patterns: ["Strategy"] }));
          expect(detections[0]).toMatchObject({
            pattern: "Strategy",
            confidence: 1,
            roles: {
              Context: ["Shipping/Order"],
              Strategy: ["Shipping/ShippingPolicy"],
              ConcreteStrategy: expect.arrayContaining(["Shipping/FlatRate", "Shipping/ByWeight"]),
            },
          });
          expect(detections[0]).not.toHaveProperty("missing");

          const shown = await call("view_diagram", { diagram: applied.diagram, annotate: "paths" });
          expect((shown.content[0] as { type: string }).type).toBe("image");
          // The pattern's messages, already operations of their receivers.
          expect(
            payload<{ problems?: unknown[] }>(
              await call("check_messages", { diagram: applied.sequenceDiagram }),
            ).problems ?? [],
          ).toEqual([]);
        },
      );

      it("the apply-pattern prompt's calls run against StarUML as written", async () => {
        const prompt = await mcp.client.getPrompt({
          name: "apply-pattern",
          arguments: { pattern: "Strategy", scope: "Shipping" },
        });
        const steps = (prompt.messages[0]!.content as { text: string }).text;
        expect(steps).toContain(
          'call_endpoint({name: "describe_pattern", body: {name: "Strategy"}})',
        );
        expect(steps).toContain(
          'call_endpoint({name: "apply_pattern", body: {pattern: "Strategy", bindings, parent: "Shipping"',
        );
        expect(steps).toContain(
          'call_endpoint({name: "detect_patterns", body: {patterns: ["Strategy"], scope: "Shipping"}})',
        );
        ok(
          await mcp.call("call_endpoint", { name: "describe_pattern", body: { name: "Strategy" } }),
        );
        ok(
          await mcp.call("call_endpoint", {
            name: "detect_patterns",
            body: { patterns: ["Strategy"], scope: "Shipping" },
          }),
        );
      });

      it("gives a class a preset's properties and explains a type's", async () => {
        const planned = payload<{ element: string; properties: Record<string, unknown> }>(
          await call("apply_preset", {
            ref: "Shipping/FlatRate",
            preset: "immutable",
            dryRun: true,
          }),
        );
        expect(planned.element).toBe("Shipping/FlatRate");
        expect(planned.properties["Shipping/FlatRate"]).toEqual({ isLeaf: true });
        ok(await call("apply_preset", { ref: "Shipping/FlatRate", preset: "immutable" }));
        expect(
          payload<Summary>(
            await call("get_element_by_id", { ref: "Shipping/FlatRate", fields: ["isLeaf"] }),
          ).isLeaf,
        ).toBe(true);

        const described = payload<{ properties: { name: string }[] }>(
          await call("describe_type", { type: "UMLAssociationEnd" }),
        );
        expect(described.properties.map((p) => p.name)).toEqual(
          expect.arrayContaining(["aggregation", "navigable", "multiplicity"]),
        );
      });

      it("themes the pattern's diagram in one step", async () => {
        const planned = payload<{ styles: { views: number }[]; plan: { ops: number } }>(
          await call("apply_theme", { ref: "Shipping strategy", theme: "blueprint", dryRun: true }),
        );
        expect(planned.plan.ops).toBeGreaterThan(0);
        const themed = payload<{ styles: { views: number }[] }>(
          await call("apply_theme", { ref: "Shipping strategy", theme: "blueprint" }),
        );
        expect(themed.styles.reduce((n, s) => n + s.views, 0)).toBeGreaterThan(0);
      });

      it(
        "finds a message naming no operation and syncs it into the receiver",
        { timeout: 20_000 },
        async () => {
          ok(
            await call("build_diagram", {
              kind: "sequence",
              name: "Quote shipping",
              parent: "Shipping",
              spec: {
                participants: ["Order", "ByWeight"],
                messages: [{ from: "Order", to: "ByWeight", text: "quote(kilograms: double)" }],
              },
            }),
          );
          const before = payload<{ problems: { problem: string; receiver: string }[] }>(
            await call("check_messages", { diagram: "Quote shipping" }),
          );
          expect(before.problems).toEqual([
            expect.objectContaining({ problem: "no-operation", receiver: "Shipping/ByWeight" }),
          ]);
          const planned = payload<{ plan: { ops: number } }>(
            await call("sync_operations", { diagram: "Quote shipping", dryRun: true }),
          );
          expect(planned.plan.ops).toBeGreaterThan(0);
          ok(await call("sync_operations", { diagram: "Quote shipping" }));
          expect(
            payload<{ problems?: unknown[] }>(
              await call("check_messages", { diagram: "Quote shipping" }),
            ).problems ?? [],
          ).toEqual([]);
          expect(
            payload<Summary>(
              await call("get_element_by_id", { ref: "Shipping/ByWeight#quote(double)" }),
            ).name,
          ).toBe("quote");
        },
      );
    });

    describe("style profile and its guardrails (#16, #17)", { timeout: 30_000 }, () => {
      /** Back to the preference's built-in whatever a test left. */
      const reset = async () => ok(await call("set_style_profile", { reset: true }));

      it("reads, checks names against, applies and stores the style profile", async () => {
        const read = payload<{ profile: { name: string; strict: boolean }; builtIns: string[] }>(
          await call("get_style_profile"),
        );
        expect(read.profile.name).toBe("uml-standard");
        expect(read.builtIns).toEqual(expect.arrayContaining(["minimal", "presentation"]));
        const checked = payload<{ ok: boolean; violations: { expected: string }[] }>(
          await call("explain_style_violation", { kind: "classifier", name: "order_line" }),
        );
        expect(checked.ok).toBe(false);
        expect(checked.violations[0]!.expected).toBe("OrderLine");
        const planned = payload<{ profile: string; diagrams: number }>(
          await call("apply_style_profile", { scope: modelId, dryRun: true }),
        );
        expect(planned.profile).toBe("uml-standard");
        expect(planned.diagrams).toBeGreaterThan(0);

        try {
          const stored = payload<Record<string, unknown>>(
            await call("set_style_profile", { profile: "minimal" }),
          );
          // The switches, not the whole profile; the name echoes the argument and is dropped.
          expect(stored).toMatchObject({ strict: false, source: "project", changed: true });
          expect(stored).not.toHaveProperty("naming");
        } finally {
          await reset();
        }
      });

      it("a strict profile refuses placing views with STYLE_LOCKED and its hint, unless override", async () => {
        const diagram = payload<{ diagram: Summary }>(
          await call("build_diagram", {
            kind: "class",
            name: "Strict",
            parent: modelId,
            spec: { classes: [{ name: "Locked" }] },
          }),
        ).diagram;
        const view = "Locked@Strict";
        ok(await call("set_style_profile", { patch: { strict: true } }));
        try {
          const refused = failure(await call("move_views", { refs: [view], dx: 40, dy: 0 }));
          expect(refused).toMatchObject({ code: "STYLE_LOCKED", status: 403 });
          const result = await call("move_views", { refs: [view], dx: 40, dy: 0 });
          expect(text(result)).toContain("Hint: The style profile 'uml-standard' is strict");
          // improve_diagram is how a strict diagram is rearranged.
          ok(await call("improve_diagram", { ref: diagram._id }));
          ok(await call("move_views", { refs: [view], dx: 40, dy: 0, override: true }));
        } finally {
          await reset();
        }
        ok(await call("move_views", { refs: [view], dx: -40, dy: 0 }));
      });

      it("blockSaveOnErrors refuses saving with SAVE_BLOCKED naming model_lint's error", async () => {
        const cycle = {
          system: "Cycle",
          contexts: [
            { id: "a", name: "alpha", dependsOn: ["b"] },
            { id: "b", name: "beta", dependsOn: ["a"] },
          ],
          classes: [
            { name: "Ledger", context: "a", responsibility: "Books entries" },
            { name: "Journal", context: "b", responsibility: "Lists entries" },
          ],
        };
        ok(await call("build_model", { spec: cycle }));
        const lint = payload<{ findings: { rule: string; path: string; fix: string }[] }>(
          await call("model_lint", { scope: "Cycle" }),
        );
        // M003 is an error by default; M006 (two unused classes) a warning, which saves.
        expect(lint.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ rule: "M003", path: "Cycle/alpha" })]),
        );
        ok(await call("set_style_profile", { patch: { blockSaveOnErrors: true } }));
        const file = join(dir, "blocked.mdj");
        try {
          const result = await call("save_project", { filename: file });
          expect(failure(result)).toMatchObject({ code: "SAVE_BLOCKED", status: 409 });
          expect(text(result)).toContain("Hint: 1 lint error (M003 Cycle/alpha) blocks saving");
          expect(existsSync(file)).toBe(false);
          ok(await call("save_project", { filename: file, override: true }));
          expect(existsSync(file)).toBe(true);
        } finally {
          await reset();
          ok(await call("delete_element", { ref: "Cycle" }));
        }
      });
    });

    describe("oo tier: object-first, never draw (#17)", () => {
      let oo: ConnectedClient;
      /** A tool of the oo tier, or an endpoint through its call_endpoint. */
      const ooCall = async (name: string, args: Record<string, unknown> = {}) => {
        called.add(name);
        // The SDK gives up on a request after 60 s (DEFAULT_REQUEST_TIMEOUT_MSEC). ThingsBoard's
        // build_model takes 20 s on an idle StarUML and passed 60 s at load average 44.
        return (await oo.client.callTool({ name, arguments: args }, undefined, {
          timeout: 300_000,
        })) as CallToolResult;
      };
      const tb = JSON.parse(
        readFileSync(new URL("../fixtures/thingsboard.oo.json", import.meta.url), "utf8"),
      ) as { system: string; classes: unknown[] };
      interface Derived {
        diagrams: { kind: string; name: string; score?: number; created?: number }[];
        counts: { diagrams: number; created: number; updated: number; deleted: number };
        quality: { min: number; mean: number; passing: number; failing?: string[] };
      }
      let derived: Derived;

      beforeAll(async () => {
        oo = await connect({
          catalog: new CatalogState(catalog.current, parseToolSelection("oo")),
        });
      });

      afterAll(async () => {
        // The suite goes on in this project; ThingsBoard's 93 classes would slow every later build.
        await call("delete_element", { ref: tb.system });
        await oo.close();
      }, 60_000);

      it("lists no drawing tool and refuses one by name before StarUML sees it", async () => {
        const listed = (await oo.client.listTools()).tools.map((t) => t.name);
        expect(
          listed.filter((n) => !["describe_endpoints", "call_endpoint"].includes(n)).sort(),
        ).toEqual([...OO_TOOLS].sort());
        for (const name of ["build_diagram", "move_views", "batch", "set_view_style"]) {
          expect(failure(await oo.call("call_endpoint", { name, body: {} })).code).toBe(
            "NOT_IN_TIER",
          );
        }
        expect(
          text(await oo.call("generate_diagram", { code: "classDiagram\n  class A" })),
        ).toMatch(/disabled/);
        // A spec that tries to draw is refused by the strict OO schema.
        expect(
          failure(
            await ooCall("build_model", {
              spec: { system: "Drawn", classes: [{ name: "A", x: 1 }] },
            }),
          ).code,
        ).toBe("INVALID_ARGUMENT");
      });

      it(
        "builds ThingsBoard from its object spec and derives every diagram in two calls",
        { timeout: 600_000 },
        async () => {
          const started = performance.now();
          const built = await ooCall("build_model", { spec: tb });
          const model = payload<{ model: Summary; counts: { created: Record<string, number> } }>(
            built,
          );
          expect(model.model.path).toBe(tb.system);
          const answer = await ooCall("derive_diagrams", { scope: tb.system });
          derived = payload<Derived>(answer);
          const seconds = Math.round((performance.now() - started) / 1000);
          const tokens = countTokens(text(built)) + countTokens(text(answer));
          console.info(
            `[live] ThingsBoard through the oo tier: 2 calls, ${derived.counts.diagrams} diagrams, ` +
              `scores ${derived.quality.min}-${Math.max(...derived.diagrams.map((d) => d.score ?? 0))} ` +
              `(mean ${derived.quality.mean}), ${tokens} result tokens, ${seconds} s`,
          );
          expect(derived.counts.diagrams).toBeGreaterThanOrEqual(25);
          expect(new Set(derived.diagrams.map((d) => d.kind))).toEqual(
            new Set([
              "package",
              "class",
              "sequence",
              "usecase",
              "statemachine",
              "activity",
              "erd",
              "c4",
              "deployment",
              "mindmap",
            ]),
          );
          expect(derived.quality.min).toBeGreaterThanOrEqual(80);
          expect(tokens).toBeLessThan(3000);
        },
      );

      it(
        "derives the same diagrams again without changing anything",
        { timeout: 300_000 },
        async () => {
          const first = derived.diagrams.find((d) => d.kind === "class")!;
          const before = text(await ooCall("diagram_as_text", { diagram: first.name }));
          const again = payload<Derived>(await ooCall("derive_diagrams", { scope: tb.system }));

          expect(again.counts).toMatchObject({ created: 0, updated: 0, deleted: 0 });
          expect(again.diagrams.map((d) => [d.name, d.score])).toEqual(
            derived.diagrams.map((d) => [d.name, d.score]),
          );
          expect(text(await ooCall("diagram_as_text", { diagram: first.name }))).toBe(before);
        },
      );

      it("reads, reviews and scores the derived model", { timeout: 120_000 }, async () => {
        const explained = text(await ooCall("explain_model", { scope: tb.system, maxChars: 2000 }));
        expect(explained.split("\n")[0]).toMatch(new RegExp(`^${tb.system}: \\d+ packages`));
        expect(explained).toMatch(/\[cut at maxChars; raise it or narrow scope\]$/);
        const lint = payload<{ count: number; findings?: { rule: string; fix: string }[] }>(
          await ooCall("model_lint", { scope: tb.system, limit: 5 }),
        );
        expect(lint.count).toBeGreaterThanOrEqual(lint.findings?.length ?? 0);
        const detected = payload<{ detections?: unknown[] }>(
          await ooCall("detect_patterns", { scope: tb.system }),
        );
        expect(Array.isArray(detected.detections ?? [])).toBe(true);
        const sequence = derived.diagrams.find((d) => d.kind === "sequence")!;
        const scored = payload<{ score: number; target: number }>(
          await ooCall("diagram_quality", { ref: sequence.name }),
        );
        expect(scored.score).toBe(sequence.score);
        // Named like its collaboration and interaction; view_diagram picks the diagram.
        const view = await ooCall("view_diagram", { diagram: sequence.name });
        expect(view.isError, text(view)).toBeFalsy();
        expect(view.content[0]!.type).toBe("image");
        ok(await ooCall("validate_model", { scope: tb.system, limit: 5 }));
      });

      it(
        "the model-first prompt's calls run against StarUML as written",
        { timeout: 120_000 },
        async () => {
          const prompt = await oo.client.getPrompt({
            name: "model-first",
            arguments: { system: "Shipping" },
          });
          const steps = (prompt.messages[0]!.content as { text: string }).text;
          for (const step of [
            "build_model({spec, dryRun: true})",
            'derive_diagrams({scope: "Shipping"})',
            'explain_model({scope: "Shipping"})',
            'model_lint({scope: "Shipping"})',
            "build_model({spec, upsert: true})",
          ]) {
            expect(steps).toContain(step);
          }
          expect(steps).not.toContain("call_endpoint");
          // model-codebase draws with build_diagram, which the tier does not reach.
          expect((await oo.client.listPrompts()).prompts.map((p) => p.name)).not.toContain(
            "model-codebase",
          );

          const shipping = payload<Derived>(await ooCall("derive_diagrams", { scope: "Shipping" }));
          expect(shipping.diagrams.map((d) => d.kind)).toContain("class");
          expect(text(await ooCall("explain_model", { scope: "Shipping" }))).toMatch(/^Shipping: /);
          expect(
            payload<{ count: number }>(await ooCall("model_lint", { scope: "Shipping" })).count,
          ).toBeGreaterThanOrEqual(0);
        },
      );

      it("doctor narrows a session to the oo tier and cannot widen it back (#19)", async () => {
        const session = await connect({ catalog: new CatalogState(catalog.current) });
        try {
          ok(await session.call("doctor", { tools: "oo" }));
          const refused = failure(await session.call("doctor", { tools: "core" }));
          expect(refused.code).toBe("TIER_LOCKED");
          const names = (await session.client.listTools()).tools.map((t) => t.name);
          expect(names).not.toContain("build_diagram");
          expect(failure(await session.call("call_endpoint", { name: "build_diagram" })).code).toBe(
            "NOT_IN_TIER",
          );
        } finally {
          await session.close();
        }
      });

      it("doctor switches a session to the oo tier and back with --allow-tier-switch", async () => {
        const own = new CatalogState(catalog.current, undefined, { allowTierSwitch: true });
        const session = await connect({ catalog: own });
        try {
          const names = async () => (await session.client.listTools()).tools.map((t) => t.name);
          expect(await names()).toContain("build_diagram");
          expect(text(await session.call("doctor", { tools: "oo" }))).toMatch(
            /tier +ok +oo: 8 extension tools listed/,
          );
          expect(await names()).not.toContain("build_diagram");
          expect(await names()).toContain("derive_diagrams");
          ok(await session.call("doctor", { tools: "core" }));
          expect(await names()).toContain("build_diagram");
        } finally {
          await session.close();
        }
      });

      it("a strict profile still derives; the extension locks drawing and the tier refuses it", async () => {
        ok(await call("set_style_profile", { patch: { strict: true } }));
        try {
          const planned = payload<Derived>(
            await ooCall("derive_diagrams", { scope: tb.system, kinds: ["package"], dryRun: true }),
          );
          expect(planned.diagrams).toHaveLength(1);
          // Core lists the endpoint; the extension refuses it (layer 2 of the issue's comment).
          expect(
            failure(
              await call("route_edges", {
                diagram: derived.diagrams[0]!.name,
                lineStyle: "rectilinear",
              }),
            ).code,
          ).toBe("STYLE_LOCKED");
          // The oo tier never sends it (layer 1).
          expect(
            failure(
              await oo.call("call_endpoint", {
                name: "route_edges",
                body: { diagram: derived.diagrams[0]!.name, lineStyle: "rectilinear" },
              }),
            ).code,
          ).toBe("NOT_IN_TIER");
        } finally {
          ok(await call("set_style_profile", { reset: true }));
        }
      });
    });

    /**
     * Extension #28's project, io and editor endpoints and #26's diagnostics, all through
     * call_endpoint as the core tier reaches them.
     */
    describe("project, io and perf groups (#15)", () => {
      it("reads a preference, changes one it may and restores it, and refuses the rest", async () => {
        const grid = payload<{ value: boolean; default: boolean; type: string; settable: boolean }>(
          await call("get_preference", { key: "diagramEditor.showGrid" }),
        );
        expect(grid).toMatchObject({ type: "check", settable: true });
        try {
          ok(await call("set_preference", { key: "diagramEditor.showGrid", value: !grid.value }));
          expect(
            payload<{ value: boolean }>(
              await call("get_preference", { key: "diagramEditor.showGrid" }),
            ).value,
          ).toBe(!grid.value);
        } finally {
          ok(await call("set_preference", { key: "diagramEditor.showGrid", value: grid.value }));
        }
        expect(
          failure(await call("set_preference", { key: "mcp-ext.server.port", value: 1 })).code,
        ).toBe("INVALID_ARGUMENT");
        // The access token is never answered.
        expect(failure(await call("get_preference", { key: "mcp-ext.token" })).code).toBe(
          "NOT_FOUND",
        );
      });

      it("sets the project's metadata as one undo step and reads it back", async () => {
        const before = payload<Record<string, string>>(await call("get_project_metadata"));
        // The answer drops the fields that echo the arguments, as every answer does.
        const after = payload<Record<string, string>>(
          await call("set_project_metadata", { author: "Live suite", version: "0.8.0" }),
        );
        expect(after).toMatchObject({ name: before.name });
        expect(after).not.toHaveProperty("author");
        expect(payload<Record<string, string>>(await call("get_project_metadata"))).toMatchObject({
          author: "Live suite",
          version: "0.8.0",
        });
        ok(await call("undo"));
        expect(payload<Record<string, string>>(await call("get_project_metadata"))).toEqual(before);
      });

      it("lists the templates and extensions StarUML loads", async () => {
        const { templates } = payload<{ templates: { name: string; source: string }[] }>(
          await call("list_templates"),
        );
        expect(templates.map((t) => t.name)).toEqual(
          expect.arrayContaining(["Default", "UMLConventional", "C4Model", "WireframeModel"]),
        );
        const { extensions } = payload<{ extensions: { name: string; commands?: string[] }[] }>(
          await call("list_extensions"),
        );
        const ours = extensions.find((e) => e.name === "staruml-mcp-extension");
        expect(ours?.commands).toContain("mcp-ext:set-token");
      });

      it("opens a project from a template and returns to the suite's project", async () => {
        const back = join(dir, "before-template.mdj");
        ok(await call("save_project", { filename: back }));
        try {
          const made = payload<{ template: { name: string } }>(
            await call("new_from_template", { template: "UMLConventional" }),
          );
          expect(made.template.name).toBe("UMLConventional");
          const models = payload<{ count: number }>(
            await call("find_elements", { type: "UMLModel" }),
          ).count;
          expect(models).toBeGreaterThan(1);
          expect(failure(await call("new_from_template", { template: "Nope" })).code).toBe(
            "NOT_FOUND",
          );
        } finally {
          ok(await call("open_project", { filename: back }));
        }
      });

      it("finds text in names and documentation, and lists and closes editor tabs", async () => {
        const built = payload<{ diagram: Summary }>(
          await call("build_diagram", {
            kind: "class",
            name: "Quick find",
            spec: { classes: [{ name: "Ledger" }, { name: "Posting" }] },
          }),
        );
        ok(
          await call("set_documentation", {
            ref: "Posting",
            documentation: "One line of a ledger entry.",
          }),
        );
        const found = payload<{ matches: { element: Summary; field: string }[]; total: number }>(
          await call("quick_find", { text: "LEDGER" }),
        );
        expect(found.matches.map((m) => `${m.element.name} ${m.field}`)).toEqual(
          expect.arrayContaining(["Ledger name", "Posting documentation"]),
        );
        expect(
          payload<{ total: number; truncated?: boolean }>(
            await call("quick_find", { text: "e", limit: 1 }),
          ),
        ).toMatchObject({ truncated: true });

        ok(await call("switch_diagram", { diagram: built.diagram._id }));
        const tabs = payload<{ diagrams: (Summary & { current?: boolean })[] }>(
          await call("list_working_diagrams"),
        );
        expect(tabs.diagrams).toContainEqual(
          expect.objectContaining({ _id: built.diagram._id, current: true }),
        );
        expect(
          payload<{ closed: string[] }>(
            await call("close_diagrams", { diagrams: [built.diagram._id] }),
          ).closed,
        ).toEqual([built.diagram._id]);
        // No tab left open answers `ok`: the empty list is pruned.
        const left = ok(await call("list_working_diagrams"));
        if (left !== "ok") {
          expect((JSON.parse(left) as { diagrams: Summary[] }).diagrams).not.toContainEqual(
            expect.objectContaining({ _id: built.diagram._id }),
          );
        }
      });

      it("writes a package to a fragment and reads it into another owner", async () => {
        const file = join(dir, "fragment.mfj");
        ok(
          await call("build_model", {
            spec: { system: "Fragmented", classes: [{ name: "Part" }, { name: "Whole" }] },
          }),
        );
        ok(await call("export_fragment", { ref: "Fragmented", filename: file }));
        expect(readFileSync(file, "utf8")).toContain('"Whole"');
        const target = payload<Summary>(
          await call("create_element", { type: "UMLPackage", parent: "@project", name: "Copies" }),
        );
        ok(await call("import_fragment", { filename: file, parent: target._id }));
        expect(
          payload<{ count: number }>(await call("find_elements", { name: "Whole" })).count,
        ).toBe(2);
        // The import is an operation undo skips; deleting the owner takes it out again.
        ok(await call("delete_element", { ref: target._id }));
        ok(await call("delete_element", { ref: "Fragmented" }));
      });

      it("answers NOT_FOUND for XMI without the staruml-xmi extension", async () => {
        const installed = payload<{ extensions: { name: string }[] }>(
          await call("list_extensions"),
        ).extensions.some((e) => e.name === "staruml-xmi");
        const file = join(dir, "model.xmi");
        const exported = await call("export_xmi", { filename: file });
        if (installed) {
          ok(exported);
          ok(await call("import_xmi", { filename: file }));
          return;
        }
        expect(failure(exported)).toMatchObject({ code: "NOT_FOUND" });
        expect(text(exported)).toContain("staruml-xmi");
        writeFileSync(file, '<?xml version="1.0"?><xmi:XMI xmlns:xmi="http://www.omg.org/XMI"/>');
        expect(failure(await call("import_xmi", { filename: file })).message).toContain(
          "staruml-xmi",
        );
      });

      it("reports the write path's counters", async () => {
        const stats = payload<{
          listeners: Record<string, number>;
          undo: number;
          elements: number;
          heapUsedMiB: number;
        }>(await call("performance_stats"));
        expect(stats.listeners.operationExecuted).toBeGreaterThan(0);
        expect(stats.elements).toBeGreaterThan(1);
        expect(stats.heapUsedMiB).toBeGreaterThan(0);
      });
    });

    it("called every listed tool and every endpoint of the bundled manifest", async () => {
      const { tools } = await mcp.client.listTools();
      const live = catalog.current.compiled.manifest.endpoints.map((e) => e.path);
      // The extension is final at 0.3.0 (phase 1i): the running one offers exactly the bundled
      // manifest, every endpoint with the same description and schemas.
      const bundled = BUNDLED_MANIFEST.endpoints.map((e) => e.path);
      expect(live).toEqual(bundled);
      expect(catalog.current.compiled.manifest).toEqual(BUNDLED_MANIFEST);
      const generic = ["describe_endpoints", "call_endpoint"];
      expect(
        [...tools.map((t) => t.name), ...bundled.map((p) => toolName(p))].filter(
          (n) => !called.has(n) && !generic.includes(n),
        ),
      ).toEqual([]);
    });
  });

  /**
   * Upstream staruml/staruml-mcp-server issues #2 (diagram names), #3 (line breaks in names) and
   * #4 (activity and use case diagrams), through generate_diagram's routing to build_diagram and
   * through build_diagram itself; every diagram is exported and its views counted.
   */
  describe("official server parity (#7)", () => {
    interface Built {
      diagram: Summary;
      ids: Record<string, { model: string; view: string }>;
      edges: unknown[];
    }

    /** Top-level views of a diagram by type. */
    const viewCounts = async (id: string) => {
      const { ownedViews } = payload<{ ownedViews: Summary[] }>(
        await call("get_element_by_id", { ref: id, fields: ["ownedViews"], depth: 1 }),
      );
      const counts: Record<string, number> = {};
      for (const view of ownedViews) counts[view._type] = (counts[view._type] ?? 0) + 1;
      return counts;
    };

    /** The diagram exported through export_diagram as a decoded PNG. */
    const png = async (id: string) => {
      const result = await call("export_diagram", { diagram: id });
      ok(result);
      const image = result.content[0] as { type: string; data: string };
      expect(image.type).toBe("image");
      const decoded = decodePng(image.data);
      expect(decoded.width).toBeGreaterThan(50);
      return decoded;
    };

    const diagramNames = async () =>
      payload<{ name: string }[]>(await call("get_all_diagrams_info")).map((d) => d.name);

    it("#2: names a diagram after its Mermaid front matter title", async () => {
      const built = payload<Built>(
        await call("generate_diagram", {
          code: "---\ntitle: Order lifecycle\n---\nclassDiagram\n  Order --> Line\n  Order --> Customer",
        }),
      );

      expect(built.diagram).toMatchObject({ _type: "UMLClassDiagram", name: "Order lifecycle" });
      expect(await diagramNames()).toContain("Order lifecycle");
      expect(await viewCounts(built.diagram._id)).toEqual({
        UMLClassView: 3,
        UMLAssociationView: 2,
      });
      await png(built.diagram._id);
    });

    it("#2: names a diagram after the name parameter, over a title line", async () => {
      const built = payload<Built>(
        await call("generate_diagram", {
          code: "sequenceDiagram\n  title Ignored\n  Browser->>Server: GET /\n  Server-->>Browser: 200",
          name: "Checkout request",
        }),
      );

      expect(built.diagram.name).toBe("Checkout request");
      expect(await diagramNames()).toContain("Checkout request");
      expect(await viewCounts(built.diagram._id)).toEqual({
        UMLFrameView: 1,
        UMLSeqLifelineView: 2,
        UMLSeqMessageView: 2,
      });
      await png(built.diagram._id);
    });

    it("#3: stores <br/> as a newline in a participant's name, drawn on one line without the tag", async () => {
      const lifelines = "\n  participant S as Server\n  W->>S: login";
      const broken = payload<Built>(
        await call("generate_diagram", {
          code: `sequenceDiagram\n  participant W as Web<br/>App${lifelines}`,
          name: "Break",
        }),
      );
      const model = broken.ids["Web\nApp"]!.model;
      expect(payload<Summary>(await call("get_element_by_id", { ref: model })).name).toBe(
        "Web\nApp",
      );
      expect(await viewCounts(broken.diagram._id)).toEqual({
        UMLFrameView: 1,
        UMLSeqLifelineView: 2,
        UMLSeqMessageView: 1,
      });

      // The same diagram with the literal tag the built-in API keeps, and with no name at all.
      const renamed = async (name: string) => {
        const built = payload<Built>(
          await call("build_diagram", {
            result: "full",
            mermaid: `sequenceDiagram\n  participant W as WebApp${lifelines}`,
            name: "Break",
          }),
        );
        ok(
          await call("update_element", {
            ref: built.ids.WebApp!.model,
            field: "name",
            value: name,
          }),
        );
        return built;
      };
      const tagged = await renamed("Web<br/>App");
      const unnamed = await renamed("");

      const [withBreak, withTag, withoutName] = await Promise.all(
        [broken, tagged, unnamed].map((b) => png(b.diagram._id)),
      );
      expect(differingRows(withBreak!, withTag!)).toBeDefined();
      // StarUML 7.1.1 draws a label with one CanvasRenderingContext2D.fillText call, which does
      // not break lines at "\n" (LabelView.draw in src/core/core.js; Canvas.wordWrap in
      // src/core/graphics.js splits at spaces only). The name's pixels span one 13 px Arial
      // line, so the picture reads "Web App"; a second line needs the extension to draw it.
      const text = differingRows(withBreak!, withoutName!)!;
      expect(text.last - text.first + 1).toBeLessThanOrEqual(16);
    }, 60_000);

    it("#4: builds a use case diagram from a JSON spec and from Mermaid", async () => {
      const fromSpec = payload<Built>(
        await call("build_diagram", {
          result: "full",
          kind: "usecase",
          name: "Shop use cases",
          spec: {
            system: "Shop",
            actors: ["Customer", "Clerk"],
            useCases: ["Place order", "Pay", "Refund"],
            relations: [
              { from: "Customer", to: "Place order" },
              { from: "Customer", to: "Pay" },
              { from: "Clerk", to: "Refund" },
              { from: "Place order", to: "Pay", type: "include" },
            ],
          },
        }),
      );
      expect(fromSpec.diagram).toMatchObject({
        _type: "UMLUseCaseDiagram",
        name: "Shop use cases",
      });
      expect(await viewCounts(fromSpec.diagram._id)).toEqual({
        UMLUseCaseSubjectView: 1,
        UMLActorView: 2,
        UMLUseCaseView: 3,
        UMLAssociationView: 3,
        UMLIncludeView: 1,
      });
      await png(fromSpec.diagram._id);

      const fromMermaid = payload<Built>(
        await call("generate_diagram", {
          code: "---\ntitle: Shop use cases (Mermaid)\n---\nflowchart LR\n  C[Customer] --> P((Place order))\n  C --> Y((Pay))\n  P -->|include| Y\n  K[Clerk] --> R((Refund))",
          kind: "usecase",
        }),
      );
      expect(fromMermaid.diagram).toMatchObject({
        _type: "UMLUseCaseDiagram",
        name: "Shop use cases (Mermaid)",
      });
      expect(await viewCounts(fromMermaid.diagram._id)).toEqual({
        UMLActorView: 2,
        UMLUseCaseView: 3,
        UMLAssociationView: 3,
        UMLIncludeView: 1,
      });
      await png(fromMermaid.diagram._id);
    }, 60_000);

    it("#4: builds an activity diagram from a JSON spec and from Mermaid", async () => {
      const fromSpec = payload<Built>(
        await call("build_diagram", {
          result: "full",
          kind: "activity",
          name: "Checkout activity",
          spec: {
            nodes: [
              { id: "s", type: "initial" },
              { id: "a", name: "Pick items", type: "action" },
              { id: "d", name: "In stock?", type: "decision" },
              { id: "b", name: "Pay", type: "action" },
              { id: "e", type: "final" },
            ],
            flows: [
              { from: "s", to: "a" },
              { from: "a", to: "d" },
              { from: "d", to: "b", guard: "yes" },
              { from: "d", to: "e", guard: "no" },
              { from: "b", to: "e" },
            ],
          },
        }),
      );
      const fromMermaid = payload<Built>(
        await call("generate_diagram", {
          code: "flowchart TD\n  S((start)) --> A[Pick items]\n  A --> D{In stock?}\n  D -->|yes| B[Pay]\n  D -->|no| E((end))\n  B --> E",
          kind: "activity",
          name: "Checkout activity (Mermaid)",
        }),
      );

      for (const built of [fromSpec, fromMermaid]) {
        expect(built.diagram._type).toBe("UMLActivityDiagram");
        expect(await viewCounts(built.diagram._id)).toEqual({
          UMLControlNodeView: 3,
          UMLActionView: 2,
          UMLControlFlowView: 5,
        });
        await png(built.diagram._id);
      }
      expect(fromMermaid.diagram.name).toBe("Checkout activity (Mermaid)");
    }, 60_000);

    it("keeps plain Mermaid on StarUML's built-in API", async () => {
      expect(ok(await call("generate_diagram", { code: "classDiagram\n  class Plain" }))).toBe(
        "ok",
      );
      expect(await diagramNames()).toContain("Class Diagram by Mermaid");
    });
  });

  /**
   * Every tool call of the agent skill against the real StarUML, in the order the skill gives
   * them: the offline run only proves the server accepts them, this one that the extension builds
   * what each spec describes (#12).
   */
  describe("skill examples (#12)", () => {
    const tiers = new Map<string, Promise<ConnectedClient>>();
    /** The default client, or one per tier an example names (section 8: oo). */
    const client = (tools: string) => {
      if (tools === "core") return Promise.resolve(mcp);
      if (!tiers.has(tools)) {
        tiers.set(
          tools,
          connect({ catalog: new CatalogState(catalog.current, parseToolSelection(tools)) }),
        );
      }
      return tiers.get(tools)!;
    };
    afterAll(async () => {
      for (const tier of tiers.values()) await (await tier).close();
    });

    // A build takes StarUML seconds while other clients use it; section 8's derive several.
    it.each(skillExamples())(
      "SKILL.md line $line: $tool ($tools)",
      { timeout: 120_000 },
      async ({ tool, args, tools }) => {
        const result = await (await client(tools)).call(tool, args);
        expect(result.isError, text(result)).toBeFalsy();
        if (tool === "build_diagram") {
          // The extension answers terse by default: the diagram and counts, no ids.
          const built = JSON.parse(text(result)) as { diagram: Summary; created?: number };
          expect(built.diagram._id).toEqual(expect.any(String));
          expect(args.dryRun === true || built.created! > 0).toBe(true);
        }
        if (tool === "batch") {
          expect(JSON.parse(text(result))).toMatchObject({
            succeeded: (args.ops as unknown[]).length,
          });
        }
      },
    );

    /**
     * Section 4's read-back for every family: the spec diagram_as_text writes builds the same
     * diagram again. The copy is built with reuse off, since with it on a copy in the same
     * project would show the original's elements, and with duplicate names allowed, since an
     * internal block or parametric diagram adds its parts to the one block both draw.
     *
     * What extension 0.3.0 does not round-trip, which the skill says: a composite structure's
     * class lists its parts and ports among its attributes as well, so the copy's class gets
     * attributes of those names too; and an upsert of the spec into the diagram it came from
     * does not match parts inside a class, messages riding a connector, a timing lifeline's
     * states and segments or an overview's unnamed control nodes against what is there, and
     * adds them again.
     */
    const COPY_DIFFERS = ["composite"];
    const UPSERT_ADDS_AGAIN = ["composite", "communication", "timing", "overview"];
    const familyExamples = () => {
      const lines = readFileSync(SKILL_PATH, "utf8").split("\n");
      const from = lines.indexOf("## 4. Diagram families") + 1;
      const to = lines.indexOf("## 5. The build loop and drawing good UML") + 1;
      return skillExamples().filter(
        (e) => e.tool === "build_diagram" && e.line > from && e.line < to,
      );
    };
    it.each(familyExamples())(
      "$args.kind reads back as a spec that builds it again",
      async ({ args }) => {
        const specOf = async (diagram: string) =>
          JSON.parse(
            ok(await mcp.call("diagram_as_text", { diagram, format: "spec" })).split("\n")[0]!,
          ) as Record<string, unknown>;
        const kind = args.kind as string;
        const spec = await specOf(args.name as string);
        const copy = `${String(args.name)} copy`;
        ok(
          await mcp.call("build_diagram", {
            kind,
            name: copy,
            spec,
            reuse: false,
            allowDuplicateNames: true,
          }),
        );
        if (!COPY_DIFFERS.includes(kind)) expect(await specOf(copy)).toEqual(spec);

        const again = payload<{ created?: number; unchanged?: number }>(
          await mcp.call("build_diagram", { kind, name: args.name, spec, upsert: true }),
        );
        expect(again.unchanged).toBeGreaterThan(0);
        if (!UPSERT_ADDS_AGAIN.includes(kind)) {
          expect(again.created ?? 0, JSON.stringify(again)).toBe(0);
        }
      },
    );
  });

  describe("extended tier", () => {
    it("describe_endpoints indexes the unlisted endpoints and describes them", async () => {
      const index = payload<Record<string, Record<string, string>>>(
        await mcp.call("describe_endpoints"),
      );
      expect(index.project).toHaveProperty("save_project");
      expect(index.element).not.toHaveProperty("find_elements");

      const described = payload<Record<string, { request: { required?: string[] } }>>(
        await mcp.call("describe_endpoints", { names: ["create_diagram"] }),
      );
      expect(described.create_diagram!.request.required).toContain("type");
    });

    it("call_endpoint rejects a bad body before StarUML sees it", async () => {
      expect(
        failure(await mcp.call("call_endpoint", { name: "create_diagram", body: { parent: 1 } })),
      ).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(failure(await mcp.call("call_endpoint", { name: "nope", body: {} }))).toMatchObject({
        code: "UNKNOWN_ENDPOINT",
      });
    });

    it("serves the metamodel and endpoint catalogues as resources", async () => {
      const metamodel = await mcp.client.readResource({ uri: METAMODEL_URI });
      const types = JSON.parse((metamodel.contents[0] as { text: string }).text) as {
        metamodel: Record<string, unknown>;
      };
      expect(Object.keys(types.metamodel).length).toBeGreaterThan(100);

      const endpoints = await mcp.client.readResource({ uri: ENDPOINTS_URI });
      expect(JSON.parse((endpoints.contents[0] as { text: string }).text)).toEqual(
        catalog.current.compiled.manifest,
      );
    });
  });

  describe("access token", () => {
    it("is required once set through mcp-ext:set-token, sent with --ext-token, then cleared", async () => {
      const token = `live-${Date.now().toString(36)}`;
      const withToken = await connect({
        catalog: new CatalogState(catalog.current),
        extToken: token,
      });
      try {
        expect(
          payload<{ result: string }>(
            await command(mcp, { id: "mcp-ext:set-token", args: [token] }),
          ).result,
        ).toBe("set");

        const refused = failure(await mcp.call("find_elements", { type: "Project" }));
        expect(refused).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
        expect(text(await mcp.call("find_elements", { type: "Project" }))).toContain(
          "Hint: The extension requires an access token. In StarUML, Tools > MCP Extension > Server Info",
        );
        expect(ok(await mcp.call("doctor"))).toMatch(
          /extension +fail +http:\/\/localhost:58322 refused the request: Missing or wrong bearer token \[UNAUTHORIZED\]\n +fix +The extension requires an access token\./,
        );

        expect(
          payload<{ count: number }>(await withToken.call("find_elements", { type: "Project" }))
            .count,
        ).toBe(1);
        expect(ok(await withToken.call("doctor"))).toMatch(
          /extension +ok +0\.3\.\d+ at http:\/\/localhost:58322 \(access token sent\)/,
        );
        const wrong = await connect({ extToken: "wrong" });
        try {
          expect(text(await wrong.call("find_elements", { type: "Project" }))).toContain(
            "Hint: The extension rejected the access token this server sent.",
          );
        } finally {
          await wrong.close();
        }
      } finally {
        expect(
          payload<{ result: string }>(
            await command(withToken, { id: "mcp-ext:set-token", args: [""] }),
          ).result,
        ).toBe("cleared");
        await withToken.close();
      }
      // The doctor run above swapped the shared catalog for the bundled one; read the live one back.
      expect(ok(await mcp.call("doctor"))).toMatch(/extension +ok/);
      expect(catalog.current.source).toBe("live");
    }, 300_000);
  });

  describe("connectivity", () => {
    it("tells a missing extension apart from a stopped StarUML", async () => {
      const noExtension = await connect({ extPort: await closedPort() });
      try {
        const error = failure(await noExtension.call("find_elements", { type: "Project" }));
        expect(error.code).toBe("EXTENSION_UNREACHABLE");
        expect(ok(await noExtension.call("doctor"))).toMatch(/extension +fail +no answer at/);
      } finally {
        await noExtension.close();
      }
    });
  });

  describe("HTTP transport", () => {
    let server: RunningServer;

    beforeAll(async () => {
      server = await main(["node", "staruml-mcp", "--transport", "http", "--port", "0"]);
    });

    afterAll(async () => {
      await server.close();
    });

    it("lists the live tools and calls one through /mcp", async () => {
      const base = `http://127.0.0.1:${server.port}`;
      const list = await rpc(base, 1, "tools/list");
      expect((list.message.result!.tools as { name: string }[]).map((t) => t.name)).toContain(
        "call_endpoint",
      );

      const { message } = await rpc(base, 2, "tools/call", {
        name: "find_elements",
        arguments: { type: "Project" },
      });
      expect(message.result).toMatchObject({ content: [{ type: "text" }] });
      expect(message.result!.isError).toBeUndefined();

      const prompt = await rpc(base, 3, "prompts/get", { name: "review-diagram" });
      expect(JSON.stringify(prompt.message.result)).toContain("describe_diagram");
    });

    /** An SDK client in its own HTTP session, as Claude Code connects with --transport http. */
    const session = async (capabilities: ClientCapabilities = {}) => {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      );
      const client = new Client({ name: "staruml-mcp-live", version: "0" }, { capabilities });
      await client.connect(transport);
      const call = async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as CallToolResult;
      return { client, transport, call };
    };

    it("shows the SVG viewer in an HTTP session, from capabilities or a viewer read (#14)", async () => {
      const app = await session(UI_CAPABILITIES);
      const plain = await session();
      try {
        expect(app.transport.sessionId).toBeDefined();
        const list = async () =>
          JSON.parse(ok(await app.call("get_all_diagrams_info"))) as { id: string }[];
        const before = await list();
        ok(
          await app.call("generate_diagram", {
            code: "classDiagram\n  class HttpSessionA\n  class HttpSessionB\n  HttpSessionA --> HttpSessionB",
          }),
        );
        const id = (await list()).find((d) => !before.some((b) => b.id === d.id))!.id;

        const shown = (await app.call("view_diagram", { diagram: id })).structuredContent as {
          svg: string;
        };
        expect(shown.svg).toMatch(/^<svg [\s\S]*<\/svg>$/);
        expect(shown.svg).toContain(">HttpSessionA<");

        expect((await plain.call("view_diagram", { diagram: id })).content[0]!.type).toBe("image");
        await plain.client.readResource({ uri: VIEWER_URI });
        const read = (await plain.call("view_diagram", { diagram: id })).structuredContent as {
          svg: string;
        };
        expect(read.svg).toContain(">HttpSessionB<");
      } finally {
        await Promise.all([app.client.close(), plain.client.close()]);
      }
    });

    it("notifies every HTTP session when doctor switches the tier (#14)", async () => {
      const a = await session();
      const b = await session();
      const changed = { a: 0, b: 0 };
      a.client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed.a++);
      b.client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed.b++);
      try {
        ok(await a.call("doctor", { tools: "core,create_diagram" }));
        await vi.waitFor(() => {
          expect(changed.a).toBeGreaterThan(0);
          expect(changed.b).toBeGreaterThan(0);
        });
        const names = (await b.client.listTools()).tools.map((t) => t.name);
        expect(names).toContain("create_diagram");
      } finally {
        await a.call("doctor", { tools: "core" });
        await Promise.all([a.client.close(), b.client.close()]);
      }
    });

    it("listens on loopback only", async () => {
      // The machine's own LAN address reaches a socket bound to every interface, not this one.
      const lan = Object.values(networkInterfaces())
        .flat()
        .find((a) => a !== undefined && a.family === "IPv4" && !a.internal);
      if (lan === undefined) {
        console.info("[live] no LAN address to probe the HTTP binding from");
        return;
      }
      await expect(fetch(`http://${lan.address}:${server.port}/`)).rejects.toThrow();
      const local = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(local.status).toBe(200);
    });
  });
});
