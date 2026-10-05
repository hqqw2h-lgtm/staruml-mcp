import { GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledCatalog, CatalogState } from "../src/extension-tools.js";
import { invocation, MODEL_CODEBASE, REVIEW_DIAGRAM } from "../src/prompts.js";
import { parseToolSelection } from "../src/tiers.js";
import { connect, type ConnectedClient } from "./support/mcp.js";

let mcp: ConnectedClient;

beforeAll(async () => {
  mcp = await connect({});
});

afterAll(async () => {
  await mcp.close();
});

async function promptText(
  name: string,
  args: Record<string, string> = {},
  client: ConnectedClient = mcp,
): Promise<string> {
  const { messages } = await client.client.getPrompt({ name, arguments: args });
  expect(messages).toHaveLength(1);
  expect(messages[0]!.role).toBe("user");
  return (messages[0]!.content as { type: "text"; text: string }).text;
}

describe("prompts/list", () => {
  it("offers model-codebase and review-diagram with optional arguments", async () => {
    const { prompts } = await mcp.client.listPrompts();

    expect(prompts).toEqual([
      {
        name: MODEL_CODEBASE,
        title: "Model a codebase",
        description:
          "Reverse-engineer a source directory or build class diagrams from a described codebase.",
        arguments: [
          {
            name: "path",
            description: "Absolute source directory to reverse-engineer.",
            required: false,
          },
          {
            name: "language",
            description: "java, cpp, csharp or python, for reverse_code.",
            required: false,
          },
          {
            name: "description",
            description: "What the codebase does, or what to focus on.",
            required: false,
          },
          {
            name: "name",
            description: "Name of the class diagram; default Overview.",
            required: false,
          },
        ],
      },
      {
        name: REVIEW_DIAGRAM,
        title: "Review a diagram",
        description: "Describe, validate and read a diagram as text, then review it.",
        arguments: [
          {
            name: "diagram",
            description: "Diagram id or path; default the current diagram.",
            required: false,
          },
        ],
      },
    ]);
  });
});

describe("model-codebase", () => {
  it("reverse-engineers a source directory, then checks the result", async () => {
    const text = await promptText(MODEL_CODEBASE, {
      path: "/work/shop/src",
      language: "java",
      name: "Shop",
    });

    expect(text).toBe(
      [
        "Model the source code in /work/shop/src as UML in StarUML.",
        "",
        "1. Run doctor. If the extension check fails, stop and report its fix line.",
        '2. call_endpoint({name: "list_code_generators", body: {}}). If a generator for java is installed, call_endpoint({name: "reverse_code", body: {language: "java", path: "/work/shop/src"}}) reads the source into the model and adds overview diagrams; get_all_diagrams_info lists them. If none is installed, read the source yourself and continue with step 3.',
        '3. Unless reverse engineering drew what is needed, make one build_diagram({kind: "class", name: "Shop", spec: {classes, relations}}) with the central classes (about 5 to 15), their key attributes and operations, and their relations (generalization, realization, composition, aggregation, association, dependency). Split a larger system into one diagram per package, and extend a diagram with upsert: true.',
        '4. Check the result: describe_diagram({diagram: "Shop"}) and validate_model({scope: <the diagram\'s _parent>}); fix what they show with build_diagram upsert or update_element, then summarise the model in a few sentences.',
      ].join("\n"),
    );
  });

  it("builds from a description when there is no source directory", async () => {
    const text = await promptText(MODEL_CODEBASE, { description: "An order service." });

    expect(text.split("\n").slice(0, 4)).toEqual([
      "Model the codebase described below as UML in StarUML.",
      "About it: An order service.",
      "",
      "1. Run doctor. If the extension check fails, stop and report its fix line.",
    ]);
    expect(text).toContain(
      '2. Unless reverse engineering drew what is needed, make one build_diagram({kind: "class", name: "Overview"',
    );
    expect(text).toContain("\n3. Check the result: ");
    expect(text).not.toContain("reverse_code");
  });

  it("names a placeholder language when none is given", async () => {
    expect(await promptText(MODEL_CODEBASE, { path: "/src" })).toContain(
      'If a generator for <language> is installed, call_endpoint({name: "reverse_code", body: {language: "<language>", path: "/src"}})',
    );
  });
});

describe("review-diagram", () => {
  it("reviews a named diagram with the core tier's tools", async () => {
    expect(await promptText(REVIEW_DIAGRAM, { diagram: "Model/Shop/Main" })).toBe(
      [
        "Review diagram Model/Shop/Main.",
        "",
        '1. describe_diagram({diagram: "Model/Shop/Main"}) for its nodes, members and edges.',
        "2. validate_model({scope: <the diagram's _parent>}) for StarUML's rule violations; get_element_by_id gives the _parent.",
        '3. diagram_as_text({diagram: "Model/Shop/Main"}) when the exact notation matters.',
        "",
        "Report modelling problems (each validation finding with its element, missing types or multiplicities, misused relationship kinds, naming), what a reader would find unclear, and a concrete fix for each as a build_diagram upsert or update_element call. Change nothing until asked.",
      ].join("\n"),
    );
  });

  it("reviews the current diagram through call_endpoint on a tier without the reads", async () => {
    const narrow = await connect({
      catalog: new CatalogState(bundledCatalog(), parseToolSelection("find_elements")),
    });
    try {
      const text = await promptText(REVIEW_DIAGRAM, {}, narrow);

      expect(text).toContain("Review the diagram open in StarUML.");
      expect(text).toContain(
        '1. call_endpoint({name: "describe_diagram", body: {diagram: "@current"}})',
      );
      expect(text).toContain('3. diagram_as_text({diagram: "@current"})');
    } finally {
      await narrow.close();
    }
  });
});

describe("invocation", () => {
  it("names a listed endpoint's tool, otherwise call_endpoint", () => {
    const state = new CatalogState();

    expect(invocation(state, "search_types", '{query: "x"}')).toBe('search_types({query: "x"})');
    expect(invocation(state, "save_project", "{}")).toBe(
      'call_endpoint({name: "save_project", body: {}})',
    );
  });
});

describe("prompts/get", () => {
  it("reads absent arguments as none", async () => {
    const result = await mcp.client.request(
      { method: "prompts/get", params: { name: REVIEW_DIAGRAM } },
      GetPromptResultSchema,
    );

    expect((result.messages[0]!.content as { text: string }).text).toMatch(
      /^Review the diagram open in StarUML/,
    );
  });

  it("refuses an unknown prompt", async () => {
    await expect(mcp.client.getPrompt({ name: "draw-everything" })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("Prompt draw-everything not found"),
    });
  });
});
