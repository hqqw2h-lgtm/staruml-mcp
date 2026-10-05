/**
 * Runs every tool against a real StarUML (built-in API on 58321) and staruml-mcp-extension 0.3.x
 * (58322). Enabled with STARUML_LIVE=1; skipped otherwise so CI needs no StarUML.
 *
 * The suite saves the open project to a temp file, works in a fresh project and reopens the
 * original file at the end. Unsaved changes of the original survive only in the temp copy,
 * whose path is printed.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diagnose, healthy } from "../../src/doctor.js";
import { CatalogState, HAND_WRITTEN_TOOLS } from "../../src/extension-tools.js";
import { main, type RunningServer } from "../../src/index.js";
import { toolName } from "../../src/manifest.js";
import { diagramImageUri } from "../../src/server.js";
import { StarUMLClient } from "../../src/staruml-client.js";
import { closedPort } from "../support/fixture.js";
import { connect, text, type ConnectedClient } from "../support/mcp.js";
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

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    called.add(name);
    return mcp.call(name, args);
  };

  beforeAll(async () => {
    const diagnosis = await diagnose(new StarUMLClient());
    expect(healthy(diagnosis.checks), JSON.stringify(diagnosis.checks)).toBe(true);
    catalog = new CatalogState(diagnosis.catalog);
    mcp = await connect({ catalog });
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
    it("reads the live manifest and offers one tool per endpoint", async () => {
      expect(catalog.current.source).toBe("live");
      expect(catalog.current.compiled.manifest.extension.version).toMatch(/^0\.3\./);
      const { tools } = await mcp.client.listTools();
      const endpoints = catalog.current.compiled.manifest.endpoints.map((e) => toolName(e.path));
      expect(tools.map((t) => t.name).sort()).toEqual([...HAND_WRITTEN_TOOLS, ...endpoints].sort());
      for (const tool of tools) expect(tool.description, tool.name).toMatch(/^[^\n]{1,100}$/);
    });

    it("doctor reports every check ok", async () => {
      const report = ok(await call("doctor"));
      expect(report).toMatch(/^node +ok/);
      expect(report).toMatch(/staruml +ok +7\./);
      expect(report).not.toMatch(/ fail /);
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
      expect(ok(await call("execute_command", { id: "view:fit-to-window" }))).toBe("ok");

      expect(failure(await call("execute_command", { id: "nope:nope" }))).toMatchObject({
        code: "NOT_FOUND",
        status: 404,
        message: "Command not registered: nope:nope",
      });
    });

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

    it("introspects versions and the debug surface", async () => {
      const info = payload<{ staruml: { version: string }; extension: { version: string } }>(
        await call("introspect", { include: [] }),
      );
      expect(info.staruml.version).toMatch(/^7\./);
      expect(info.extension.version).toMatch(/^0\.3\./);

      expect(payload<{ app_keys: string[] }>(await call("debug")).app_keys).toContain("project");
    });

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

    it("called every listed tool", async () => {
      const { tools } = await mcp.client.listTools();
      expect(tools.map((t) => t.name).filter((n) => !called.has(n))).toEqual([]);
    });
  });

  describe("connectivity", () => {
    it("tells a missing extension apart from a stopped StarUML", async () => {
      const noExtension = await connect({ extPort: await closedPort() });
      try {
        const error = failure(await noExtension.call("get_project_info"));
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
      const listed = await rpc(base, 1, "tools/list");
      expect((listed.message.result!.tools as unknown[]).length).toBeGreaterThan(30);

      const { message } = await rpc(base, 2, "tools/call", {
        name: "find_elements",
        arguments: { type: "Project" },
      });
      expect(message.result).toMatchObject({ content: [{ type: "text" }] });
      expect(message.result!.isError).toBeUndefined();
    });
  });
});
