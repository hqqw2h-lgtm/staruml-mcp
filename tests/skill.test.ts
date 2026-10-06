import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST } from "../src/manifest.js";
import { parseToolSelection } from "../src/tiers.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text } from "./support/mcp.js";
import { frontMatter, readSkill, skillExamples } from "./support/skill.js";
import packageJson from "../package.json" with { type: "json" };

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();

const examples = skillExamples();
const KINDS = [
  "class",
  "sequence",
  "usecase",
  "activity",
  "statemachine",
  "erd",
  "flowchart",
  "mindmap",
];

/** Answers shaped like extension 0.3.0's, enough for every tool to finish without an error. */
function serve(): void {
  const summary = { _id: "E1", _type: "UMLClass", name: "Invoice", _parent: "M1" };
  for (const { path } of BUNDLED_MANIFEST.endpoints) {
    extension.reply(path, { body: { success: true, data: summary } });
  }
  extension.reply("/batch", { body: { success: true, data: { succeeded: 8, results: [] } } });
  extension.reply("/export_diagram", {
    body: {
      success: true,
      data: {
        diagram: "D1",
        format: "png",
        mimeType: "image/png",
        width: 10,
        height: 10,
        bytes: 8,
        base64: "iVBORw0KGgo=",
      },
    },
  });
  extension.reply("/export_text", {
    body: {
      success: true,
      data: { diagram: { _id: "D1" }, kind: "class", text: "classDiagram\n  class Invoice\n" },
    },
  });
  builtin.reply("/generate_diagram", { body: { success: true } });
  builtin.reply("/get_current_diagram_info", {
    body: { success: true, data: { id: "D1", type: "UMLClassDiagram", name: "Ordering" } },
  });
  builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: "iVBORw0KGgo=" } });
}

/** The request a tool call must reach for its arguments to count as accepted. */
function expectedRequest(tool: string, args: Record<string, unknown>) {
  switch (tool) {
    case "call_endpoint":
      return { fixture: extension, path: `/${String(args.name)}`, body: args.body ?? {} };
    case "generate_diagram":
      return { fixture: builtin, path: "/generate_diagram", body: args };
    case "view_diagram":
      // A labelled picture comes from the extension; the built-in PNG has no labels.
      return args.annotate === undefined
        ? { fixture: builtin, path: "/get_diagram_image_by_id", body: { diagramId: "D1" } }
        : { fixture: extension, path: "/export_diagram", body: { ...args, format: "png" } };
    case "diagram_as_text":
      return {
        fixture: extension,
        path: "/export_text",
        body: { diagram: args.diagram ?? "D1", format: args.format ?? "mermaid" },
      };
    default:
      return { fixture: extension, path: `/${tool}`, body: args };
  }
}

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
});

afterEach(() => {
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await Promise.all([builtin.stop(), extension.stop()]);
});

describe("SKILL.md", () => {
  it("has the front matter the Agent Skills format requires", () => {
    const { name, description } = frontMatter();

    expect(name).toBe("staruml");
    expect(description).toMatch(/^Use when /);
    expect(description!.length).toBeLessThanOrEqual(1024);
  });

  it("has a build_diagram spec example for every kind and covers the core workflow", () => {
    const specKinds = examples
      .filter((e) => e.tool === "build_diagram" && e.args.spec !== undefined && !e.args.dryRun)
      .map((e) => e.args.kind);
    expect(specKinds).toEqual(KINDS);
    // The build loop: a dry run, a lint and uml_lint (#13).
    expect(examples.some((e) => e.tool === "build_diagram" && e.args.dryRun === true)).toBe(true);
    expect(examples.some((e) => e.tool === "call_endpoint" && e.args.name === "uml_lint")).toBe(
      true,
    );
    expect(examples.some((e) => e.tool === "build_diagram" && "mermaid" in e.args)).toBe(true);
    expect(new Set(examples.map((e) => e.tool))).toEqual(
      new Set([
        "doctor",
        "build_diagram",
        "generate_diagram",
        "batch",
        "describe_endpoints",
        "call_endpoint",
        "find_elements",
        "view_diagram",
        "export_diagram",
        "diagram_as_text",
        "improve_diagram",
        "diagram_quality",
        "build_model",
        "apply_pattern",
        "derive_diagrams",
        "model_lint",
        "explain_model",
      ]),
    );
    // Section 7's example runs in the oo tier, every other one in the default tier.
    expect(new Set(examples.filter((e) => e.tools !== "core").map((e) => e.tools))).toEqual(
      new Set(["oo"]),
    );
  });

  it("teaches object-first authoring with one complete example, spec to derived diagrams (#17)", () => {
    const section =
      /^## 7\. Object-first, never draw\n([\s\S]*?)^## /m.exec(readSkill())?.[1] ?? "";
    const oo = examples.filter((e) => e.tools === "oo");

    expect(section).toContain("--tools oo");
    expect(section).toContain("NOT_IN_TIER");
    expect(oo.map((e) => e.tool)).toEqual([
      "build_model",
      "derive_diagrams",
      "model_lint",
      "explain_model",
    ]);
    const spec = oo[0]!.args.spec as Record<string, unknown[]>;
    // Every kind derive_diagrams draws from a model's own sections is in the example.
    for (const section of ["contexts", "classes", "relationships", "useCases"]) {
      expect(spec[section]!.length, section).toBeGreaterThan(0);
    }
    expect(spec.collaborations).toHaveLength(1);
    expect(spec.lifecycles).toHaveLength(1);
    expect(oo[1]!.args).toEqual({ scope: (spec as unknown as { system: string }).system });
  });

  it("teaches model first and patterns with tested examples by path (#13)", () => {
    const source = readSkill();
    const section = (title: string) =>
      new RegExp(`^## \\d+\\. ${title}\\n([\\s\\S]*?)^## `, "m").exec(source)?.[1] ?? "";
    const model = section("Model first");
    const patterns = section("Design patterns with correct properties");

    for (const verb of ["owns", "has", "uses", "isA", "implements", "knows"]) {
      expect(model, verb).toContain(`| \`${verb}\` |`);
    }
    expect(model).toContain("becomes the class's documentation");
    expect(model).toContain("```json build_model");
    expect(patterns).toContain("```json apply_pattern");
    expect(patterns).toContain("detect_patterns");
    // Bindings name existing classes by path.
    const applied = examples.filter((e) => e.tool === "apply_pattern");
    expect(applied.map((e) => (e.args.bindings as { Context: string }).Context)).toEqual([
      "Loans/Loan",
      "Loans/Loan",
    ]);
    expect(applied.map((e) => e.args.dryRun === true)).toEqual([true, false]);
  });

  it("teaches the build loop and what a readable UML diagram needs (#13)", () => {
    const section = /^## 4\. The build loop and drawing good UML\n([\s\S]*?)^## /m.exec(
      readSkill(),
    )?.[1];

    expect(section).toBeDefined();
    const loop = [
      "**Plan**",
      "dryRun",
      "**Build**",
      "**Score**",
      "improve_diagram",
      "**Look**",
    ].map((step) => section!.indexOf(step));
    expect(loop.every((at, i) => at >= 0 && (i === 0 || at > loop[i - 1]!))).toBe(true);
    for (const topic of [
      "One concern per diagram",
      "Split when",
      "**Names**",
      "multiplicity on both ends",
      "`directed` when",
      "**Direction and layering**",
      "**Grouping**",
      "`package`",
      "snapshot",
    ]) {
      expect(section, topic).toContain(topic);
    }
  });

  it("teaches consistent, good-looking diagrams: profile once, engine layout, quality, split (#16)", () => {
    const section =
      /^## 5\. Consistent, good-looking diagrams\n([\s\S]*?)^## /m.exec(readSkill())?.[1] ?? "";

    for (const topic of [
      "**Set the profile once**",
      "**Let the engine lay out.**",
      "STYLE_LOCKED",
      "**Read `quality` and iterate.**",
      "`improve_diagram`",
      "**Split big diagrams.**",
      "maxElements",
      "SAVE_BLOCKED",
    ]) {
      expect(section, topic).toContain(topic);
    }
    const named = (name: string) =>
      examples.some((e) => e.tool === "call_endpoint" && e.args.name === name);
    expect(named("set_style_profile")).toBe(true);
    expect(named("apply_style_profile")).toBe(true);
    expect(named("explain_style_violation")).toBe(true);
    expect(section).toContain("```json diagram_quality");
  });

  it("is copied unchanged, apart from a source note, to the Codex and Copilot plugins", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/sync-skills.mjs", "--check"], { stdio: "pipe" }),
    ).not.toThrow();
    const copy = readFileSync("plugins/copilot/skills/staruml/SKILL.md", "utf8");
    expect(copy.replace(/^<!-- Generated from .* -->\n/m, "")).toBe(readSkill());
  });

  it("ships plugin manifests at the package version that start the published server", () => {
    const read = (path: string) =>
      JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const marketplace = read(".claude-plugin/marketplace.json") as {
      plugins: { name: string; source: string; version: string }[];
    };

    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "staruml", source: "./plugins/claude-code" }),
    ]);
    for (const path of [
      "plugins/claude-code/.claude-plugin/plugin.json",
      "plugins/codex/staruml/.codex-plugin/plugin.json",
      "plugins/copilot/plugin.json",
    ]) {
      expect(read(path), path).toMatchObject({ name: "staruml", version: packageJson.version });
    }
    expect(marketplace.plugins[0]!.version).toBe(packageJson.version);
    expect(read("plugins/claude-code/.mcp.json")).toEqual({
      mcpServers: {
        staruml: {
          command: "npx",
          args: ["-y", packageJson.name],
          env: { STARUML_EXT_TOKEN: "${STARUML_EXT_TOKEN:-}" },
        },
      },
    });
  });
});

describe.each(examples)("SKILL.md line $line: $tool ($tools)", ({ tool, args, tools }) => {
  it("is accepted by the server under its tier and reaches StarUML as written", async () => {
    serve();
    // A server of its own: doctor reloads the catalog from the stand-ins, which are no extension.
    const mcp = await connect({
      apiHost: HOST,
      apiPort: builtin.port,
      extPort: extension.port,
      catalog: new CatalogState(undefined, parseToolSelection(tools)),
    });

    const result = await mcp.call(tool, args);
    await mcp.close();

    expect(result.isError, text(result)).toBeFalsy();
    if (tool === "doctor") {
      expect(text(result)).toMatch(/^node +ok/);
    } else if (tool === "describe_endpoints") {
      expect(Object.keys(JSON.parse(text(result)) as object)).toEqual(args.names);
    } else {
      const { fixture, path, body } = expectedRequest(tool, args);
      expect(fixture.requests).toContainEqual({ method: "POST", path, body });
    }
  });
});
