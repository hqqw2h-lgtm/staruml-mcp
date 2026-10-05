#!/usr/bin/env node
// Token benchmark: replays three modelling scenarios against the current server and against two
// earlier servers loaded with `git show`: 56864ca (before issue #5) and 0cfc06b (issue #5, the last
// hand-written tool set). All three talk to the HTTP stand-ins the tests use, so the benchmark runs
// offline and every server sees identical upstream data, shaped like StarUML 7.1.1 + extension
// 0.3.0 responses (element summaries, paged find_elements).
//
// Counted per scenario: the tools/list definitions (name, description, inputSchema) once, the
// server instructions once, and the text of every tool result. Clients resend the definitions
// with each model turn, so a single copy is the most conservative figure. Image bytes are
// excluded: they are identical on all sides and billed as vision input, not text.
// Tokens are o200k_base counts from gpt-tokenizer; other tokenizers differ by a few percent
// but the ratios are what matters.
//
// Usage: node --import tsx scripts/token-benchmark.mjs   (npm run benchmark:tokens)

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { UpstreamFixture } from "../tests/support/fixture.ts";

const BASELINES = [
  { label: "pre-#5", commit: "56864caa5900cba41ed87c8754ffbcc5ab44a7f9" },
  { label: "#5", commit: "0cfc06b38df701066d49e3d79f89149f073e9efa" },
];
const root = fileURLToPath(new URL("..", import.meta.url));

/** Writes a commit's sources inside node_modules so their SDK and zod imports resolve. */
function loadSources(commit) {
  const dir = `${root}node_modules/.cache/token-benchmark/${commit}/src`;
  mkdirSync(dir, { recursive: true });
  const files = execFileSync("git", ["ls-tree", "--name-only", commit, "src/"], { cwd: root })
    .toString()
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    writeFileSync(
      `${root}node_modules/.cache/token-benchmark/${commit}/${file}`,
      gitShow(commit, file),
    );
  }
  return pathToFileURL(`${dir}/server.ts`).href;
}

function gitShow(commit, file) {
  return execFileSync("git", ["show", `${commit}:${file}`], { cwd: root });
}

// --- Upstream data shaped like StarUML 7.1.1 + staruml-mcp-extension 0.3.0 responses ----------

const commands = JSON.parse(
  readFileSync(new URL("benchmark-data/commands-7.1.1.json", import.meta.url), "utf8"),
);
let nextId = 0;
/** 20-character ids in the style of StarUML's `IdGenerator`. */
const newId = () => `AAAAAAGhCi${(nextId++).toString(36).padStart(9, "0")}=`;
/** What 0.3.0's `summarize()` returns (src/serialize.ts). */
const summary = (_type, name, parent) => ({
  _id: newId(),
  _type,
  name,
  _parent: parent?._id ?? null,
});

const project = summary("Project", "Untitled", undefined);
const model = summary("UMLModel", "Model", project);

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
].map((n) => summary("UMLClass", n, model));

const ok = (data) => ({ success: true, data });

const step = (tool, args, upstream, slug, data) => ({ tool, args, upstream, slug, data });

function createdWithView(type, name, diagram) {
  const created = summary(type, name, model);
  return { view: summary(`${type}View`, null, diagram), model: created };
}

const useCaseDiagram = summary("UMLUseCaseDiagram", "Checkout", model);
const actors = ["Customer", "Clerk"].map((n) => ({
  name: n,
  created: createdWithView("UMLActor", n, useCaseDiagram),
}));
const useCases = ["Place order", "Pay"].map((n) => ({
  name: n,
  created: createdWithView("UMLUseCase", n, useCaseDiagram),
}));

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
        project,
      }),
      step("find_elements", { type: "UMLModel" }, "extension", "/find_elements", {
        count: 1,
        elements: [model],
        nextCursor: null,
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
          {
            view: summary("UMLAssociationView", null, useCaseDiagram),
            model: summary("UMLAssociation", "", tail.created.model),
          },
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
        nextCursor: null,
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
        { ...classes[2], name: "Bill" },
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
    return { definitions, tools: tools.length, perScenario };
  } finally {
    await client.close();
    await server.close();
    await builtin.stop();
    await extension.stop();
  }
}

const servers = [];
for (const { label, commit } of BASELINES) {
  servers.push({ label, ...(await measure((await import(loadSources(commit))).createServer)) });
}
servers.push({ label: "now", ...(await measure((await import("../src/server.ts")).createServer)) });

const pct = (b, a) => `${(((a - b) / b) * 100).toFixed(1)}%`;
const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);
const now = servers.at(-1);
const rows = [
  ...scenarios.map((s, i) => ({
    scenario: s.name,
    calls: s.steps.length,
    pick: (m) => m.perScenario[i],
  })),
  {
    scenario: "all scenarios",
    calls: sum(
      scenarios.map((s) => ({ n: s.steps.length })),
      "n",
    ),
    pick: (m) => ({ results: sum(m.perScenario, "results"), total: sum(m.perScenario, "total") }),
  },
].map(({ scenario, calls, pick }) => {
  const row = { scenario, calls };
  for (const m of servers) row[`results ${m.label}`] = pick(m).results;
  for (const m of servers) row[`total ${m.label}`] = pick(m).total;
  for (const m of servers.slice(0, -1)) {
    row[`vs ${m.label}`] = pct(pick(m).total, pick(now).total);
  }
  return row;
});

console.log(
  `Tokenizer: o200k_base (gpt-tokenizer). Baselines: ${BASELINES.map((b) => `${b.label} ${b.commit.slice(0, 7)}`).join(", ")}.`,
);
console.log(
  `Tool definitions + instructions (tools): ${servers.map((m) => `${m.label} ${m.definitions} (${m.tools})`).join(", ")}; counted once per scenario.`,
);
console.table(rows);
