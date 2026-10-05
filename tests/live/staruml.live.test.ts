/**
 * Runs every tool against a real StarUML (built-in API on 58321) and staruml-mcp-extension
 * (58322). Enabled with STARUML_LIVE=1; skipped otherwise so CI needs no StarUML.
 *
 * The suite saves the open project to a temp file, works in a fresh project and reopens the
 * original file at the end. Unsaved changes of the original survive only in the temp copy,
 * whose path is printed.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, type RunningServer } from "../../src/index.js";
import { closedPort } from "../support/fixture.js";
import { connect, text, type ConnectedClient } from "../support/mcp.js";
import { rpc } from "../support/sse.js";

const LIVE = process.env.STARUML_LIVE === "1";
const PNG_SIGNATURE = "89504e470d0a1a0a";

interface Element {
  _id: string;
  name?: string;
  model?: { _id: string };
  ownedViews?: { _id: string }[];
}

function ok(result: CallToolResult): string {
  expect(result.isError, text(result)).toBeFalsy();
  return text(result);
}

/** Tool texts are `<Prefix>: <json>` or bare JSON. */
function payload<T>(result: CallToolResult): T {
  const body = ok(result);
  return JSON.parse(body.slice(body.search(/[[{]/))) as T;
}

function failure(result: CallToolResult): { code: string; message: string } {
  expect(result.isError, text(result)).toBe(true);
  return (result.structuredContent as { error: { code: string; message: string } }).error;
}

/**
 * For calls extension v0.2.2 gets wrong inside StarUML 7.1.1. Success is not required, but a
 * failure must carry the extension's cause rather than a bare status line (issue #3).
 */
function tolerated(tool: string, result: CallToolResult): void {
  if (result.isError) {
    const { message } = failure(result);
    expect(message).not.toMatch(/^HTTP \d+/);
    console.warn(`[live] ${tool} failed upstream: ${message}`);
  }
}

describe.runIf(LIVE).sequential("live StarUML 7.1.1 + staruml-mcp-extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "staruml-mcp-live-"));
  const snapshot = join(dir, "snapshot.mdj");
  let mcp: ConnectedClient;
  let originalFile: string | null = null;
  let modelId: string;
  let generatedDiagramId: string;
  let packageId: string;

  beforeAll(async () => {
    mcp = await connect({});
    const info = payload<{ filename: string | null }>(await mcp.call("get_project_info"));
    originalFile = info.filename;
    ok(await mcp.call("save_project", { filename: snapshot }));
    console.info(`[live] open project saved to ${snapshot}; original file: ${originalFile}`);
    ok(await mcp.call("new_project"));
  }, 30_000);

  afterAll(async () => {
    await mcp.call("open_project", { filename: originalFile ?? snapshot });
    await mcp.close();
  }, 30_000);

  describe("built-in API (58321)", () => {
    it("lists diagrams of the fresh project", async () => {
      const diagrams = payload<{ id: string }[]>(await mcp.call("get_all_diagrams_info"));
      expect(Array.isArray(diagrams)).toBe(true);
    });

    it("reports the current diagram", async () => {
      expect(ok(await mcp.call("get_current_diagram_info"))).toMatch(
        /^(Current diagram: |No diagram is currently active\.)/,
      );
    });

    it("generates a class diagram from Mermaid", async () => {
      const before = payload<{ id: string }[]>(await mcp.call("get_all_diagrams_info"));

      expect(
        ok(
          await mcp.call("generate_diagram", {
            code: "classDiagram\n  class LiveA\n  class LiveB\n  LiveA --> LiveB",
          }),
        ),
      ).toBe("Diagram successfully generated in StarUML.");

      const after = payload<{ id: string }[]>(await mcp.call("get_all_diagrams_info"));
      const added = after.filter((d) => !before.some((b) => b.id === d.id));
      expect(added).toHaveLength(1);
      generatedDiagramId = added[0]!.id;
    });

    it("exports the generated diagram as PNG", async () => {
      const result = await mcp.call("get_diagram_image_by_id", { diagramId: generatedDiagramId });

      expect(result.isError).toBeFalsy();
      const image = result.content[0] as { type: string; data: string; mimeType: string };
      expect(image.type).toBe("image");
      expect(image.mimeType).toBe("image/png");
      expect(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    });

    it("surfaces StarUML's error for an unknown diagram id", async () => {
      const error = failure(await mcp.call("get_diagram_image_by_id", { diagramId: "nope" }));

      expect(error.code).toBe("UPSTREAM_ERROR");
      expect(error.message).toContain("Diagram not found");
    });

    it("surfaces StarUML's error for unsupported Mermaid", async () => {
      const error = failure(await mcp.call("generate_diagram", { code: "bogus" }));

      expect(error.message).toContain("Unsupported diagram type");
    });
  });

  describe("extension (58322)", () => {
    it("lists commands", async () => {
      const listed = payload<{ count: number; ids: string[] }>(await mcp.call("get_all_commands"));
      expect(listed.ids).toHaveLength(listed.count);
      // v0.2.2 reads app.commands.commandNames, which holds only commands registered with a
      // display name and can be empty, so project:save is not guaranteed to be listed.
      if (!listed.ids.includes("project:save")) {
        console.warn(`[live] get_all_commands listed ${listed.count} ids without project:save`);
      }
    });

    it("executes a registered command", async () => {
      ok(await mcp.call("execute_command", { id: "view:fit-to-window" }));
    });

    it("rejects an unregistered command with the extension's message", async () => {
      const error = failure(await mcp.call("execute_command", { id: "nope:nope" }));

      expect(error).toMatchObject({
        code: "REQUEST_REJECTED",
        message: "Command not registered: nope:nope",
      });
    });

    it("reports project info", async () => {
      const info = payload<{ project: { _id: string } }>(await mcp.call("get_project_info"));
      expect(info.project._id).toEqual(expect.any(String));
    });

    it("finds or creates a model", async () => {
      const found = payload<{ count: number; elements: Element[] }>(
        await mcp.call("find_elements", { type: "UMLModel" }),
      );
      if (found.count > 0) {
        modelId = found.elements[0]!._id;
        return;
      }
      // ProjectManager.newProject() can leave the project without a model, unlike File > New.
      const info = payload<{ project: { _id: string } }>(await mcp.call("get_project_info"));
      modelId = payload<Element>(
        await mcp.call("create_element", {
          type: "UMLModel",
          parentId: info.project._id,
          name: "LiveModel",
        }),
      )._id;
    });

    it("creates, reads, renames and finds a package", async () => {
      const created = payload<Element>(
        await mcp.call("create_element", {
          type: "UMLPackage",
          parentId: modelId,
          name: "LivePkg",
        }),
      );
      packageId = created._id;

      expect(payload<Element>(await mcp.call("get_element_by_id", { id: packageId })).name).toBe(
        "LivePkg",
      );
      expect(
        payload<Element>(
          await mcp.call("update_element", { id: packageId, field: "name", value: "LivePkg2" }),
        ).name,
      ).toBe("LivePkg2");
      const found = payload<{ count: number }>(
        await mcp.call("find_elements", { type: "UMLPackage", name: "LivePkg2" }),
      );
      expect(found.count).toBe(1);
    });

    it("creates, switches to and closes a diagram", async () => {
      const diagram = payload<Element>(
        await mcp.call("create_diagram", {
          type: "UMLClassDiagram",
          parentId: packageId,
          name: "LiveDiagram",
        }),
      );

      ok(await mcp.call("switch_diagram", { id: diagram._id }));
      ok(await mcp.call("close_diagram", { id: diagram._id }));
    });

    it("connects two generated class views with an edge", async () => {
      const diagram = payload<Element>(
        await mcp.call("get_element_by_id", { id: generatedDiagramId }),
      );
      const classes = payload<{ elements: Element[] }>(
        await mcp.call("find_elements", { type: "UMLClass" }),
      ).elements;
      const classA = classes.find((c) => c.name === "LiveA")!;
      const classB = classes.find((c) => c.name === "LiveB")!;
      const views = await Promise.all(
        diagram.ownedViews!.map(async (v) =>
          payload<Element>(await mcp.call("get_element_by_id", { id: v._id })),
        ),
      );
      const viewOf = (model: Element) => views.find((v) => v.model?._id === model._id)!;

      // v0.2.2 fails like create_element_with_view below (createModelAndView signature).
      tolerated(
        "create_edge_with_view",
        await mcp.call("create_edge_with_view", {
          type: "UMLDependency",
          parentId: classA._id,
          diagramId: generatedDiagramId,
          tailViewId: viewOf(classA)._id,
          headViewId: viewOf(classB)._id,
          name: "uses",
        }),
      );
    });

    it("returns a tool result for create_element_with_view", async () => {
      // Extension v0.2.2 fails here inside StarUML 7.1.1 (createModelAndView takes one options
      // object); only the MCP-side contract is checked until the extension is fixed.
      const result = await mcp.call("create_element_with_view", {
        type: "UMLClass",
        parentId: modelId,
        diagramId: generatedDiagramId,
        name: "LiveC",
      });
      expect(result.content.length).toBeGreaterThan(0);
    });

    it("deletes the package and then reports it missing", async () => {
      expect(
        payload<{ deleted: string }>(await mcp.call("delete_element", { id: packageId })),
      ).toMatchObject({ deleted: packageId });

      const error = failure(await mcp.call("get_element_by_id", { id: packageId }));
      expect(error).toEqual(
        expect.objectContaining({
          code: "REQUEST_REJECTED",
          message: `Element not found: ${packageId}`,
        }),
      );
    });

    it("saves, creates and reopens projects", async () => {
      const saved = join(dir, "saved.mdj");

      expect(
        payload<{ filename: string }>(await mcp.call("save_project", { filename: saved })),
      ).toEqual({ filename: saved });
      expect(existsSync(saved)).toBe(true);
      tolerated("save_project", await mcp.call("save_project"));

      // v0.2.2 calls app.project.saveAs, which StarUML 7.1.1 lacks; either outcome is fine as
      // long as a failure carries the cause instead of a bare status line.
      tolerated(
        "save_project_as",
        await mcp.call("save_project_as", { filename: join(dir, "as.mdj") }),
      );

      expect(ok(await mcp.call("new_project"))).toBe("New project created.");
      expect(
        payload<{ filename: string | null }>(await mcp.call("get_project_info")).filename,
      ).toBeFalsy();

      ok(await mcp.call("open_project", { filename: saved }));
      expect(payload<{ filename: string }>(await mcp.call("get_project_info")).filename).toBe(
        saved,
      );
    });
  });

  describe("connectivity", () => {
    it("tells a missing extension apart from a stopped StarUML", async () => {
      const noExtension = await connect({ extPort: await closedPort() });
      try {
        const error = failure(await noExtension.call("get_project_info"));
        expect(error.code).toBe("EXTENSION_UNREACHABLE");
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

    it("calls a tool through /mcp", async () => {
      const { message } = await rpc(`http://127.0.0.1:${server.port}`, 1, "tools/call", {
        name: "get_all_diagrams_info",
        arguments: {},
      });

      expect(message.result).toMatchObject({ content: [{ type: "text" }] });
      expect(message.result!.isError).toBeUndefined();
    });
  });
});
