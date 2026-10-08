/**
 * Viewpoints and templates (extension #42, #43), and draw.io files (#41), through the in-memory
 * transport: request_diagram and the catalogue reads listed with short schemas, their answers
 * shaped for the model, and a draw.io export only ever written to a file.
 */
import fc from "fast-check";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST, strictRequestSchema, type ManifestEntry } from "../src/manifest.js";
import { deriveResult } from "../src/model.js";
import { parseToolSelection } from "../src/tiers.js";
import {
  DESCRIBE_TEMPLATE_DESCRIPTION,
  DESCRIBE_VIEWPOINT_DESCRIPTION,
  LIST_TEMPLATES_DESCRIPTION,
  LIST_VIEWPOINTS_DESCRIPTION,
  REQUEST_DIAGRAM_DESCRIPTION,
  templatesResult,
  VIEWPOINT_LINT_DESCRIPTION,
} from "../src/viewpoints.js";
import { styleProfile, UpstreamFixture } from "./support/fixture.js";
import { connect, text, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
const NEW = [
  "request_diagram",
  "list_templates",
  "describe_template",
  "list_viewpoints",
  "describe_viewpoint",
  "viewpoint_lint",
];
let mcp: ConnectedClient;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  mcp = await connect({
    apiHost: HOST,
    apiPort: builtin.port,
    extPort: extension.port,
    catalog: new CatalogState(undefined, parseToolSelection(`core,${NEW.join(",")}`)),
  });
});

afterEach(() => {
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await mcp.close();
  await Promise.all([builtin.stop(), extension.stop()]);
});

const entry = (name: string): ManifestEntry =>
  BUNDLED_MANIFEST.endpoints.find((e) => e.path === `/${name}`)!;

const ok = (data: unknown) => ({ body: { success: true, data } });

/** A /request_diagram answer as extension 0.3.0 gives it (src/handlers/viewpoints.ts). */
const REQUESTED = {
  choice: {
    viewpoint: "runtime",
    kind: "sequence",
    template: "runtime-sequence",
    rule: "D06",
    reason: "the intent asks how parts interact over time",
    question: "What happens, step by step and between which parts, when the scenario is triggered?",
    matched: ["message"],
  },
  scope: "ThingsBoard",
  diagrams: [
    {
      kind: "sequence",
      name: "Telemetry ingestion",
      diagram: "D1",
      created: 9,
      updated: 0,
      unchanged: 0,
      quality: { score: 91, rating: 4, passes: true },
      viewpoint: "runtime",
      conforms: true,
      template: "runtime-sequence",
      accepted: false,
    },
  ],
  counts: { diagrams: 1, created: 9, updated: 0, unchanged: 0, deleted: 0 },
  quality: { min: 91, mean: 91, passing: 1, failing: [] },
};

describe("listing", () => {
  it("lists each new endpoint with a one-line description and a short schema", async () => {
    const { tools } = await mcp.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const descriptions: Record<string, string> = {
      request_diagram: REQUEST_DIAGRAM_DESCRIPTION,
      list_templates: LIST_TEMPLATES_DESCRIPTION,
      describe_template: DESCRIBE_TEMPLATE_DESCRIPTION,
      list_viewpoints: LIST_VIEWPOINTS_DESCRIPTION,
      describe_viewpoint: DESCRIBE_VIEWPOINT_DESCRIPTION,
      viewpoint_lint: VIEWPOINT_LINT_DESCRIPTION,
    };
    for (const name of NEW) {
      const tool = byName.get(name)!;
      expect(tool.description, name).toBe(descriptions[name]);
      expect(tool.description!.length, name).toBeLessThanOrEqual(100);
    }
    const request = byName.get("request_diagram")!.inputSchema;
    expect(request).toEqual({
      type: "object",
      properties: {
        intent: { description: "The question it answers, in plain words." },
        audience: { description: "business|analyst|architect|developer|tester|operator|dba." },
        scope: {
          type: "string",
          description: "Model, package, class, collaboration, state machine, actor or use case.",
        },
        dryRun: { description: "Change nothing; answer the choice." },
      },
      required: ["intent", "scope"],
    });
    expect(byName.get("describe_viewpoint")!.inputSchema.properties!.name).toMatchObject({
      enum: expect.arrayContaining(["context", "runtime", "actors-goals", "data"]),
    });
    expect(byName.get("list_templates")!.inputSchema).toEqual({ type: "object", properties: {} });
    expect(Object.keys(byName.get("viewpoint_lint")!.inputSchema.properties!)).toEqual(["scope"]);
    // The audience names in the description are exactly the extension's enum.
    const audiences = (entry("request_diagram").request.properties as { audience: { enum: [] } })
      .audience.enum;
    expect((request.properties as { audience: { description: string } }).audience.description).toBe(
      `${audiences.join("|")}.`,
    );
  });

  it("costs request_diagram and list_templates about 150 tokens together", async () => {
    const { tools } = await mcp.client.listTools();
    const cost = tools
      .filter((t) => t.name === "request_diagram" || t.name === "list_templates")
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      .reduce((sum, t) => sum + countTokens(JSON.stringify(t)), 0);
    expect(cost).toBeLessThanOrEqual(160);
  });
});

describe("request_diagram", () => {
  it("sends the intent and answers the choice with each diagram by viewpoint and template", async () => {
    extension.reply("/request_diagram", ok(REQUESTED));

    const result = await mcp.call("request_diagram", {
      intent: "how does a device publish telemetry",
      audience: "developer",
      scope: "ThingsBoard",
    });

    expect(extension.requests).toEqual([
      {
        method: "POST",
        path: "/request_diagram",
        body: {
          intent: "how does a device publish telemetry",
          audience: "developer",
          scope: "ThingsBoard",
        },
      },
    ]);
    const answer = JSON.parse(text(result)) as Record<string, unknown>;
    expect(answer.choice).toEqual(REQUESTED.choice);
    expect(answer.diagrams).toEqual([
      {
        kind: "sequence",
        name: "Telemetry ingestion",
        diagram: "D1",
        created: 9,
        score: 91,
        viewpoint: "runtime",
        template: "runtime-sequence",
        accepted: false,
      },
    ]);
    expect(answer.viewpoints).toEqual({ conforming: 1, accepted: 0 });
  });

  it("refuses an audience the extension does not know, and an empty intent, before sending", async () => {
    const audience = await mcp.call("request_diagram", {
      intent: "what is stored",
      audience: "manager",
      scope: "M",
    });
    const intent = await mcp.call("request_diagram", { intent: "", scope: "M" });
    const long = await mcp.call("request_diagram", { intent: "x".repeat(501), scope: "M" });

    for (const result of [audience, intent, long]) {
      expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    }
    expect(text(audience)).toContain("audience");
    expect(extension.requests).toEqual([]);
  });

  it("takes ref as scope's alias through call_endpoint", async () => {
    extension.reply("/request_diagram", ok(REQUESTED));

    await mcp.call("call_endpoint", {
      name: "request_diagram",
      body: { intent: "which states", ref: "Model/Alarm" },
    });

    expect(extension.requests[0]!.body).toEqual({ intent: "which states", scope: "Model/Alarm" });
  });

  it("answers VIEWPOINT_MISMATCH with the views that fit in its hint", async () => {
    extension.reply("/request_diagram", {
      status: 422,
      body: {
        success: false,
        code: "VIEWPOINT_MISMATCH",
        error: "request_diagram: the business audience does not read code views",
        details: {
          reason: "audience",
          alternatives: [
            {
              viewpoint: "actors-goals",
              kind: "usecase",
              why: "Who uses the system, and for what?",
              candidates: ["ThingsBoard"],
            },
          ],
        },
      },
    });

    const result = await mcp.call("request_diagram", {
      intent: "class diagram",
      audience: "business",
      scope: "ThingsBoard",
    });

    const error = (result.structuredContent as { error: Record<string, unknown> }).error;
    expect(error).toMatchObject({ code: "VIEWPOINT_MISMATCH", status: 422 });
    expect(error.hint).toBe(
      "Views that fit: actors-goals as usecase in ThingsBoard (Who uses the system, and for what?). Ask request_diagram with an intent for one of them and its scope.",
    );
    expect(error.details).toMatchObject({ alternatives: [{ viewpoint: "actors-goals" }] });
  });
});

describe("catalogue reads", () => {
  it("list_templates answers diagram templates without version and project templates by name", async () => {
    extension.reply(
      "/list_templates",
      ok({
        templates: [
          { name: "Default", source: "core", path: "/Applications/StarUML.app/Default.mdj" },
        ],
        diagramTemplates: [
          {
            name: "code-classes",
            version: 1,
            title: "Class diagram",
            viewpoint: "code",
            kind: "class",
            default: true,
          },
          {
            name: "code-overview",
            version: 2,
            title: "Overview",
            viewpoint: "code",
            kind: "class",
            default: false,
          },
        ],
      }),
    );

    const result = await mcp.call("list_templates");

    expect(JSON.parse(text(result))).toEqual({
      diagramTemplates: [
        { name: "code-classes", title: "Class diagram", viewpoint: "code", kind: "class" },
        {
          name: "code-overview",
          title: "Overview",
          viewpoint: "code",
          kind: "class",
          default: false,
        },
      ],
      templates: ["Default"],
    });
  });

  it("viewpoint_lint answers its findings as the other lints do", async () => {
    extension.reply(
      "/viewpoint_lint",
      ok({
        diagrams: 2,
        count: 1,
        counts: { error: 1, warning: 0, info: 0 },
        truncated: false,
        findings: [
          {
            rule: "V002",
            name: "mixed-viewpoints",
            severity: "error",
            message: "elements of two viewpoints",
            diagram: "D1",
            path: "Model/Main",
            viewpoint: null,
            ids: ["V1", "V2"],
            fix: "split it",
          },
        ],
      }),
    );

    const result = await mcp.call("viewpoint_lint", { scope: "Model" });

    expect(JSON.parse(text(result))).toEqual({
      diagrams: 2,
      count: 1,
      counts: { error: 1, warning: 0, info: 0 },
      findings: [
        {
          rule: "V002",
          name: "mixed-viewpoints",
          severity: "error",
          message: "elements of two viewpoints",
          diagram: "D1",
          path: "Model/Main",
          ids: ["V1", "V2"],
          fix: "split it",
        },
      ],
    });
  });

  it("describe_template takes template as name's alias; describe_viewpoint checks the name", async () => {
    extension.reply("/describe_template", ok({ template: { name: "data-erd" }, question: "?" }));

    await mcp.call("call_endpoint", { name: "describe_template", body: { template: "data-erd" } });
    const bad = await mcp.call("describe_viewpoint", { name: "everything" });

    expect(extension.requests.map((r) => r.body)).toEqual([{ name: "data-erd" }]);
    expect(bad.isError).toBe(true);
  });
});

describe("templatesResult", () => {
  it("passes an answer without template lists, and items that are not objects", () => {
    expect(JSON.parse(text(templatesResult({ other: 1 }, {})))).toEqual({ other: 1 });
    expect(JSON.parse(text(templatesResult(null, {})))).toBeNull();
    expect(
      JSON.parse(text(templatesResult({ templates: [null, "x", { path: "/p" }] }, {}))),
    ).toEqual({ templates: [null, "x", { path: "/p" }] });
    expect(JSON.parse(text(templatesResult({ diagramTemplates: [null, 3] }, {})))).toEqual({
      diagramTemplates: [null, 3],
    });
  });
});

describe("deriveResult with viewpoints", () => {
  it("leaves out the viewpoint counts when no diagram reports conformance", () => {
    const answer = JSON.parse(
      text(deriveResult({ diagrams: [{ kind: "class", name: "A", diagram: "D1" }, null] }, {})),
    ) as Record<string, unknown>;
    expect(answer).toEqual({ diagrams: [{ kind: "class", name: "A", diagram: "D1" }, null] });
  });

  it("writes conforms and accepted only when false, and counts both", () => {
    const answer = JSON.parse(
      text(
        deriveResult(
          {
            diagrams: [
              { kind: "class", name: "A", viewpoint: "code", conforms: true, accepted: true },
              { kind: "erd", name: "B", template: "data-erd", conforms: false, accepted: true },
            ],
          },
          {},
        ),
      ),
    ) as Record<string, unknown>;
    expect(answer).toEqual({
      diagrams: [
        { kind: "class", name: "A", viewpoint: "code" },
        { kind: "erd", name: "B", template: "data-erd", conforms: false },
      ],
      viewpoints: { conforming: 1, accepted: 2 },
    });
  });
});

describe("draw.io files", () => {
  it("export_diagram writes one to path and answers its size, never the XML", async () => {
    extension.reply(
      "/export_diagram",
      ok({
        diagram: "D1",
        format: "drawio",
        mimeType: "application/vnd.jgraph.mxfile",
        width: 800,
        height: 600,
        bytes: 4096,
        path: "/tmp/a.drawio",
      }),
    );

    const result = await mcp.call("export_diagram", { format: "drawio", path: "/tmp/a.drawio" });

    expect(result.content).toHaveLength(1);
    expect(JSON.parse(text(result))).toEqual({
      diagram: "D1",
      mimeType: "application/vnd.jgraph.mxfile",
      width: 800,
      height: 600,
      bytes: 4096,
    });
  });

  it("refuses export_diagram drawio without a path, and export_text drawio, before sending", async () => {
    const inline = await mcp.call("export_diagram", { format: "drawio" });
    const asText = await mcp.call("call_endpoint", {
      name: "export_text",
      body: { diagram: "D1", format: "drawio" },
    });
    const many = await mcp.call("call_endpoint", {
      name: "export_diagram",
      body: { format: "drawio", scale: 2 },
    });

    expect(inline.structuredContent).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message: "format drawio is written to a file, never answered inline",
        endpoint: "/export_diagram",
        hint: "Pass path, an absolute .drawio file; the answer is its path and size.",
      },
    });
    expect(asText.structuredContent).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message: "format drawio is written to a file, never answered inline",
        endpoint: "/export_text",
        hint: 'export_diagram({format: "drawio", path}) writes it to an absolute .drawio file.',
      },
    });
    expect(many.isError).toBe(true);
    expect(extension.requests).toEqual([]);
  });

  it("passes export_text's other formats and export_diagrams' drawio, which writes files", async () => {
    extension.reply("/export_text", ok({ text: "classDiagram" }));
    extension.reply("/export_diagrams", ok({ written: 2 }));

    const mermaid = await mcp.call("call_endpoint", {
      name: "export_text",
      body: { diagram: "D1", format: "mermaid" },
    });
    const files = await mcp.call("call_endpoint", {
      name: "export_diagrams",
      body: { path: "/tmp/out", format: "drawio" },
    });

    expect(mermaid.isError, text(mermaid)).toBeFalsy();
    expect(files.isError, text(files)).toBeFalsy();
  });
});

/**
 * Property tests over the new listed schemas: whatever arguments arrive, a call is refused
 * before sending or sends a body the endpoint's whole request schema accepts.
 */
describe("properties of the new listed schemas", () => {
  const json = fc.jsonValue({ maxDepth: 2 });
  const plausible = fc.oneof(
    fc.string({ maxLength: 12 }),
    fc.constantFrom("developer", "business", "dba", "runtime", "code-classes", "Model"),
    fc.boolean(),
    fc.nat(600),
    json,
  );

  it.each(NEW)(
    "%s sends only what its whole request schema takes",
    async (name) => {
      for (const path of ["/request_diagram", "/list_templates", "/describe_template"]) {
        extension.reply(path, ok({}));
      }
      for (const path of ["/list_viewpoints", "/describe_viewpoint", "/viewpoint_lint"]) {
        extension.reply(path, ok({}));
      }
      const strict = strictRequestSchema(entry(name));
      const keys = [...Object.keys(entry(name).request.properties ?? {}), "unknown"];
      await fc.assert(
        fc.asyncProperty(fc.dictionary(fc.constantFrom(...keys), plausible), async (args) => {
          const before = extension.requests.length;
          const result = await mcp.call(name, args);
          const sent = extension.requests.slice(before);
          if (result.isError) {
            expect(sent).toEqual([]);
            return;
          }
          expect(sent).toHaveLength(1);
          expect(strict.safeParse(sent[0]!.body).success, JSON.stringify(sent[0]!.body)).toBe(true);
        }),
        { numRuns: 150 },
      );
    },
    60_000,
  );

  it("request_diagram passes any intent of 1 to 500 characters as written", async () => {
    extension.reply("/request_diagram", ok(REQUESTED));
    extension.reply("/get_style_profile", styleProfile(true));
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 500 }), async (intent) => {
        const before = extension.requests.length;
        const result = await mcp.call("request_diagram", { intent, scope: "M" });
        expect(result.isError, text(result)).toBeFalsy();
        expect(extension.requests.at(before)!.body).toEqual({ intent, scope: "M" });
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
