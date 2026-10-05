#!/usr/bin/env node
// Token benchmark: replays four modelling scenarios against the current server and against three
// earlier servers loaded with `git show`: 56864ca (before issue #5), 0cfc06b (issue #5, the last
// hand-written tool set) and 45bedd4 (phase 2a: one tool per manifest endpoint). All talk to the
// HTTP stand-ins the tests use, so the benchmark runs offline and every server sees identical
// upstream data, shaped like StarUML 7.1.1 + extension 0.3.0 responses (element summaries, paged
// find_elements).
//
// Two accountings are reported side by side:
// (a) per scenario: the tools/list definitions (name, description, inputSchema) and the server
//     instructions once per scenario, plus the text of every tool result. Clients resend the
//     definitions with each model turn, so one copy per scenario is the most conservative
//     figure; the issue #5 baseline was measured this way.
// (b) per session with prompt caching: the definitions and instructions once for the whole
//     session of four scenarios, as a client that caches its prompt prefix (Anthropic prompt
//     caching, OpenAI's prefix cache) sends the fixed tool list once and reads it from the cache
//     at a fraction of the price after that; then, for every call, the result text plus the call
//     itself, its tool name and arguments as JSON, which the model writes as output tokens.
// Image bytes are excluded from both: they are identical on all sides and billed as vision input.
//
// A step whose tool a server does not list goes through call_endpoint, and the scenario first
// asks describe_endpoints for every such endpoint it uses, in one call whose result is counted:
// a model has to read a schema before it can fill a body.
//
// The two native-diagram scenarios have two more plans. A server that lists build_diagram
// builds the diagram with one /build_diagram call from a spec, which is what the endpoint is
// for; one that lists batch makes every creation in one /batch call. Both use /export_diagram
// instead of the built-in image endpoint. Endpoints used inside a batch count as used for
// describe_endpoints, since each op body follows its endpoint's schema; build_diagram's listing
// carries its spec grammar, so it needs none. The current server is also replayed with the batch
// plan, for comparison.
// A fifth scenario, "read and explain a diagram", runs on the current server only and compares
// the ways it offers to read one six-class diagram back: the built-in PNG, an element dump with
// find_elements, describe_diagram, and diagram_as_text as Mermaid and as PlantUML. Its upstream
// answers are what StarUML 7.1.1 and the extension answered for that diagram, recorded by
// scripts/capture-read-diagram.mjs in benchmark-data/read-diagram-7.1.1.json. The PNG's tokens
// are estimated, since image bytes are not text: width x height / 750 after scaling to at most
// 1568 px on the long edge and about 1,600 tokens (Anthropic's vision guide, "Evaluate image
// size"); other vendors price images differently.
//
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
 * A native diagram built from `nodes` and `edges`, as the three ways a server offers: one call
 * per element (`steps`), one /batch call whose ops name earlier results with "$name" references
 * (`batch`), or one /build_diagram call with `spec` (`build`), each answered the way extension
 * 0.3.0 answers it (src/handlers/batch.ts, src/handlers/build.ts).
 */
function nativeDiagram(type, name, nodes, edges, spec) {
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
  // What 0.3.0's /build_diagram answers for the same diagram (src/handlers/build.ts).
  const built = {
    diagram: { _id: diagram._id, _type: diagram._type, name },
    kind: spec.kind,
    upserted: false,
    created: nodes.length + edges.length,
    updated: 0,
    unchanged: 0,
    layout: "engine",
    ids: Object.fromEntries(
      created.map((n) => [n.name, { model: n.data.model._id, view: n.data.view._id }]),
    ),
    edges: edges.map(([tail, head], i) => ({
      key: `${nodes[tail].name} -> ${nodes[head].name}`,
      model: edgeData[i].model._id,
      view: edgeData[i].view._id,
    })),
  };
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
  return {
    diagram,
    steps,
    batch: step("batch", { ops }, "extension", "/batch", answer),
    build: step(
      "build_diagram",
      { kind: spec.kind, name, spec: spec.body },
      "extension",
      "/build_diagram",
      built,
    ),
  };
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
  {
    kind: "usecase",
    body: {
      actors: ["Customer", "Clerk"],
      useCases: ["Place order", "Pay"],
      relations: [
        { from: "Customer", to: "Place order" },
        { from: "Customer", to: "Pay" },
        { from: "Clerk", to: "Pay" },
      ],
    },
  },
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
  {
    kind: "class",
    body: {
      classes: ["Customer", "Order", "OrderLine", "Product"].map((name) => ({ name })),
      relations: [
        { from: "Customer", to: "Order" },
        { from: "Order", to: "OrderLine" },
        { from: "OrderLine", to: "Product" },
      ],
    },
  },
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
 * `steps` is what every server can replay; `built` and `batched` are the same work for a server
 * that lists build_diagram or batch: one call for the creations and /export_diagram for the
 * preview. Only the element-by-element plans look the model up, since they need a parent id;
 * build_diagram defaults to the project, where StarUML adds the model the kind needs.
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
    built: [useCase.build, saveAs("/work/checkout.mdj")],
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
    built: [
      shop.build,
      step("export_diagram", { id: shop.diagram._id }, "extension", "/export_diagram", exported),
      saveAs("/work/shop.mdj"),
    ],
  },
];

// --- Replay ------------------------------------------------------------------------------------

const textTokens = (result) =>
  result.content.filter((c) => c.type === "text").reduce((sum, c) => sum + countTokens(c.text), 0);

/** A call as the model writes it: the tool name and its arguments as JSON. */
const callTokens = (name, args) => countTokens(JSON.stringify({ name, arguments: args }));

/** Plans by preference: a scenario takes the first whose tool the server lists. */
const PLANS = [
  ["build_diagram", "built"],
  ["batch", "batched"],
];

/** Arguments as written for the baselines, which predate extension 0.3.0's canonical names. */
const asWritten = (_tool, args) => args;

async function measure(createServer, plans = PLANS, argsFor = asWritten) {
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
      const plan = plans.find(([tool, key]) => listed.has(tool) && scenario[key] !== undefined);
      const steps = plan === undefined ? scenario.steps : scenario[plan[1]];
      let results = 0;
      let calls = 0;
      const call = async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) {
          throw new Error(`${scenario.name}: ${name} failed: ${JSON.stringify(result.content)}`);
        }
        results += textTokens(result);
        calls += callTokens(name, args);
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
        const args = argsFor(s.tool, s.args);
        await (listed.has(s.tool)
          ? call(s.tool, args)
          : call("call_endpoint", { name: s.tool, body: args }));
      }
      perScenario.push({
        results,
        calls,
        perScenario: definitions + results,
        cached: results + calls,
        steps: steps.length,
      });
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
const { BUNDLED_MANIFEST, aliasesOf } = await import("../src/manifest.ts");
/** Old field name to canonical, by endpoint name (`id` to `ref`, `diagramId` to `diagram`, ...). */
const ALIASES = Object.fromEntries(
  BUNDLED_MANIFEST.endpoints.map((e) => [e.path.slice(1), aliasesOf(e)]),
);
const renamed = (tool, body) =>
  Object.fromEntries(Object.entries(body).map(([k, v]) => [ALIASES[tool]?.[k] ?? k, v]));
/**
 * Arguments as a model writes them for the current server: the canonical names extension 0.3.0
 * lists, in batch op bodies too. The scenarios are written with the names every baseline knows.
 */
const canonical = (tool, args) =>
  tool === "batch"
    ? { ...args, ops: args.ops.map((op) => ({ ...op, body: renamed(op.path.slice(1), op.body) })) }
    : renamed(tool, args);
const all = await measure(withTools("all"), PLANS, canonical);
servers.push({ label: "now batch", ...(await measure(withTools("core"), [PLANS[1]], canonical)) });
servers.push({ label: "now", ...(await measure(withTools("core"), PLANS, canonical)) });

const pct = (b, a) => `${(((a - b) / b) * 100).toFixed(1)}%`;
const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);
const [pre5, issue5] = servers;
const now = servers.at(-1);

/** (a): definitions once per scenario, over the first `count` scenarios. */
const perScenario = (m, count = scenarios.length) =>
  sum(m.perScenario.slice(0, count), "perScenario");
/** (b): definitions once per session, over the first `count` scenarios. */
const cached = (m, count = scenarios.length) =>
  m.definitions + sum(m.perScenario.slice(0, count), "cached");

function table(key, session) {
  const rows = scenarios.map((s, i) => {
    const row = {
      scenario: s.name,
      calls: `${pre5.perScenario[i].steps}/${now.perScenario[i].steps}`,
    };
    for (const m of servers) row[m.label] = m.perScenario[i][key];
    row["vs pre-#5"] = pct(pre5.perScenario[i][key], now.perScenario[i][key]);
    row["vs #5"] = pct(issue5.perScenario[i][key], now.perScenario[i][key]);
    return row;
  });
  if (session) {
    const row = { scenario: "definitions, once", calls: "" };
    for (const m of servers) row[m.label] = m.definitions;
    rows.push(row);
  }
  const total = {
    scenario: "all scenarios",
    calls: `${sum(pre5.perScenario, "steps")}/${sum(now.perScenario, "steps")}`,
  };
  const of = session ? cached : perScenario;
  for (const m of servers) total[m.label] = of(m);
  total["vs pre-#5"] = pct(of(pre5), of(now));
  total["vs #5"] = pct(of(issue5), of(now));
  rows.push(total);
  console.table(rows);
}

console.log(
  `Tokenizer: o200k_base (gpt-tokenizer). Baselines: ${BASELINES.map((b) => `${b.label} ${b.commit.slice(0, 7)}`).join(", ")}; "now batch" is the current core tier with the batch plan instead of build_diagram.`,
);
console.log(
  `Tool definitions + instructions (tools): ${servers.map((m) => `${m.label} ${m.definitions} (${m.tools})`).join(", ")}.`,
);
console.log("\n(a) Definitions once per scenario, plus result text:");
table("perScenario", false);
console.log("\n(b) Definitions once per session (prompt caching), plus result text and the calls:");
table("cached", true);
console.log(
  `\n--tools all: ${all.definitions} definition tokens (${all.tools} tools); all scenarios (a) ${perScenario(all)}, (b) ${cached(all)}.`,
);

/** Whether `reached` is at most `goal`, as a line. */
const verdict = (reached, goal) =>
  reached <= goal
    ? `met (${reached} <= ${goal})`
    : `not met (${reached}, ${reached - goal} over ${goal})`;
console.log("\nTargets:");
for (const count of [3, scenarios.length]) {
  for (const [name, of] of [
    ["(a)", perScenario],
    ["(b)", cached],
  ]) {
    const goal = Math.floor(of(pre5, count) * 0.4);
    console.log(
      `  #5/#8 60% below pre-#5 over ${count} scenarios ${name}: ${verdict(of(now, count), goal)}, ${pct(of(pre5, count), of(now, count))}`,
    );
  }
}
console.log(`  #8 definitions <= 2000: ${verdict(now.definitions, 2000)}`);
for (const [name, of] of [
  ["(a)", perScenario],
  ["(b)", cached],
]) {
  console.log(`  #8 all scenarios below #5 ${name}: ${verdict(of(now), of(issue5) - 1)}`);
}

// --- Read and explain a diagram ------------------------------------------------------------------

const read = JSON.parse(
  readFileSync(new URL("benchmark-data/read-diagram-7.1.1.json", import.meta.url), "utf8"),
);

/** The estimate described above; the PNG is downscaled first when it is larger. */
function imageTokens({ width, height }) {
  const edge = Math.min(1, 1568 / Math.max(width, height));
  const area = Math.min(width * edge * height * edge, 1600 * 750);
  return Math.ceil(area / 750);
}

const readPlans = [
  {
    name: "PNG (get_diagram_image_by_id)",
    tool: "get_diagram_image_by_id",
    args: { diagramId: read.diagramId },
    upstream: "builtin",
    slug: "/get_diagram_image_by_id",
    data: "iVBORw0KGgo=",
    image: imageTokens(read.png),
  },
  {
    name: "Element dump (find_elements)",
    tool: "find_elements",
    args: read.dumpArgs,
    upstream: "extension",
    slug: "/find_elements",
    data: read.dump,
  },
  {
    name: "describe_diagram",
    tool: "describe_diagram",
    args: { diagram: read.diagramId },
    upstream: "extension",
    slug: "/describe_diagram",
    data: read.describe,
  },
  {
    name: "diagram_as_text (Mermaid)",
    tool: "diagram_as_text",
    args: { diagram: read.diagramId },
    upstream: "extension",
    slug: "/export_text",
    data: read.mermaid,
  },
  {
    name: "diagram_as_text (PlantUML)",
    tool: "diagram_as_text",
    args: { diagram: read.diagramId, format: "plantuml" },
    upstream: "extension",
    slug: "/export_text",
    data: read.plantuml,
  },
];

async function measureReads() {
  const builtin = await new UpstreamFixture().start();
  const extension = await new UpstreamFixture().start();
  const server = withTools("core")({
    apiHost: "http://127.0.0.1",
    apiPort: builtin.port,
    extPort: extension.port,
  });
  const client = new Client({ name: "token-benchmark", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const rows = [];
    for (const plan of readPlans) {
      (plan.upstream === "builtin" ? builtin : extension).reply(plan.slug, { body: ok(plan.data) });
      const result = await client.callTool({ name: plan.tool, arguments: plan.args });
      if (result.isError) throw new Error(`${plan.name}: ${JSON.stringify(result.content)}`);
      const call = callTokens(plan.tool, plan.args);
      const text = textTokens(result);
      const image = plan.image ?? 0;
      rows.push({
        read: plan.name,
        call,
        "result text": text,
        "image (est.)": image,
        total: call + text + image,
      });
    }
    const png = rows[0].total;
    for (const row of rows) row["vs PNG"] = row === rows[0] ? "" : pct(png, row.total);
    return rows;
  } finally {
    await client.close();
    await server.close();
    await builtin.stop();
    await extension.stop();
  }
}

console.log(
  `\nRead and explain a diagram: "${read.describe.diagram.name}", ${read.dump.count} classifiers and ` +
    `${read.describe.edges} edges, PNG ${read.png.width}x${read.png.height} (StarUML ` +
    `${read.versions.staruml.version}, extension ${read.versions.extension.version}); one call each, ` +
    "results and calls counted, definitions left out:",
);
console.table(await measureReads());

// --- Fix a messy diagram ---------------------------------------------------------------------

// What StarUML 7.1.1 and the extension answered while one messy class diagram was fixed both
// ways, recorded by scripts/capture-messy-diagram.mjs in benchmark-data/messy-diagram-7.1.1.json:
// five classes with long names, three stacked at one point and two overlapping. "By eye" is the
// way without the lint: look at the PNG, run Format > Layout through call_endpoint (after reading
// its schema), look again. "Lint loop" is the #13 way: lint_diagram, every autofix in one batch,
// lint_diagram again, one look at the PNG. The PNG estimate is the one above; the last column is
// what lint_diagram still finds after each.
const messy = JSON.parse(
  readFileSync(new URL("benchmark-data/messy-diagram-7.1.1.json", import.meta.url), "utf8"),
);

/** A step of a fixing plan: one tool call, the upstream answers it needs, an image estimate. */
const fixStep = (tool, args, replies, image = 0) => ({ tool, args, replies, image });

const look = (png) =>
  fixStep(
    "view_diagram",
    { diagram: messy.diagramId },
    [
      ["extension", "/get_element_by_id", { _id: messy.diagramId, _type: "UMLClassDiagram" }],
      ["builtin", "/get_diagram_image_by_id", "iVBORw0KGgo="],
    ],
    imageTokens(png),
  );
const lintStep = (answer) =>
  fixStep("lint_diagram", { diagram: messy.diagramId }, [["extension", "/lint_diagram", answer]]);

const fixPlans = [
  {
    name: "By eye: PNG, layout, PNG",
    left: messy.byEye.lint.count,
    steps: [
      look(messy.before.png),
      fixStep("describe_endpoints", { names: ["layout_diagram"] }, []),
      fixStep("call_endpoint", { name: "layout_diagram", body: { diagram: messy.diagramId } }, [
        ["extension", "/layout_diagram", messy.byEye.layout],
      ]),
      look(messy.byEye.png),
    ],
  },
  {
    name: "Lint loop: lint, batch of autofixes, lint, PNG",
    left: messy.loop.lint.count,
    steps: [
      lintStep(messy.before.lint),
      fixStep("batch", { ops: messy.loop.fixes }, [["extension", "/batch", messy.loop.batch]]),
      lintStep(messy.loop.lint),
      look(messy.loop.png),
    ],
  },
];

async function measureFixes() {
  const builtin = await new UpstreamFixture().start();
  const extension = await new UpstreamFixture().start();
  const server = withTools("core")({
    apiHost: "http://127.0.0.1",
    apiPort: builtin.port,
    extPort: extension.port,
  });
  const client = new Client({ name: "token-benchmark", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const rows = [];
    for (const plan of fixPlans) {
      let calls = 0;
      let results = 0;
      let images = 0;
      for (const { tool, args, replies, image } of plan.steps) {
        for (const [upstream, slug, data] of replies) {
          (upstream === "builtin" ? builtin : extension).reply(slug, { body: ok(data) });
        }
        const result = await client.callTool({ name: tool, arguments: args });
        if (result.isError) throw new Error(`${plan.name}: ${JSON.stringify(result.content)}`);
        calls += callTokens(tool, args);
        results += textTokens(result);
        images += image;
      }
      rows.push({
        plan: plan.name,
        calls: plan.steps.length,
        "call tokens": calls,
        "result text": results,
        "images (est.)": images,
        total: calls + results + images,
        "findings left": plan.left,
      });
    }
    return rows;
  } finally {
    await client.close();
    await server.close();
    await builtin.stop();
    await extension.stop();
  }
}

console.log(
  `\nFix a messy diagram: ${messy.nodes.length} classes, ${messy.before.lint.count} lint findings ` +
    `(${messy.before.lint.findings.map((f) => f.rule).join(", ")}), StarUML ` +
    `${messy.versions.staruml.version}, extension ${messy.versions.extension.version}; core tier, ` +
    "results and calls counted, definitions left out:",
);
console.table(await measureFixes());
