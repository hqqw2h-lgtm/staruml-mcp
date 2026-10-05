import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bundledCatalog, CatalogState } from "../src/extension-tools.js";
import { route } from "../src/generate-diagram.js";
import { closedPort, UpstreamFixture } from "./support/fixture.js";
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

const TITLED = "---\ntitle: Login flow\n---\nsequenceDiagram\n  A->>B: hi";

/** What extension 0.3.0's /build_diagram answers (src/handlers/build.ts). */
const built = {
  diagram: { _id: "D1", _type: "UMLSequenceDiagram", name: "Login flow" },
  kind: "sequence",
  upserted: false,
  created: 3,
  updated: 0,
  unchanged: 0,
  layout: "placed",
  ids: { A: { model: "L1", view: "V1" }, B: { model: "L2", view: "V2" } },
  edges: [{ key: "A -> B", model: "M1", view: "V3" }],
};

describe("route", () => {
  it.each([
    ["plain Mermaid", { code: "classDiagram\n  class A" }, [], true, true],
    ["a -v2 header", { code: "stateDiagram-v2\n  [*] --> S" }, [], true, true],
    ["front matter with a title", { code: TITLED }, ["title", "front matter"], false, true],
    [
      "front matter without a title",
      { code: "---\nconfig: {}\n---\nclassDiagram\n  class A" },
      ["front matter"],
      false,
      true,
    ],
    [
      "unclosed front matter",
      { code: "---\ntitle: X\nclassDiagram" },
      ["title", "front matter"],
      false,
      false,
    ],
    [
      "a title line",
      { code: "sequenceDiagram\n  title Login\n  A->>B: hi" },
      ["title"],
      true,
      true,
    ],
    [
      "a title line before the header",
      { code: "title Login\nclassDiagram" },
      ["title", '"title" first'],
      false,
      true,
    ],
    [
      "<br/> in a name",
      { code: "sequenceDiagram\n  participant A as Web<br/>App" },
      ["line breaks"],
      true,
      true,
    ],
    ["<BR> in a name", { code: "flowchart TD\n  A[a<BR>b]" }, ["line breaks"], true, true],
    ["a literal \\n", { code: "classDiagram\n  class `A\\nB`" }, ["line breaks"], true, true],
    ["graph", { code: "graph TD\n  A --> B" }, ['"graph" first'], false, true],
    ["a leading comment", { code: "%% c\nclassDiagram" }, ['"%%" first'], false, true],
    ["a mind map", { code: "mindmap\n  root" }, [], true, false],
    ["an unknown type", { code: "gantt\n  x" }, ['"gantt" first'], false, false],
    [
      "a name and a kind",
      { code: "flowchart TD\n  A --> B", name: "Order", kind: "activity" },
      ["name", "kind activity"],
      true,
      true,
    ],
  ])("reads %s", (_, request, needs, builtinReads, extensionReads) => {
    expect(route(request)).toEqual({ needs, builtinReads, extensionReads });
  });
});

describe("generate_diagram", () => {
  it("lists name and kind next to code", async () => {
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((t) => t.name === "generate_diagram")!;

    expect(Object.keys(tool.inputSchema.properties!)).toEqual(["code", "name", "kind"]);
    expect(tool.inputSchema.required).toEqual(["code"]);
  });

  it("keeps plain Mermaid on the built-in API", async () => {
    builtin.reply("/generate_diagram", { body: { success: true } });

    const result = await mcp.call("generate_diagram", { code: "classDiagram\n  class A" });

    expect(text(result)).toBe("ok");
    expect(builtin.requests).toEqual([
      { method: "POST", path: "/generate_diagram", body: { code: "classDiagram\n  class A" } },
    ]);
    expect(extension.requests).toEqual([]);
  });

  it("sends a titled diagram to build_diagram and answers its ids", async () => {
    extension.reply("/build_diagram", { body: { success: true, data: built } });

    const result = await mcp.call("generate_diagram", { code: TITLED });

    expect(result.isError).toBeFalsy();
    expect(extension.requests).toEqual([
      { method: "POST", path: "/build_diagram", body: { mermaid: TITLED } },
    ]);
    expect(JSON.parse(text(result))).toEqual(built);
    expect(builtin.requests).toEqual([]);
  });

  it("passes name and kind to build_diagram and drops their echoes", async () => {
    extension.reply("/build_diagram", {
      body: { success: true, data: { ...built, kind: "activity" } },
    });
    const code = "flowchart TD\n  A --> B";

    const result = await mcp.call("generate_diagram", { code, name: "Order", kind: "activity" });

    expect(extension.requests[0]!.body).toEqual({ mermaid: code, name: "Order", kind: "activity" });
    expect(text(result)).not.toContain('"kind"');
  });

  it("passes the extension's refusal through", async () => {
    extension.reply("/build_diagram", {
      status: 400,
      body: { success: false, code: "INVALID_ARGUMENT", error: "line 2: unknown arrow" },
    });

    const result = await mcp.call("generate_diagram", { code: "graph TD\n  A ~~> B" });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: "INVALID_ARGUMENT",
        message: "line 2: unknown arrow",
        endpoint: "/build_diagram",
      },
    });
    expect(builtin.requests).toEqual([]);
  });

  it("refuses a name for a type build_diagram does not read, before any request", async () => {
    const result = await mcp.call("generate_diagram", { code: "mindmap\n  root", name: "Ideas" });

    expect(result.structuredContent).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message:
          "name and kind need a diagram type build_diagram reads: classDiagram, sequenceDiagram, flowchart/graph, erDiagram, stateDiagram",
        hint: "build_diagram({kind, spec, name}) builds the other kinds, mind maps included, from a spec.",
      },
    });
    expect(builtin.requests).toEqual([]);
    expect(extension.requests).toEqual([]);
  });

  it("rejects a kind it cannot build through the input schema", async () => {
    const result = await mcp.call("generate_diagram", { code: "flowchart TD", kind: "gantt" });

    expect(text(result)).toMatch(/Input validation error/);
  });

  describe("when the extension does not answer", () => {
    let offline: ConnectedClient;

    beforeAll(async () => {
      offline = await connect({
        apiHost: HOST,
        apiPort: builtin.port,
        extPort: await closedPort(),
      });
    });

    afterAll(async () => {
      await offline.close();
    });

    it("renders on the built-in API and says what was left out", async () => {
      builtin.reply("/generate_diagram", { body: { success: true } });
      const code = "sequenceDiagram\n  title Login\n  participant A as Web<br/>App";

      const result = await offline.call("generate_diagram", { code });

      expect(text(result)).toBe(
        "ok; built-in API without title, line breaks: staruml-mcp-extension did not answer",
      );
      expect(builtin.requests.map((r) => r.path)).toEqual(["/", "/generate_diagram"]);
    });

    it.each([
      ["a name", { code: "classDiagram\n  class A", name: "Shop" }],
      ["a source the built-in cannot read", { code: TITLED }],
    ])("reports EXTENSION_UNREACHABLE for %s", async (_, args) => {
      const result = await offline.call("generate_diagram", args);

      expect(result.structuredContent).toMatchObject({
        error: { code: "EXTENSION_UNREACHABLE", endpoint: "/build_diagram" },
      });
      expect(builtin.requests.map((r) => r.path)).toEqual(["/"]);
    });
  });

  describe("when the extension is incompatible", () => {
    let disabled: ConnectedClient;

    beforeAll(async () => {
      disabled = await connect({
        apiHost: HOST,
        apiPort: builtin.port,
        extPort: extension.port,
        catalog: new CatalogState({ ...bundledCatalog(), enabled: false }),
      });
    });

    afterAll(async () => {
      await disabled.close();
    });

    it("renders a title on the built-in API and says what was left out", async () => {
      builtin.reply("/generate_diagram", { body: { success: true } });

      const result = await disabled.call("generate_diagram", {
        code: "sequenceDiagram\n  title Login\n  A->>B: hi",
      });

      expect(text(result)).toBe(
        "ok; built-in API without title: staruml-mcp-extension is not available",
      );
      expect(extension.requests).toEqual([]);
    });

    it("refuses a kind with EXTENSION_REQUIRED", async () => {
      const result = await disabled.call("generate_diagram", {
        code: "flowchart TD\n  A --> B",
        kind: "usecase",
      });

      expect(result.structuredContent).toEqual({
        error: {
          code: "EXTENSION_REQUIRED",
          message: "kind usecase need staruml-mcp-extension 0.3's build_diagram",
          hint: "Install it from https://github.com/hqqw2h-lgtm/staruml-mcp-extension (Tools > Extension Manager > Install From Url), restart StarUML and run doctor.",
        },
      });
      expect(builtin.requests).toEqual([]);
    });
  });
});
