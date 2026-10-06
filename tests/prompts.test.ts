import { GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledCatalog, CatalogState } from "../src/extension-tools.js";
import {
  APPLY_PATTERN_PROMPT,
  IMPROVE_DIAGRAM,
  invocation,
  MODEL_CODEBASE,
  MODEL_FIRST,
  REVIEW_DIAGRAM,
} from "../src/prompts.js";
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
  it("offers model-codebase, review-diagram, improve-diagram, apply-pattern and model-first with optional arguments", async () => {
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
      {
        name: IMPROVE_DIAGRAM,
        title: "Improve a diagram",
        description: "Score a diagram, let the quality loop re-lay it out, then look at it.",
        arguments: [
          {
            name: "diagram",
            description: "Diagram id or path; default the current diagram.",
            required: false,
          },
        ],
      },
      {
        name: APPLY_PATTERN_PROMPT,
        title: "Apply a design pattern",
        description:
          "Bind a pattern's roles to existing classes by path, dry-run, apply, look and detect it back.",
        arguments: [
          {
            name: "pattern",
            description: "Pattern name, e.g. Strategy; default chosen from the list.",
            required: false,
          },
          {
            name: "scope",
            description: "Package or model holding the classes, by path.",
            required: false,
          },
          {
            name: "diagram",
            description: "Class diagram to show it on; default '<pattern> pattern'.",
            required: false,
          },
        ],
      },
      {
        name: MODEL_FIRST,
        title: "Model a domain object-first",
        description:
          "State a domain as objects, dry-run and build the model, derive every diagram, review.",
        arguments: [
          {
            name: "system",
            description: "Name of the system, which names the model.",
            required: false,
          },
          { name: "description", description: "What the domain is and does.", required: false },
        ],
      },
    ]);
  });

  it("hides a prompt whose endpoints the tier cannot reach, and lists it again after", async () => {
    const catalog = new CatalogState(bundledCatalog(), parseToolSelection("oo"));
    const oo = await connect({ catalog });
    try {
      const listed = async () => (await oo.client.listPrompts()).prompts.map((p) => p.name);
      // model-codebase draws with build_diagram, which the oo tier does not reach.
      expect(await listed()).toEqual([
        REVIEW_DIAGRAM,
        IMPROVE_DIAGRAM,
        APPLY_PATTERN_PROMPT,
        MODEL_FIRST,
      ]);
      await expect(oo.client.getPrompt({ name: MODEL_CODEBASE })).rejects.toThrow(
        /Prompt model-codebase not found/,
      );

      catalog.update(catalog.current, parseToolSelection("core"));
      expect(await listed()).toContain(MODEL_CODEBASE);
      catalog.update(catalog.current, parseToolSelection("oo"));
      expect(await listed()).not.toContain(MODEL_CODEBASE);
    } finally {
      await oo.close();
    }
  });
});

describe("model-first", () => {
  it("states the domain, dry-runs and builds the model, derives, looks and reviews (core tier)", async () => {
    expect(
      await promptText(MODEL_FIRST, { system: "Lending", description: "A library's loans." }),
    ).toBe(
      [
        "Model Lending object-first: state it as objects and let StarUML derive and lay out every diagram. Do not place, size or colour views.",
        "About it: A library's loans.",
        "",
        '1. Explain the domain back in a few sentences: its bounded contexts, the main classes with one responsibility each, how they relate (owns, has, uses, isA, implements, knows), the actors and their use cases, the collaborations worth a sequence diagram and the lifecycles worth a state machine. Write that as a build_model spec with system "Lending".',
        "2. build_model({spec, dryRun: true}): check every path it would create and that each relationship verb points the right way (from is the whole, the client, the specific kind or the side that navigates).",
        "3. build_model({spec}) builds the model in one undo step. classViews and useCaseViews in the spec group the class and use case diagrams as the user wants them.",
        '4. call_endpoint({name: "derive_diagrams", body: {scope: "Lending"}}) draws every diagram the model implies, each laid out by the style profile and run through the quality loop; quality.failing names any below its target.',
        '5. view_diagram({diagram: "<a derived diagram\'s name>"}) for the diagrams that matter most, diagram_as_text for their content, call_endpoint({name: "explain_model", body: {scope: "Lending"}}) for the whole model as text.',
        '6. call_endpoint({name: "model_lint", body: {scope: "Lending"}}) reviews the object design. Fix what it reports in the spec, then build_model({spec, upsert: true}) and call_endpoint({name: "derive_diagrams", body: {scope: "Lending"}}) again: both update in place. Repeat until it reports no error or warning, at most three rounds.',
        "",
        "Report the model in a few sentences, the diagrams derived with their scores, and what model_lint still reports.",
      ].join("\n"),
    );
  });

  it("names the oo tier's own tools under --tools oo, and a placeholder system", async () => {
    const oo = await connect({
      catalog: new CatalogState(bundledCatalog(), parseToolSelection("oo")),
    });
    try {
      const text = await promptText(MODEL_FIRST, {}, oo);

      expect(text).toMatch(/^Model the system described below object-first/);
      expect(text).not.toContain("About it:");
      expect(text).toContain('4. derive_diagrams({scope: "<system>"})');
      expect(text).toContain('explain_model({scope: "<system>"})');
      expect(text).toContain('6. model_lint({scope: "<system>"})');
      expect(text).not.toContain("call_endpoint");
    } finally {
      await oo.close();
    }
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
        '4. Check the result: call_endpoint({name: "describe_diagram", body: {diagram: "Shop"}}) and call_endpoint({name: "validate_model", body: {scope: <the diagram\'s _parent>}}); fix what they show with build_diagram upsert or update_element, then summarise the model in a few sentences.',
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
  it("reviews a named diagram, through call_endpoint for the reads the core tier left out", async () => {
    expect(await promptText(REVIEW_DIAGRAM, { diagram: "Model/Shop/Main" })).toBe(
      [
        "Review diagram Model/Shop/Main.",
        "",
        '1. call_endpoint({name: "describe_diagram", body: {diagram: "Model/Shop/Main"}}) for its nodes, members and edges.',
        "2. call_endpoint({name: \"validate_model\", body: {scope: <the diagram's _parent>}}) for StarUML's rule violations; get_element_by_id gives the _parent.",
        '3. diagram_as_text({diagram: "Model/Shop/Main"}) when the exact notation matters; format: "spec" for the kinds neither Mermaid nor PlantUML has (composite, timing, SysML, BPMN, DFD, wireframe, cloud and the other build_diagram families).',
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

describe("improve-diagram", () => {
  it("looks, scores, runs the quality loop and looks again, with core tools where listed", async () => {
    expect(await promptText(IMPROVE_DIAGRAM, { diagram: "Shop/Main" })).toBe(
      [
        "Improve diagram Shop/Main until its layout scores its target and its model is sound.",
        "",
        '1. view_diagram({diagram: "Shop/Main"}) to see it.',
        '2. diagram_quality({ref: "Shop/Main"}): the score against the target (80 in every built-in profile), the penalties that cost points and the lint findings by rule.',
        '3. improve_diagram({ref: "Shop/Main"}) lays it out by the style profile and applies the lint autofixes in one undo step, keeping each step only when it raises the score; its quality says the score reached. Do not move or resize views by hand.',
        '4. view_diagram({diagram: "Shop/Main"}) to look at the result.',
        "5. Below target still: a diagram with more elements than the profile's maxElements (30) reads better split by package or concern into several diagrams; " +
          'improve_diagram({ref: "Shop/Main", preset: "hierarchy-right"}) tries another preset. ' +
          'call_endpoint({name: "uml_lint", body: {scope: <the diagram\'s _parent>}}) finds modelling problems the score does not measure; get_element_by_id gives the _parent. undo reverts an improve_diagram in one step.',
        "",
        "Report the score before and after and what still needs a decision from a person.",
      ].join("\n"),
    );
  });

  it("improves the current diagram, through call_endpoint where the tier lists no tool", async () => {
    const narrow = await connect({
      catalog: new CatalogState(bundledCatalog(), parseToolSelection("find_elements")),
    });
    try {
      const text = await promptText(IMPROVE_DIAGRAM, {}, narrow);

      expect(text).toMatch(/^Improve the diagram open in StarUML until/);
      expect(text).toContain('call_endpoint({name: "diagram_quality", body: {ref: "@current"}})');
      expect(text).toContain('call_endpoint({name: "improve_diagram", body: {ref: "@current"}})');
      expect(text).toContain('view_diagram({diagram: "@current"})');
    } finally {
      await narrow.close();
    }
  });
});

describe("apply-pattern", () => {
  it("reads the pattern, binds by path, dry-runs, applies, looks and detects it back", async () => {
    expect(await promptText(APPLY_PATTERN_PROMPT, { pattern: "Strategy", scope: "Shipping" })).toBe(
      [
        "Apply the Strategy pattern to the existing model in Shipping.",
        "",
        '1. call_endpoint({name: "describe_pattern", body: {name: "Strategy"}}): its roles (`*` binds several elements, `?` is optional), what each gets and the relationship ends it sets.',
        '2. Bind each role to existing classes in Shipping by path; staruml://project/tree and find_elements list them. Write bindings as {Role: "Pkg/Class", ManyRole: ["Pkg/A", "Pkg/B"]}; give a role no class plays a name in the domain\'s words, or leave it unbound for a new element named after the role.',
        '3. call_endpoint({name: "apply_pattern", body: {pattern: "Strategy", bindings, parent: "Shipping", diagram: "Strategy pattern", dryRun: true}}): check every role\'s paths, the elements it would create and each property it would set.',
        '4. call_endpoint({name: "apply_pattern", body: {pattern: "Strategy", bindings, parent: "Shipping", diagram: "Strategy pattern"}}) applies it in one undo step.',
        '5. view_diagram({diagram: "Strategy pattern", annotate: "paths"}) to look at it, and call_endpoint({name: "detect_patterns", body: {patterns: ["Strategy"], scope: "Shipping"}}) to confirm it: confidence 1 and nothing missing.',
        "",
        "Report the bindings, what was created and anything detect_patterns still lists as missing.",
      ].join("\n"),
    );
  });

  it("starts from the pattern list without a pattern, and names the tools under --tools all", async () => {
    const all = await connect({
      catalog: new CatalogState(bundledCatalog(), parseToolSelection("all")),
    });
    try {
      const text = await promptText(APPLY_PATTERN_PROMPT, { diagram: "Billing" }, all);

      expect(text).toMatch(/^Apply the design pattern to the existing model\.\n/);
      expect(text).toContain("0. Read staruml://patterns, or list_patterns({}), and pick");
      expect(text).toContain('1. describe_pattern({name: "<pattern>"})');
      expect(text).toContain("2. Bind each role to existing classes by path;");
      expect(text).toContain('view_diagram({diagram: "Billing", annotate: "paths"})');
      expect(text).toContain('detect_patterns({patterns: ["<pattern>"]}) to confirm it');
      expect(text).toContain('3. apply_pattern({pattern: "<pattern>", bindings, diagram:');
    } finally {
      await all.close();
    }
  });

  it("names a default diagram after the pattern", async () => {
    expect(await promptText(APPLY_PATTERN_PROMPT)).toContain('diagram: "Design pattern"');
  });
});

describe("invocation", () => {
  it("names a listed endpoint's tool, otherwise call_endpoint", () => {
    const state = new CatalogState();

    expect(invocation(state, "build_model", "{spec}")).toBe("build_model({spec})");
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
