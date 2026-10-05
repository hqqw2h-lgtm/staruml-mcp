#!/usr/bin/env node
// Token benchmark for issue #5: replays three modelling scenarios against the current server and
// against the baseline tool definitions of commit 56864ca (branch `phase0`), both talking to the
// HTTP stand-ins the tests use, so it runs offline and both see identical upstream data.
//
// Counted per scenario: the tools/list definitions (name, description, inputSchema) once, the
// server instructions once, and the text of every tool result. Clients resend the definitions
// with each model turn, so a single copy is the most conservative figure. Image bytes are
// excluded: they are identical on both sides and billed as vision input, not text.
// Tokens are o200k_base counts from gpt-tokenizer; other tokenizers differ by a few percent
// but the before/after ratio is what matters.
//
// Usage: node --import tsx scripts/token-benchmark.mjs   (npm run benchmark:tokens)

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { UpstreamFixture } from "../tests/support/fixture.ts";

const BASELINE_COMMIT = "56864caa5900cba41ed87c8754ffbcc5ab44a7f9";
const root = fileURLToPath(new URL("..", import.meta.url));

/** Writes the baseline sources inside node_modules so their SDK and zod imports resolve. */
function loadBaselineSources() {
  const dir = `${root}node_modules/.cache/token-benchmark/${BASELINE_COMMIT}/src`;
  mkdirSync(dir, { recursive: true });
  for (const file of ["server.ts", "errors.ts", "staruml-client.ts", "tool-result.ts"]) {
    const source = execFileSync("git", ["show", `${BASELINE_COMMIT}:src/${file}`], { cwd: root });
    writeFileSync(`${dir}/${file}`, source);
  }
  return pathToFileURL(`${dir}/server.ts`).href;
}

// --- Upstream data shaped like StarUML 7.1.1 + staruml-mcp-extension v0.2.2 responses ---------

const commands = JSON.parse(
  readFileSync(new URL("benchmark-data/commands-7.1.1.json", import.meta.url), "utf8"),
);
let nextId = 0;
/** 20-character ids in the style of StarUML's `IdGenerator`. */
const newId = () => `AAAAAAGhCi${(nextId++).toString(36).padStart(9, "0")}=`;
const ref = (element) => ({ _id: element._id, name: element.name });

const project = { _id: newId(), name: "Untitled" };
const model = { _id: newId(), name: "Model" };

/** What v0.2.2's `shallow()` returns for a UMLClass created through the UI. */
function umlClass(name, attributes = []) {
  return {
    _id: newId(),
    _parent: ref(model),
    name,
    ownedElements: [],
    documentation: "",
    tags: [],
    stereotype: null,
    visibility: "public",
    templateParameters: [],
    attributes: attributes.map((a) => ({ _id: newId(), name: a })),
    operations: [],
    receptions: [],
    behaviors: [],
    isAbstract: false,
    isFinalSpecialization: false,
    isLeaf: false,
    isActive: false,
  };
}

const modelElement = {
  _id: model._id,
  _parent: ref(project),
  name: model.name,
  ownedElements: [],
  documentation: "",
  tags: [],
  stereotype: null,
  visibility: "public",
  templateParameters: [],
  ownedViews: [],
};

const diagrams = [
  { id: newId(), type: "UMLClassDiagram", name: "Main", description: "" },
  { id: newId(), type: "UMLClassDiagram", name: "Class Diagram by Mermaid", description: "" },
  { id: newId(), type: "UMLUseCaseDiagram", name: "Use Cases", description: "" },
];

const classes = [
  "Order",
  "Customer",
  "Invoice",
  "Payment",
  "Product",
  "Cart",
  "Address",
  "Shipment",
].map((n) => umlClass(n, ["id", "createdAt", "status"]));

const ok = (data) => ({ success: true, data });

const step = (tool, args, upstream, slug, data) => ({ tool, args, upstream, slug, data });

function createdWithView(name) {
  return { view: { _id: newId() }, model: { _id: newId(), name } };
}

const useCaseDiagram = { _id: newId(), name: "Checkout", type: "UMLUseCaseDiagram" };
const actors = ["Customer", "Clerk"].map((n) => ({ name: n, created: createdWithView(n) }));
const useCases = ["Place order", "Pay"].map((n) => ({ name: n, created: createdWithView(n) }));

const scenarios = [
  {
    name: "Mermaid class diagram + preview",
    steps: [
      step(
        "generate_diagram",
        {
          code: "classDiagram\n  class Order {\n    +id: UUID\n    +status: Status\n  }\n  class Customer\n  Customer --> Order : places",
        },
        "builtin",
        "/generate_diagram",
        undefined,
      ),
      step("get_all_diagrams_info", {}, "builtin", "/get_all_diagrams_info", diagrams),
      step("get_current_diagram_info", {}, "builtin", "/get_current_diagram_info", diagrams[1]),
      step(
        "get_diagram_image_by_id",
        { diagramId: diagrams[1].id },
        "builtin",
        "/get_diagram_image_by_id",
        "iVBORw0KGgo=",
      ),
    ],
  },
  {
    name: "Native use-case diagram",
    steps: [
      step("get_project_info", {}, "extension", "/get_project_info", {
        filename: null,
        project: { ...project, ownedElementsCount: 1 },
      }),
      step("find_elements", { type: "UMLModel" }, "extension", "/find_elements", {
        count: 1,
        elements: [modelElement],
      }),
      step(
        "create_diagram",
        { type: "UMLUseCaseDiagram", parentId: model._id, name: "Checkout" },
        "extension",
        "/create_diagram",
        useCaseDiagram,
      ),
      ...[...actors, ...useCases].map((e, i) =>
        step(
          "create_element_with_view",
          {
            type: i < actors.length ? "UMLActor" : "UMLUseCase",
            parentId: model._id,
            diagramId: useCaseDiagram._id,
            name: e.name,
            x: 100 + 200 * i,
            y: 100,
          },
          "extension",
          "/create_element_with_view",
          e.created,
        ),
      ),
      ...[
        [actors[0], useCases[0]],
        [actors[0], useCases[1]],
        [actors[1], useCases[1]],
      ].map(([tail, head]) =>
        step(
          "create_edge_with_view",
          {
            type: "UMLAssociation",
            parentId: model._id,
            diagramId: useCaseDiagram._id,
            tailViewId: tail.created.view._id,
            headViewId: head.created.view._id,
          },
          "extension",
          "/create_edge_with_view",
          { view: { _id: newId() }, model: { _id: newId(), name: "" } },
        ),
      ),
      step("save_project", { filename: "/work/checkout.mdj" }, "extension", "/save_project", {
        filename: "/work/checkout.mdj",
      }),
    ],
  },
  {
    name: "Inspect and refactor a class model",
    steps: [
      step("get_all_commands", {}, "extension", "/get_all_commands", commands),
      step("find_elements", { type: "UMLClass" }, "extension", "/find_elements", {
        count: classes.length,
        elements: classes,
      }),
      step(
        "get_element_by_id",
        { id: classes[2]._id },
        "extension",
        "/get_element_by_id",
        classes[2],
      ),
      step(
        "update_element",
        { id: classes[2]._id, field: "name", value: "Bill" },
        "extension",
        "/update_element",
        { ...classes[2], name: "Bill" },
      ),
      step(
        "update_element",
        { id: classes[2]._id, field: "documentation", value: "Issued per order." },
        "extension",
        "/update_element",
        { ...classes[2], name: "Bill", documentation: "Issued per order." },
      ),
      step("delete_element", { id: classes[7]._id }, "extension", "/delete_element", {
        deleted: classes[7]._id,
        models_deleted: 1,
        views_deleted: 1,
      }),
      step("execute_command", { id: "view:fit-to-window" }, "extension", "/execute_command", {
        id: "view:fit-to-window",
        result: null,
      }),
      step("save_project", {}, "extension", "/save_project", { filename: "/work/shop.mdj" }),
    ],
  },
];

// --- Replay ------------------------------------------------------------------------------------

const textTokens = (result) =>
  result.content.filter((c) => c.type === "text").reduce((sum, c) => sum + countTokens(c.text), 0);

async function measure(createServer) {
  const builtin = await new UpstreamFixture().start();
  const extension = await new UpstreamFixture().start();
  const server = createServer({
    apiHost: "http://127.0.0.1",
    apiPort: builtin.port,
    extPort: extension.port,
  });
  const client = new Client({ name: "token-benchmark", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    // Only what a client forwards to the model; `execution` and other protocol fields are not.
    const forwarded = tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
    const definitions =
      countTokens(JSON.stringify(forwarded)) + countTokens(client.getInstructions() ?? "");
    const perScenario = [];
    for (const scenario of scenarios) {
      let results = 0;
      for (const s of scenario.steps) {
        const fixture = s.upstream === "builtin" ? builtin : extension;
        fixture.reply(s.slug, { body: ok(s.data) });
        const result = await client.callTool({ name: s.tool, arguments: s.args });
        if (result.isError) {
          throw new Error(`${scenario.name}: ${s.tool} failed: ${JSON.stringify(result.content)}`);
        }
        results += textTokens(result);
      }
      perScenario.push({ definitions, results, total: definitions + results });
    }
    return { definitions, perScenario };
  } finally {
    await client.close();
    await server.close();
    await builtin.stop();
    await extension.stop();
  }
}

const baseline = await import(loadBaselineSources());
const current = await import("../src/server.ts");
const before = await measure(baseline.createServer);
const after = await measure(current.createServer);

const pct = (b, a) => `${(((b - a) / b) * 100).toFixed(1)}%`;
const rows = scenarios.map((s, i) => {
  const b = before.perScenario[i];
  const a = after.perScenario[i];
  return {
    scenario: s.name,
    calls: s.steps.length,
    "results before": b.results,
    "results after": a.results,
    "total before": b.total,
    "total after": a.total,
    reduction: pct(b.total, a.total),
  };
});
const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);
const totalBefore = sum(before.perScenario, "total");
const totalAfter = sum(after.perScenario, "total");
rows.push({
  scenario: "all scenarios",
  calls: sum(rows, "calls"),
  "results before": sum(before.perScenario, "results"),
  "results after": sum(after.perScenario, "results"),
  "total before": totalBefore,
  "total after": totalAfter,
  reduction: pct(totalBefore, totalAfter),
});

console.log(`Tokenizer: o200k_base (gpt-tokenizer). Baseline: ${BASELINE_COMMIT.slice(0, 7)}.`);
console.log(
  `Tool definitions + instructions: ${before.definitions} -> ${after.definitions} tokens ` +
    `(${pct(before.definitions, after.definitions)} less), counted once per scenario.`,
);
console.table(rows);
