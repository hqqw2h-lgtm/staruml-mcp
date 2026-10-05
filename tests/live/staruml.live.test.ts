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
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diagnose, healthy } from "../../src/doctor.js";
import { CatalogState } from "../../src/extension-tools.js";
import { main, type RunningServer } from "../../src/index.js";
import { BUNDLED_MANIFEST, toolName } from "../../src/manifest.js";
import { diagramImageUri, diagramTextUri, ENDPOINTS_URI, METAMODEL_URI } from "../../src/server.js";
import { StarUMLClient } from "../../src/staruml-client.js";
import { VIEWER_URI } from "../../src/viewer.js";
import { CORE_ENDPOINTS, parseToolSelection } from "../../src/tiers.js";
import { closedPort } from "../support/fixture.js";
import { decodePng, differingRows } from "../support/png.js";
import { connect, text, UI_CAPABILITIES, type ConnectedClient } from "../support/mcp.js";
import { skillExamples } from "../support/skill.js";
import { loadViewer } from "../support/viewer.js";
import { rpc } from "../support/sse.js";

const LIVE = process.env.STARUML_LIVE === "1";
const PNG_SIGNATURE = "89504e470d0a1a0a";

interface Summary {
  _id: string;
  _type: string;
  name?: string;
  _parent?: string;
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
    payload<{ elements: Summary[] }>(await call("get_views_of", { id }))
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
    await mcp.call("open_project", { filename: originalFile ?? snapshot });
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
        await call("create_element", { type: "UMLModel", parentId: projectId, name: "Live" }),
      )._id;
    });

    it("creates, reads, renames and finds a package as compact summaries", async () => {
      const created = payload<Summary>(
        await call("create_element", { type: "UMLPackage", parentId: modelId, name: "LivePkg" }),
      );
      // The name echoes the argument and is dropped; summaries carry no other attribute.
      expect(created).toEqual({ _id: expect.any(String), _type: "UMLPackage", _parent: modelId });
      packageId = created._id;

      expect(payload<Summary>(await call("get_element_by_id", { id: packageId }))).toEqual({
        _id: packageId,
        _type: "UMLPackage",
        name: "LivePkg",
        _parent: modelId,
      });
      expect(
        payload<Summary>(
          await call("update_element", { id: packageId, field: "name", value: "LivePkg2" }),
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
          id: modelId,
          fields: ["name", "ownedElements"],
          depth: 1,
        }),
      );
      expect(model.ownedElements).toEqual(
        expect.arrayContaining([expect.objectContaining({ _id: packageId, name: "LivePkg2" })]),
      );
      const full = payload<Summary>(
        await call("get_element_by_id", { id: packageId, summary: false }),
      );
      expect(full.visibility).toBe("public");
    });

    it("creates, switches to and closes a diagram", async () => {
      const diagram = payload<Summary>(
        await call("create_diagram", {
          type: "UMLClassDiagram",
          parentId: packageId,
          name: "LiveDiagram",
        }),
      );
      classDiagramId = diagram._id;

      expect(payload<Summary>(await call("switch_diagram", { id: classDiagramId }))._id).toBe(
        classDiagramId,
      );
      ok(await call("close_diagram", { id: classDiagramId }));
      ok(await call("switch_diagram", { id: classDiagramId }));
    });

    it("creates classes with views and connects them", async () => {
      const place = async (name: string, x: number) =>
        payload<Created>(
          await call("create_element_with_view", {
            type: "UMLClass",
            parentId: packageId,
            diagramId: classDiagramId,
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
          diagramId: classDiagramId,
          tailViewId: book.view!._id,
          headViewId: author.view!._id,
          name: "writtenBy",
        }),
      );
      expect(edge.model!._type).toBe("UMLAssociation");
      ids.edgeView = edge.view!._id;

      const generalization = payload<Created>(
        await call("create_relationship", {
          type: "UMLDependency",
          tailId: ids.book,
          headId: ids.author,
        }),
      );
      expect(generalization.model!._type).toBe("UMLDependency");
      expect(generalization.view).toBeUndefined();
    });

    it("reports StarUML's refusal of an invalid connection as STARUML_ERROR", async () => {
      const ucd = payload<Summary>(
        await call("create_diagram", { type: "UMLUseCaseDiagram", parentId: modelId }),
      );
      const actor = payload<Created>(
        await call("create_element_with_view", {
          type: "UMLActor",
          parentId: modelId,
          diagramId: ucd._id,
        }),
      );
      const useCase = payload<Created>(
        await call("create_element_with_view", {
          type: "UMLUseCase",
          parentId: modelId,
          diagramId: ucd._id,
          x: 300,
        }),
      );

      expect(
        failure(
          await call("create_relationship", {
            type: "UMLInclude",
            diagramId: ucd._id,
            tailId: actor.view!._id,
            headId: useCase.view!._id,
          }),
        ),
      ).toMatchObject({ code: "STARUML_ERROR", status: 422 });
    });

    it("adds attributes, operations, parameters and template parameters", async () => {
      ids.title = payload<Summary>(
        await call("add_attribute", { ownerId: ids.book, name: "title", type: "String" }),
      )._id;
      const lend = payload<Summary>(
        await call("add_operation", {
          ownerId: ids.book,
          name: "lend",
          parameters: [{ name: "days", type: "int" }],
          returnType: "boolean",
        }),
      );
      expect(lend._type).toBe("UMLOperation");
      expect(
        payload<Summary>(
          await call("add_parameter", { operationId: lend._id, name: "note", type: "String" }),
        )._type,
      ).toBe("UMLParameter");
      expect(
        payload<Summary>(await call("add_template_parameter", { ownerId: ids.book, name: "T" }))
          ._type,
      ).toBe("UMLTemplateParameter");
    });

    it("adds enumeration literals, slots and tags", async () => {
      const color = payload<Summary>(
        await call("create_element", { type: "UMLEnumeration", parentId: modelId, name: "Color" }),
      );
      expect(
        payload<Summary>(
          await call("add_enumeration_literal", { enumerationId: color._id, name: "RED" }),
        )._type,
      ).toBe("UMLEnumerationLiteral");

      const copy = payload<Summary>(
        await call("create_element", {
          type: "UMLObject",
          parentId: modelId,
          name: "dune",
          properties: { classifier: { $ref: ids.book } },
        }),
      );
      expect(
        payload<Summary>(
          await call("add_slot", {
            instanceId: copy._id,
            definingFeature: ids.title,
            value: '"Dune"',
          }),
        )._type,
      ).toBe("UMLSlot");
      expect(
        payload<Summary>(
          await call("add_tag", { elementId: ids.book, name: "pages", kind: "number", value: 412 }),
        )._type,
      ).toBe("Tag");
    });

    it("sets stereotype and documentation", async () => {
      // Requested fields equal to an argument are dropped like any echo, so read them back.
      ok(await call("set_stereotype", { elementId: ids.book, stereotype: "entity" }));
      ok(
        await call("set_documentation", {
          elementId: ids.book,
          documentation: "A published work.",
          fields: ["documentation"],
        }),
      );

      expect(
        payload<Summary>(
          await call("get_element_by_id", {
            id: ids.book,
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
          ops: [
            {
              path: "/create_diagram",
              body: { type: "UMLClassDiagram", parentId: packageId, name: "Batched" },
              as: "d",
            },
            ...["Shelf", "Copy"].map((name, i) => ({
              path: "/create_element_with_view",
              body: {
                type: "UMLClass",
                parentId: packageId,
                diagramId: "$d",
                name,
                x: 100 + 250 * i,
                y: 100,
              },
              as: name.toLowerCase(),
            })),
            { path: "/add_attribute", body: { ownerId: "$shelf.model", name: "code" } },
            {
              path: "/create_edge_with_view",
              body: {
                type: "UMLAssociation",
                diagramId: "$d",
                tailViewId: "$shelf.view",
                headViewId: "$copy.view",
              },
            },
          ],
        }),
      );
      expect(built.succeeded).toBe(5);
      expect(JSON.stringify(built)).not.toContain('"path"');
      const shelf = built.results[1]!.data.model!._id;
      ids.batchedDiagram = built.results[0]!.data._id;
      expect(await classViews(shelf)).toHaveLength(1);

      expect(payload<{ modified: boolean }>(await call("is_modified")).modified).toBe(true);
      ok(await call("undo"));
      expect(failure(await call("get_element_by_id", { id: shelf })).code).toBe("NOT_FOUND");
      ok(await call("redo"));
      expect(payload<Summary>(await call("get_element_by_id", { id: shelf })).name).toBe("Shelf");
    });

    it("refuses a dangling batch reference locally and rolls back an atomic failure", async () => {
      expect(
        failure(await call("batch", { ops: [{ path: "/delete_element", body: { id: "$nope" } }] })),
      ).toMatchObject({
        code: "INVALID_ARGUMENT",
        message: "ops.0.body.id: $nope names no earlier op",
      });

      const error = failure(
        await call("batch", {
          ops: [
            {
              path: "/create_element",
              body: { type: "UMLClass", parentId: packageId, name: "Ghost" },
            },
            { path: "/delete_element", body: { id: "missing-id" } },
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
      expect(await count("get_edge_views_of", { id: ids.bookView })).toBeGreaterThan(0);
      expect(await count("get_relationships_of", { id: ids.book })).toBeGreaterThanOrEqual(2);
      expect(await count("get_refs_to", { id: ids.book })).toBeGreaterThan(0);
      expect(await count("get_connected_node_views", { id: ids.bookView })).toBe(1);
    });

    it("lays out, moves, resizes, styles and reorders views", async () => {
      ok(await call("layout_diagram", { id: classDiagramId, direction: "LR" }));
      // preset echoes the argument and is dropped from the answer.
      const laid = payload<{ separations: { node: number; rank: number }; fitted: number }>(
        await call("layout_diagram", {
          id: classDiagramId,
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
          await call("route_edges", { diagramId: classDiagramId, lineStyle: "rectilinear" }),
        ).edges,
      ).toBeGreaterThan(0);
      // EdgeView.lineStyle 0 is LS_RECTILINEAR (StarUML core/graphics.js).
      expect(
        payload<Summary>(
          await call("get_element_by_id", { id: ids.edgeView, fields: ["lineStyle"] }),
        ).lineStyle,
      ).toBe(0);
      ok(await call("move_views", { ids: [ids.bookView], dx: 10, dy: 5 }));
      ok(await call("resize_node", { id: ids.bookView, width: 180, height: 90 }));
      ok(await call("set_view_style", { ids: [ids.bookView], fillColor: "#ffeecc" }));
      ok(await call("set_z_order", { ids: [ids.bookView], position: "front" }));

      const view = payload<Summary>(
        await call("get_element_by_id", { id: ids.bookView, fields: ["width", "fillColor"] }),
      );
      // StarUML widens a class view to fit its compartments when it is next drawn.
      expect(view.fillColor, JSON.stringify(view)).toBe("#ffeecc");
      expect(view.width, JSON.stringify(view)).toBeGreaterThanOrEqual(180);
    });

    it("sets and reads the selection and editor state", async () => {
      ok(await call("switch_diagram", { id: classDiagramId }));
      ok(await call("set_selection", { viewIds: [ids.bookView] }));
      expect(JSON.stringify(payload(await call("get_selection")))).toContain(ids.bookView);

      ok(await call("set_editor_state", { zoom: 1.5 }));
      expect(payload<{ zoom: number }>(await call("get_editor_state")).zoom).toBe(1.5);
      ok(await call("set_editor_state", { zoom: 1 }));
    });

    it("exports a diagram as a PNG image block, to a file, to PDF and to HTML", async () => {
      const result = await call("export_diagram", { id: classDiagramId });
      ok(result);
      const image = result.content[0] as { type: string; data: string; mimeType: string };
      expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
      expect(JSON.parse(text({ content: result.content.slice(1) }))).toMatchObject({
        width: expect.any(Number),
        bytes: expect.any(Number),
      });

      const svg = join(dir, "diagram.svg");
      ok(await call("export_diagram", { id: classDiagramId, format: "svg", path: svg }));
      expect(existsSync(svg)).toBe(true);
      const pdf = join(dir, "diagram.pdf");
      ok(await call("export_pdf", { path: pdf, ids: [classDiagramId] }));
      expect(existsSync(pdf)).toBe(true);
      const html = join(dir, "html");
      ok(await call("export_html", { path: html }));
      expect(existsSync(join(html, "index.html"))).toBe(true);
    }, 60_000);

    it("reads a diagram back as text, searches types and validates the model (#11)", async () => {
      const described = ok(await call("describe_diagram", { diagramId: classDiagramId }));
      expect(described.split("\n")[0]).toMatch(
        /^UMLClassDiagram "LiveDiagram" in ".+": 2 nodes, \d+ edges$/,
      );
      expect(described).toContain('"Book" -[UMLAssociation "writtenBy"]-> "Author"');

      for (const format of ["mermaid", "plantuml"]) {
        const exported = payload<{ kind: string; text: string }>(
          await call("export_text", { diagramId: classDiagramId, format }),
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
      const mermaid = await call("diagram_as_text", { id: classDiagramId });
      ok(mermaid);
      const source = (mermaid.content[0] as { text: string }).text;
      expect(source).toMatch(/^---\ntitle: "LiveDiagram"\n---\nclassDiagram\n/);
      expect(source).toContain("Book -- Author : writtenBy");
      expect(JSON.parse((mermaid.content[1] as { text: string }).text)).toEqual({ kind: "class" });

      const plantuml = await call("diagram_as_text", { id: classDiagramId, format: "plantuml" });
      expect(ok(plantuml)).toMatch(/^@startuml\ntitle LiveDiagram\n[\s\S]*@enduml\n/);

      ok(await call("switch_diagram", { id: classDiagramId }));
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
          mermaid: source,
          name: "LiveRoundTrip",
          parentId: packageId,
        }),
      );
      const again = ok(await call("describe_diagram", { diagramId: rebuilt.diagram._id }));
      expect(again).toContain('"Book" -[UMLAssociation "writtenBy"]-> "Author"');
      // Every node and edge line of the original comes back. Extension builds that reuse
      // same-named elements elsewhere in the project also draw their other relationships (here
      // the Book -> Author dependency, which has no view on LiveDiagram).
      const original = ok(await call("describe_diagram", { diagramId: classDiagramId }));
      expect(again.split("\n").slice(1)).toEqual(
        expect.arrayContaining(original.split("\n").slice(1)),
      );
    });

    it("prompts name the reads, which run against StarUML as written (#11)", async () => {
      const { prompts } = await mcp.client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual(["model-codebase", "review-diagram"]);

      const review = await mcp.client.getPrompt({
        name: "review-diagram",
        arguments: { diagramId: classDiagramId },
      });
      const steps = (review.messages[0]!.content as { text: string }).text;
      expect(steps).toContain(`describe_diagram({diagramId: "${classDiagramId}"})`);
      expect(steps).toContain(`diagram_as_text({id: "${classDiagramId}"})`);
      // Step 2 as the prompt describes it: the diagram's owner from get_element_by_id.
      const owner = payload<Summary>(
        await call("get_element_by_id", { id: classDiagramId }),
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
        const result = await app.call("view_diagram", { id: classDiagramId });
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

      const fallback = await call("view_diagram", { id: classDiagramId });
      const image = fallback.content[0] as { type: string; data: string };
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
              body: { type: "UMLClass", parentId: modelId, name: "Gone" },
            },
            { path: "/delete_element", body: { id: "missing-id" } },
          ],
        }),
      ) as { details?: { index: number; results: unknown[] } };
      expect(error.details).toMatchObject({ index: 1, results: [{ data: { name: "Gone" } }, {}] });

      const read = payload<{ results: { data: Summary }[] }>(
        await call("batch", {
          ops: [
            {
              path: "/get_element_by_id",
              body: { id: modelId, fields: ["ownedElements"] },
              as: "m",
            },
            { path: "/get_element_by_id", body: { id: "$m.ownedElements.0" } },
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
          kind: "class",
          spec: {
            classes: [{ name: "Shelf2", attributes: ["+code: String"] }, { name: "Copy2" }],
            relations: [{ from: "Shelf2", to: "Copy2", type: "composition" }],
          },
          name: "LiveBuilt",
          parentId: packageId,
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
          parentId: packageId,
          upsert: true,
        }),
      );
      expect(upserted.upserted).toBe(true);
      expect(upserted.created).toBeGreaterThan(0);
    });

    it("lists code generators, generates Java from a class and reverses it", async () => {
      const { generators } = payload<{ generators: { language: string; installed: boolean }[] }>(
        await call("list_code_generators"),
      );
      expect(generators.find((g) => g.language === "java")?.installed).toBe(true);

      const out = join(dir, "java");
      const generated = payload<{ count: number; files: string[] }>(
        await call("generate_code", { language: "java", baseId: ids.book, path: out }),
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
        await call("export_diagrams", { path: out, ids: [classDiagramId] }),
      );
      expect(exported.count).toBe(1);
      expect(existsSync(exported.files[0]!.file)).toBe(true);
    }, 60_000);

    it("deletes the package and then reports it NOT_FOUND", async () => {
      expect(
        payload<{ models_deleted: number }>(await call("delete_element", { id: packageId }))
          .models_deleted,
      ).toBeGreaterThan(0);

      expect(failure(await call("get_element_by_id", { id: packageId }))).toMatchObject({
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

    it("called every listed tool and every endpoint of the bundled manifest", async () => {
      const { tools } = await mcp.client.listTools();
      const live = catalog.current.compiled.manifest.endpoints.map((e) => e.path);
      // The bundled manifest is the contract this server is tested against; the running
      // extension must offer all of it. A newer 0.3.x build may add endpoints, which the
      // server serves from the live manifest and this suite does not call.
      const bundled = BUNDLED_MANIFEST.endpoints.map((e) => e.path);
      expect(live).toEqual(expect.arrayContaining(bundled));
      const newer = live.filter((p) => !bundled.includes(p));
      if (newer.length > 0)
        console.info(`[live] endpoints newer than the bundle: ${newer.join(" ")}`);
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
        await call("get_element_by_id", { id, fields: ["ownedViews"], depth: 1 }),
      );
      const counts: Record<string, number> = {};
      for (const view of ownedViews) counts[view._type] = (counts[view._type] ?? 0) + 1;
      return counts;
    };

    /** The diagram exported through export_diagram as a decoded PNG. */
    const png = async (id: string) => {
      const result = await call("export_diagram", { id });
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
      expect(payload<Summary>(await call("get_element_by_id", { id: model })).name).toBe(
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
            mermaid: `sequenceDiagram\n  participant W as WebApp${lifelines}`,
            name: "Break",
          }),
        );
        ok(
          await call("update_element", { id: built.ids.WebApp!.model, field: "name", value: name }),
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
    it.each(skillExamples())("SKILL.md line $line: $tool", async ({ tool, args }) => {
      const result = await mcp.call(tool, args);
      expect(result.isError, text(result)).toBeFalsy();
      if (tool === "build_diagram") {
        const built = JSON.parse(text(result)) as { diagram: Summary; ids: object };
        expect(built.diagram._id).toEqual(expect.any(String));
        expect(Object.keys(built.ids).length).toBeGreaterThan(0);
      }
      if (tool === "batch") {
        expect(JSON.parse(text(result))).toMatchObject({
          succeeded: (args.ops as unknown[]).length,
        });
      }
    });
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
        failure(await mcp.call("call_endpoint", { name: "create_diagram", body: { parentId: 1 } })),
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
      expect(JSON.stringify(prompt.message.result)).toContain("describe_diagram(");
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
