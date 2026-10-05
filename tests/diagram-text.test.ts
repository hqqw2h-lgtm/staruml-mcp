import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DIAGRAM_AS_TEXT_DESCRIPTION } from "../src/diagram-text.js";
import { bundledCatalog, CatalogState } from "../src/extension-tools.js";
import { diagramTextUri } from "../src/server.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
/** What extension 0.3.0's /export_text answers for a two-class diagram (live, StarUML 7.1.1). */
const MERMAID =
  '---\ntitle: "Probe"\n---\nclassDiagram\n  class Order {\n    +id: UUID\n  }\n  class Customer\n  Customer -- Order : places\n';
const PLANTUML =
  '@startuml\ntitle Probe\nclass "Order" as C0 {\n  +id: UUID\n}\nclass "Customer" as C1\nC1 -- C0 : places\n@enduml\n';
const DIAGRAM = { _id: "D1/+=", _type: "UMLClassDiagram", name: "Probe" };

const answer = (format: string, text: string, warnings: string[] = []) => ({
  success: true,
  data: { diagram: DIAGRAM, kind: "class", format, text, warnings },
});

const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
const config = () => ({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
let mcp: ConnectedClient;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  mcp = await connect(config());
});

afterEach(() => {
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await mcp.close();
  await Promise.all([builtin.stop(), extension.stop()]);
});

describe("diagram_as_text", () => {
  it("is listed read-only with an optional id and format", async () => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === "diagram_as_text")!;

    expect(tool.description).toBe(DIAGRAM_AS_TEXT_DESCRIPTION);
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "Diagram _id; default the current one." },
        format: { type: "string", enum: ["mermaid", "plantuml"], description: "Default mermaid." },
      },
    });
  });

  it("answers the Mermaid as text of its own, then the kind", async () => {
    extension.reply("/export_text", { body: answer("mermaid", MERMAID) });

    const result = await mcp.call("diagram_as_text", { id: "D1/+=" });

    expect(extension.requests).toEqual([
      { method: "POST", path: "/export_text", body: { diagramId: "D1/+=", format: "mermaid" } },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: MERMAID },
      { type: "text", text: '{"kind":"class"}' },
    ]);
  });

  it("writes PlantUML and passes the warnings on", async () => {
    const warnings = ["Note views are not written"];
    extension.reply("/export_text", { body: answer("plantuml", PLANTUML, warnings) });

    const result = await mcp.call("diagram_as_text", { id: "D1/+=", format: "plantuml" });

    expect(extension.requests[0]!.body).toEqual({ diagramId: "D1/+=", format: "plantuml" });
    expect(result.content).toEqual([
      { type: "text", text: PLANTUML },
      { type: "text", text: JSON.stringify({ kind: "class", warnings }) },
    ]);
  });

  it("writes the current diagram and names its id", async () => {
    builtin.reply("/get_current_diagram_info", {
      body: { success: true, data: { id: "D1/+=", name: "Probe", type: "UMLClassDiagram" } },
    });
    extension.reply("/export_text", { body: answer("mermaid", MERMAID) });

    const result = await mcp.call("diagram_as_text");

    expect(extension.requests[0]!.body).toEqual({ diagramId: "D1/+=", format: "mermaid" });
    expect(text({ content: result.content.slice(1) })).toBe('{"id":"D1/+=","kind":"class"}');
  });

  it("asks for an id when no diagram is open", async () => {
    builtin.reply("/get_current_diagram_info", { body: { success: true, data: null } });

    const result = await mcp.call("diagram_as_text");

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "Failed to write diagram as text: No diagram is open in StarUML. [INVALID_ARGUMENT]\nHint: Pass id; get_all_diagrams_info lists the diagrams.",
    );
    expect(extension.requests).toEqual([]);
  });

  it("passes the extension's refusal of a diagram it cannot write through", async () => {
    extension.reply("/export_text", {
      status: 400,
      body: {
        success: false,
        code: "INVALID_ARGUMENT",
        error: "UMLComponentDiagram cannot be written as text",
      },
    });

    const result = await mcp.call("diagram_as_text", { id: "D2" });

    expect(text(result)).toBe(
      "Failed to write diagram as text: UMLComponentDiagram cannot be written as text [INVALID_ARGUMENT, /export_text, HTTP 400]",
    );
  });

  it("needs a compatible extension", async () => {
    const off = await connect({
      ...config(),
      catalog: new CatalogState({ ...bundledCatalog(), enabled: false }),
    });
    try {
      const result = await off.call("diagram_as_text", { id: "D1" });

      expect(result.structuredContent).toEqual({
        error: {
          code: "EXTENSION_REQUIRED",
          message: "Diagrams are written as text by staruml-mcp-extension 0.3's export_text",
          hint: expect.stringContaining("Install it from https://github.com/"),
        },
      });
      expect(extension.requests).toEqual([]);
    } finally {
      await off.close();
    }
  });
});

describe("staruml://diagram/{id}.mmd and .puml", () => {
  it("reads a diagram as Mermaid with its kind in _meta", async () => {
    extension.reply("/export_text", { body: answer("mermaid", MERMAID) });
    const uri = diagramTextUri("D1/+=", "mermaid");

    const { contents } = await mcp.client.readResource({ uri });

    expect(uri).toBe("staruml://diagram/D1%2F%2B%3D.mmd");
    expect(extension.requests[0]!.body).toEqual({ diagramId: "D1/+=", format: "mermaid" });
    expect(contents).toEqual([
      { uri, mimeType: "text/plain", text: MERMAID, _meta: { kind: "class" } },
    ]);
  });

  it("reads PlantUML with the warnings in _meta", async () => {
    extension.reply("/export_text", { body: answer("plantuml", PLANTUML, ["Notes dropped"]) });
    const uri = diagramTextUri("D1/+=", "plantuml");

    const { contents } = await mcp.client.readResource({ uri });

    expect(uri).toBe("staruml://diagram/D1%2F%2B%3D.puml");
    expect(contents).toEqual([
      {
        uri,
        mimeType: "text/plain",
        text: PLANTUML,
        _meta: { kind: "class", warnings: ["Notes dropped"] },
      },
    ]);
  });

  it("is not enumerated by resources/list", async () => {
    builtin.reply("/get_all_diagrams_info", {
      body: { success: true, data: [{ id: "D1", name: "Probe", type: "UMLClassDiagram" }] },
    });

    const { resources } = await mcp.client.listResources();

    expect(resources.map((r) => r.uri)).not.toContain("staruml://diagram/D1.mmd");
    expect(resources.map((r) => r.uri)).toContain("staruml://diagram/D1.png");
  });

  it("fails a read with the error detail a tool returns", async () => {
    extension.reply("/export_text", {
      status: 404,
      body: { success: false, code: "NOT_FOUND", error: "Diagram not found: D9" },
    });

    const read = mcp.client.readResource({ uri: diagramTextUri("D9", "plantuml") });

    await expect(read).rejects.toBeInstanceOf(McpError);
    await expect(read).rejects.toMatchObject({
      message: expect.stringContaining(
        "Failed to read diagram plantuml: Diagram not found: D9 [NOT_FOUND, /export_text, HTTP 404]",
      ),
      data: { error: { code: "NOT_FOUND", status: 404 } },
    });
  });
});
