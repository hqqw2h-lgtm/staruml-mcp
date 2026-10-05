#!/usr/bin/env node
// Token benchmark: replays four modelling scenarios against the current server and against three
// earlier servers loaded with `git show`: 56864ca (before issue #5), 0cfc06b (issue #5, the last
// hand-written tool set) and 45bedd4 (phase 2a: one tool per manifest endpoint). All talk to the
// HTTP stand-ins the tests use, so the benchmark runs offline and every server sees identical
// upstream data, shaped like StarUML 7.1.1 + extension 0.3.0 responses (element summaries, paged
// find_elements).
//
// Counted per scenario: the tools/list definitions (name, description, inputSchema) once, the
// server instructions once, and the text of every tool result. Clients resend the definitions
// with each model turn, so a single copy is the most conservative figure. Image bytes are
// excluded: they are identical on all sides and billed as vision input, not text.
//
// A step whose tool a server does not list goes through call_endpoint, and the scenario first
// asks describe_endpoints for every such endpoint it uses, in one call whose result is counted:
// a model has to read a schema before it can fill a body.
//
// The two native-diagram scenarios have a second plan for a server that lists the batch tool:
// every creation in one /batch call, and /export_diagram instead of the built-in image endpoint.
// Endpoints used inside the batch count as used for describe_endpoints, since each op body
// follows its endpoint's schema.
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
  { label: "phase2a", commit: "45bedd4" },
];
const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Writes a commit's sources inside node_modules so their SDK and zod imports resolve. The bundled
 * manifest (phase 2a) and package.json come along, since sources import both.
 */
function loadSources(commit) {
  const base = `${root}node_modules/.cache/token-benchmark/${commit}`;
  mkdirSync(`${base}/src`, { recursive: true });
  const files = execFileSync("git", ["ls-tree", "--name-only", commit, "src/"], { cwd: root })
    .toString()
    .split("\n")
    .filter((f) => f.endsWith(".ts") || f.endsWith(".json"));
  for (const file of [...files, "package.json"]) {
    writeFileSync(`${base}/${file}`, gitShow(commit, file));
  }
  return pathToFileURL(`${base}/src/server.ts`).href;
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

/**
 * A native diagram built from `nodes` and `edges`, as the two ways a server offers: one call per
 * element (`steps`), or one /batch call whose ops name earlier results with "$name" references
 * (`batch`), answered the way extension 0.3.0 answers it (src/handlers/batch.ts).
 */
function nativeDiagram(type, name, nodes, edges) {
  const diagram = summary(type, name, model);
  const created = nodes.map((n) => ({ ...n, data: createdWithView(n.type, n.name, diagram) }));
  const edgeData = edges.map(([tail]) => ({
    view: summary("UMLAssociationView", null, diagram),
    model: summary("UMLAssociation", "", created[tail].data.model),
  }));
  const nodeArgs = (n, diagramId) => ({
    type: n.type,
    parentId: model._id,
    diagramId,
    name: n.name,
    x: n.x,
    y: n.y,
  });
  const edgeArgs = (tailViewId, headViewId, diagramId) => ({
    type: "UMLAssociation",
    parentId: model._id,
    diagramId,
    tailViewId,
    headViewId,
  });
  const steps = [
    step(
      "create_diagram",
      { type, parentId: model._id, name },
      "extension",
      "/create_diagram",
      diagram,
    ),
    ...created.map((n) =>
      step(
        "create_element_with_view",
        nodeArgs(n, diagram._id),
        "extension",
        "/create_element_with_view",
        n.data,
      ),
    ),
    ...edges.map(([tail, head], i) =>
      step(
        "create_edge_with_view",
        edgeArgs(created[tail].data.view._id, created[head].data.view._id, diagram._id),
        "extension",
        "/create_edge_with_view",
        edgeData[i],
      ),
    ),
  ];
  const ops = [
    { path: "/create_diagram", body: { type, parentId: model._id, name }, as: "d" },
    ...created.map((n, i) => ({
      path: "/create_element_with_view",
      body: nodeArgs(n, "$d"),
      as: `n${i}`,
    })),
    ...edges.map(([tail, head]) => ({
      path: "/create_edge_with_view",
      body: edgeArgs(`$n${tail}.view`, `$n${head}.view`, "$d"),
    })),
  ];
  const datas = [diagram, ...created.map((n) => n.data), ...edgeData];
  const answer = {
    atomic: true,
    succeeded: ops.length,
    failed: 0,
    results: ops.map((op, i) => ({
      path: op.path,
      ...(op.as === undefined ? {} : { as: op.as }),
      success: true,
      data: datas[i],
    })),
  };
  return { diagram, steps, batch: step("batch", { ops }, "extension", "/batch", answer) };
}

const useCase = nativeDiagram(
  "UMLUseCaseDiagram",
  "Checkout",
  [
    { type: "UMLActor", name: "Customer" },
    { type: "UMLActor", name: "Clerk" },
    { type: "UMLUseCase", name: "Place order" },
    { type: "UMLUseCase", name: "Pay" },
  ].map((n, i) => ({ ...n, x: 100 + 200 * i, y: 100 })),
  [
    [0, 2],
    [0, 3],
    [1, 3],
  ],
);

const shop = nativeDiagram(
  "UMLClassDiagram",
  "Shop",
  ["Customer", "Order", "OrderLine", "Product"].map((name, i) => ({
    type: "UMLClass",
    name,
    x: 60 + 220 * i,
    y: 120,
  })),
  [
    [0, 1],
    [1, 2],
    [2, 3],
  ],
);

const findModel = step("find_elements", { type: "UMLModel" }, "extension", "/find_elements", {
  count: 1,
  elements: [model],
  nextCursor: null,
});

const saveAs = (filename) =>
  step("save_project", { filename }, "extension", "/save_project", { filename });

/** What /export_diagram answers for a PNG; the image itself is the same stub as the built-in's. */
const exported = {
  diagram: shop.diagram._id,
  format: "png",
  mimeType: "image/png",
  width: 1012,
  height: 236,
  bytes: 21540,
  base64: "iVBORw0KGgo=",
};

/**
 * `steps` is what every server can replay; `batched` is the same work for a server that lists
 * the batch tool: one /batch for the creations and /export_diagram for the preview.
 */
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
      findModel,
      ...useCase.steps,
      saveAs("/work/checkout.mdj"),
    ],
    batched: [findModel, useCase.batch, saveAs("/work/checkout.mdj")],
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
  {
    name: "Native class diagram + export",
    steps: [
      findModel,
      ...shop.steps,
      step(
        "get_diagram_image_by_id",
        { diagramId: shop.diagram._id },
        "builtin",
        "/get_diagram_image_by_id",
        "iVBORw0KGgo=",
      ),
      saveAs("/work/shop.mdj"),
    ],
    batched: [
      findModel,
      shop.batch,
      step("export_diagram", { id: shop.diagram._id }, "extension", "/export_diagram", exported),
      saveAs("/work/shop.mdj"),
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
    const listed = new Set(tools.map((t) => t.name));
    const perScenario = [];
    for (const scenario of scenarios) {
      const steps = listed.has("batch") && scenario.batched ? scenario.batched : scenario.steps;
      let results = 0;
      const call = async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) {
          throw new Error(`${scenario.name}: ${name} failed: ${JSON.stringify(result.content)}`);
        }
        results += textTokens(result);
      };
      // A batch op's body follows its endpoint's schema, which the model must have read too.
      const used = steps.flatMap((s) =>
        s.tool === "batch" ? s.args.ops.map((op) => op.path.slice(1)) : [s.tool],
      );
      const unlisted = [...new Set(used)].filter((t) => !listed.has(t));
      if (unlisted.length > 0) await call("describe_endpoints", { names: unlisted });
      for (const s of steps) {
        const fixture = s.upstream === "builtin" ? builtin : extension;
        fixture.reply(s.slug, { body: ok(s.data) });
        await (listed.has(s.tool)
          ? call(s.tool, s.args)
          : call("call_endpoint", { name: s.tool, body: s.args }));
      }
      perScenario.push({ definitions, results, total: definitions + results, calls: steps.length });
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
const current = await import("../src/server.ts");
const { CatalogState } = await import("../src/extension-tools.ts");
const { parseToolSelection } = await import("../src/tiers.ts");
/** The current server with `--tools <value>`. */
const withTools = (value) => (config) =>
  current.createServer({
    ...config,
    catalog: new CatalogState(undefined, parseToolSelection(value)),
  });
const all = await measure(withTools("all"));
servers.push({ label: "now", ...(await measure(withTools("core"))) });

const pct = (b, a) => `${(((a - b) / b) * 100).toFixed(1)}%`;
const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);
const now = servers.at(-1);
const rows = [
  ...scenarios.map((s, i) => ({
    scenario: s.name,
    pick: (m) => m.perScenario[i],
  })),
  {
    scenario: "all scenarios",
    pick: (m) => ({
      results: sum(m.perScenario, "results"),
      total: sum(m.perScenario, "total"),
      calls: sum(m.perScenario, "calls"),
    }),
  },
].map(({ scenario, pick }) => {
  // Calls of a baseline / of the current server, describe_endpoints not included.
  const row = { scenario, calls: `${pick(servers[0]).calls}/${pick(now).calls}` };
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
console.log(
  `--tools all: ${all.definitions} definition tokens (${all.tools} tools), all scenarios ${sum(all.perScenario, "total")}.`,
);
/** The 60%-below-pre-#5 target of issue #5, over `count` scenarios from the first. */
function target(count) {
  const totals = (m) => sum(m.perScenario.slice(0, count), "total");
  const goal = Math.floor(totals(servers[0]) * 0.4);
  const reached = totals(now);
  const definitions = now.definitions * count;
  console.log(
    `Target over the first ${count} scenarios (60% below ${servers[0].label} ${totals(servers[0])}): <= ${goal}; now ${reached} (${pct(totals(servers[0]), reached)}), ${reached <= goal ? "met" : `${reached - goal} over`}; definitions alone ${definitions}.`,
  );
}
target(3);
target(scenarios.length);
