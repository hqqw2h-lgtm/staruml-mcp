---
name: staruml
description: Use when creating, reading, changing or exporting UML models and diagrams in StarUML through the staruml MCP server - class, sequence, use case, activity, state machine, ER, flowchart, mind map, composite structure, object, communication, timing, SysML, BPMN, data flow, wireframe or AWS/Azure/GCP architecture diagrams, Mermaid into StarUML, .mdj projects, templates, fragments - or whenever the user mentions StarUML.
---
<!-- Generated from plugins/claude-code/skills/staruml/SKILL.md by scripts/sync-skills.mjs; edit that file. -->

# StarUML through the staruml MCP server

The server drives a running StarUML 7 desktop app. Two local ports sit behind it: StarUML's
built-in API (58321: Mermaid import, diagram list, PNG) and the staruml-mcp-extension (58322:
everything else, including whole diagrams from a spec). Tool names below are the server's; a
client may prefix them (Claude Code shows `mcp__staruml__build_diagram`).

Every `json <tool>` block below is a complete set of arguments for that tool. The repository's
tests run each one, so they are known to be accepted as written.

## 1. Run doctor first

Once per session, and again after a tool answers `STARUML_UNREACHABLE`,
`EXTENSION_UNREACHABLE` or `UNKNOWN_ENDPOINT`:

```json doctor
{}
```

Each line is `check status detail`. Act on every `fail` before going on; its remedy names the
fix (start StarUML, enable its API server, install or update the extension, restart StarUML).
`warn` on `tier` means a name in the tool selection is misspelt. Doctor also reloads the
extension's endpoints, so run it after the user upgrades the extension.

## 2. Choose the input

| The user wants | Use |
|---|---|
| A domain model from a description or requirements | `build_model` with an object spec (section 7), then diagrams of it |
| A new diagram of a kind below | `build_diagram` with a `spec`: exact names, one undo step |
| A composite structure, object, communication, timing, SysML, BPMN, DFD, wireframe or cloud diagram | `build_diagram` with a family's nodes and edges (section 4) |
| An element whose exact name the user does not give | `quick_find` (section 14) |
| A design pattern, or a class to be a value object or entity | `apply_pattern` or `apply_preset` through `call_endpoint` (section 9) |
| Their Mermaid source rendered | `generate_diagram` (routes itself, see section 10) |
| Small edits to an existing model | `find_elements`, then `update_element`; deletions as a `/delete_element` op in a `batch` |
| Many related creations or edits | one `batch` |
| To read or explain a diagram | `diagram_as_text` (section 13), not a picture |
| The `type` or command id to pass | `search_types` through `call_endpoint` |
| To check a model | `uml_lint` and `validate_model` through `call_endpoint` (section 5) |
| A diagram that reads badly, or one look for every diagram | `diagram_quality`, then `improve_diagram`; the style profile (section 6) |
| To see what a build would change | `build_diagram` with `dryRun: true`, or `diff_diagram` |
| Project metadata, preferences, templates, fragments, XMI | `call_endpoint` (section 14) |
| Anything else StarUML can do | `describe_endpoints`, then `call_endpoint` |
| To see a diagram | `view_diagram`; `export_diagram` for files |

A user may also start the server's prompts `model-codebase` (reverse-engineer a source directory
or build class diagrams from a description), `review-diagram`, `improve-diagram` (the quality
loop of section 6) and `apply-pattern` (section 9); they spell out the same calls.

### Ids and paths

Every field that takes an element (`ref`, `refs`, `diagram`, `diagrams`, `tail`, `head`,
`parent`, `container`, `views`, `models`, `scope`) takes its `_id` or a path, so there is rarely a
need to look an id up first:

| Path | Names |
|---|---|
| `Model/Shop/Order`, `Shop/Order`, `Order` | owners from the project down, or the trailing steps when only one element ends so |
| `Order.total` | a member: attribute, literal, column, slot, parameter |
| `Order#pay()`, `Order#pay(int, String)` | an operation; the types pick an overload |
| `Main` | a diagram by name |
| `Order@Main` | the view of `Order` on diagram `Main` |
| `@current`, `@project` | the diagram open in StarUML; the project |

A `\` escapes `/ . # @ ( ) ,` inside a name. Element results carry the `path` each element
resolves by. A path that fits several elements is refused as `AMBIGUOUS_REF` with the candidates'
ids and paths; pass one of those or a longer path. Use paths for what already exists and `$name`
references (section 11) for what a batch creates.

## 3. build_diagram: one spec per kind

`kind` is required with `spec`. Nodes are named by `name`; edges refer to nodes by name, or by
`id` where a node has one. `\n` or `<br/>` in a name stores a line break (StarUML 7.1.1 draws it
on one line). The answer carries the diagram and what was created, updated or left unchanged;
`result: "ids"` adds the model and view id of every node, keyed by name, and `"full"` the edges'. `upsert: true` updates the diagram of the same name instead of adding a second one;
it adds what is missing, and deletes what the spec lacks only with `prune: true`. A class,
interface, enum, package, actor, use case or entity named like one elsewhere in the project is
that element shown again, not a copy (`reuse`, default true). `direction` is `TB` (default), `BT`, `LR` or `RL`;
`layout` picks a preset (`flow-down`, `flow-right`, `hierarchy-down`, ...: flow puts an edge's
source first, hierarchy its target, as superclasses above subclasses), by default hierarchy for
class diagrams and flow for the rest.

**class**: `classes[{name, kind: class|interface|enum|abstract, package, stereotype,
attributes, operations, literals}]`, `relations[{from, to, type, name, fromMultiplicity,
toMultiplicity}]`; relation types association, directed, aggregation, composition,
generalization, realization, dependency. Members are UML strings or objects.

```json build_diagram
{
  "kind": "class",
  "name": "Ordering",
  "spec": {
    "classes": [
      { "name": "Order", "attributes": ["+id: long", "+total: double"], "operations": ["+place(): void"] },
      { "name": "Customer", "attributes": ["+name: String"] },
      { "name": "Payable", "kind": "interface", "operations": ["+pay(amount: double): boolean"] }
    ],
    "relations": [
      { "from": "Customer", "to": "Order", "type": "association", "fromMultiplicity": "1", "toMultiplicity": "0..*" },
      { "from": "Order", "to": "Payable", "type": "realization" }
    ]
  }
}
```

**sequence**: `participants` (names, or `{name, kind: participant|actor}`),
`messages[{from, to, text, kind: sync|async|reply|create|delete}]`, `fragments[{operator, guard,
operands, from, to}]` where `from`/`to` are message indices and `operands` the guards of further
operands (`["else"]` for an alt).

```json build_diagram
{
  "kind": "sequence",
  "name": "Checkout",
  "spec": {
    "participants": [{ "name": "Customer", "kind": "actor" }, "Shop", "Bank"],
    "messages": [
      { "from": "Customer", "to": "Shop", "text": "checkout()" },
      { "from": "Shop", "to": "Bank", "text": "charge(total)" },
      { "from": "Bank", "to": "Shop", "text": "approved", "kind": "reply" }
    ],
    "fragments": [{ "operator": "opt", "guard": "total > 0", "from": 1, "to": 2 }]
  }
}
```

**usecase**: `system` (boundary name), `actors`, `useCases`, `relations[{from, to, type:
association|include|extend|generalization}]`.

```json build_diagram
{
  "kind": "usecase",
  "name": "Library",
  "spec": {
    "system": "Library",
    "actors": ["Member", "Librarian"],
    "useCases": ["Borrow book", "Check membership"],
    "relations": [
      { "from": "Member", "to": "Borrow book" },
      { "from": "Borrow book", "to": "Check membership", "type": "include" },
      { "from": "Librarian", "to": "Check membership" }
    ]
  }
}
```

**activity**: `lanes`, `nodes[{id, name, type: action|initial|final|flowFinal|decision|merge|
fork|join|object, lane}]`, `flows[{from, to, guard}]`. Give pseudo-nodes an `id`.

```json build_diagram
{
  "kind": "activity",
  "name": "Return book",
  "spec": {
    "nodes": [
      { "id": "start", "type": "initial" },
      { "name": "Scan book" },
      { "id": "late", "type": "decision" },
      { "name": "Charge fee" },
      { "id": "end", "type": "final" }
    ],
    "flows": [
      { "from": "start", "to": "Scan book" },
      { "from": "Scan book", "to": "late" },
      { "from": "late", "to": "Charge fee", "guard": "overdue" },
      { "from": "late", "to": "end", "guard": "on time" },
      { "from": "Charge fee", "to": "end" }
    ]
  }
}
```

**statemachine**: `states` (names, or `{id, name, type: state|initial|final|choice|fork|join}`),
`transitions[{from, to, trigger, guard, effect}]`.

```json build_diagram
{
  "kind": "statemachine",
  "name": "Order states",
  "spec": {
    "states": [{ "id": "init", "type": "initial" }, "Open", "Paid", { "id": "done", "type": "final" }],
    "transitions": [
      { "from": "init", "to": "Open" },
      { "from": "Open", "to": "Paid", "trigger": "pay", "guard": "total > 0" },
      { "from": "Paid", "to": "done", "trigger": "ship", "effect": "notify()" }
    ]
  }
}
```

**erd**: `entities[{name, columns}]` with columns as `"name type PK|FK"` strings or `{name, type,
length, primaryKey, foreignKey, nullable, unique}`, `relationships[{from, to, name,
fromCardinality, toCardinality, identifying}]`; cardinalities `0..1`, `1`, `0..*`, `1..*`.

```json build_diagram
{
  "kind": "erd",
  "name": "Shop schema",
  "spec": {
    "entities": [
      { "name": "customer", "columns": ["id int PK", "email varchar"] },
      { "name": "orders", "columns": ["id int PK", "customer_id int FK", { "name": "total", "type": "decimal", "nullable": false }] }
    ],
    "relationships": [{ "from": "customer", "to": "orders", "fromCardinality": "1", "toCardinality": "0..*" }]
  }
}
```

**flowchart**: `nodes` (names, or `{id, name, shape}`; shapes process, decision, terminator, data,
document, predefined, alternate, database, manualInput, preparation, connector, delay, display),
`flows[{from, to, label}]`.

```json build_diagram
{
  "kind": "flowchart",
  "name": "Login",
  "direction": "LR",
  "spec": {
    "nodes": [
      { "id": "start", "name": "Start", "shape": "terminator" },
      { "id": "ok", "name": "Password valid?", "shape": "decision" },
      "Open session",
      "Show error"
    ],
    "flows": [
      { "from": "start", "to": "ok" },
      { "from": "ok", "to": "Open session", "label": "yes" },
      { "from": "ok", "to": "Show error", "label": "no" }
    ]
  }
}
```

**mindmap**: `root{name, children[...]}`, nested to any depth.

```json build_diagram
{
  "kind": "mindmap",
  "name": "Release plan",
  "spec": {
    "root": {
      "name": "Release 2.0",
      "children": [{ "name": "Viewer", "children": [{ "name": "Dark mode" }] }, { "name": "Docs" }]
    }
  }
}
```

The full grammar with every optional field, the `requirement`, `c4`, `package`, `component` and
`deployment` kinds, and `text` with
`format` for PlantUML, SQL DDL or JSON Schema sources: `describe_endpoints({names:
["build_diagram"]})`. The sixteen other kinds share one shape, next.

## 4. Diagram families

Sixteen more kinds share one spec: `nodes[{name, id, type, in, stereotype, documentation,
properties, attributes, operations, slots, width, height}]` and `edges[{from, to, type,
name}]`. `type` picks a node or edge of the family's palette, and a node or edge without one
gets the family's default, named first below. `in` puts a node inside another: a part in its
class, a lane in its pool, a control in its frame, a service in its VPC. `attributes` and
`operations` are UML strings as on a class diagram, `slots` are `"name = value"`, `properties`
sets any attribute of the model (`{"id": "1"}` on a DFD process, `{"checked": true}` on a
checkbox). Edges name nodes by name, or by `id` where a node has one; `\n` breaks a name as
elsewhere.

### composite (UML composite structure)

Nodes `class` (default), `part`, `port`, `interface`, `collaboration`, `collaborationUse`; edges
`connector` (default), `association`, `dependency`, `realization`, `roleBinding`,
`generalization`. Parts and ports go `in` their class.

```json build_diagram
{
  "kind": "composite",
  "name": "Pump structure",
  "spec": {
    "nodes": [
      { "name": "Pump", "attributes": ["+ratedFlow: Real"] },
      { "name": "impeller", "type": "part", "in": "Pump" },
      { "name": "motor", "type": "part", "in": "Pump" },
      { "name": "inlet", "type": "port", "in": "Pump" }
    ],
    "edges": [{ "from": "motor", "to": "impeller", "name": "drives" }]
  }
}
```

### object (UML object)

Nodes `object` (default), `class`, `componentInstance`, `nodeInstance`, `artifactInstance`, with
`slots`; edges `link` (default), `directedLink`, `dependency`.

```json build_diagram
{
  "kind": "object",
  "name": "Order snapshot",
  "spec": {
    "nodes": [{ "name": "order1", "slots": ["total = 42", "status = PAID"] }, { "name": "alice" }, { "name": "item7" }],
    "edges": [
      { "from": "order1", "to": "alice", "name": "placedBy" },
      { "from": "order1", "to": "item7", "type": "directedLink" }
    ]
  }
}
```

### communication (UML communication)

Nodes `lifeline`; edges `message` (default), numbered in order and drawn along the `connector`
between the two lifelines, which is made once for all messages between them. Nodes may be plain
names.

```json build_diagram
{
  "kind": "communication",
  "name": "Checkout talk",
  "spec": {
    "nodes": ["client", "server", "db"],
    "edges": [
      { "from": "client", "to": "server", "name": "checkout()" },
      { "from": "server", "to": "db", "name": "save(order)" },
      { "from": "server", "to": "client", "name": "done" }
    ]
  }
}
```

### timing (UML timing)

Nodes `lifeline` (default), `state` in a lifeline, `segment` in a state, whose `width` is its
duration; edges `message` between segments. Give states an `id` when two lifelines share a state
name.

```json build_diagram
{
  "kind": "timing",
  "name": "Request timing",
  "spec": {
    "nodes": [
      { "name": "client" },
      { "id": "client.idle", "name": "idle", "type": "state", "in": "client" },
      { "id": "client.waiting", "name": "waiting", "type": "state", "in": "client" },
      { "id": "c1", "name": "t1", "type": "segment", "in": "client.idle", "width": 120 },
      { "id": "c2", "name": "t2", "type": "segment", "in": "client.waiting", "width": 200 },
      { "name": "server" },
      { "id": "server.busy", "name": "busy", "type": "state", "in": "server" },
      { "id": "s1", "name": "t3", "type": "segment", "in": "server.busy", "width": 160 }
    ],
    "edges": [{ "from": "c1", "to": "s1", "name": "request" }]
  }
}
```

### overview (UML interaction overview)

Nodes `interactionUse` (default), `interaction`, `initial`, `final`, `decision`, `merge`,
`fork`, `join`; edges `flow`, whose `name` is the guard.

```json build_diagram
{
  "kind": "overview",
  "name": "Shopping overview",
  "spec": {
    "nodes": [
      { "id": "start", "type": "initial" },
      { "name": "Log in" },
      { "id": "ok", "type": "decision" },
      { "name": "Browse", "type": "interaction" },
      { "id": "end", "type": "final" }
    ],
    "edges": [
      { "from": "start", "to": "Log in" },
      { "from": "Log in", "to": "ok" },
      { "from": "ok", "to": "Browse", "name": "[ok]" },
      { "from": "ok", "to": "end", "name": "[failed]" },
      { "from": "Browse", "to": "end" }
    ]
  }
}
```

### infoflow (UML information flow)

Nodes `class` (default), `actor`, `useCase`, `item` (an information item); edges `flow`
(default), `dependency`, `association`.

```json build_diagram
{
  "kind": "infoflow",
  "name": "Billing information",
  "spec": {
    "nodes": [{ "name": "Accounts" }, { "name": "Payer", "type": "actor" }, { "name": "Invoice data", "type": "item" }],
    "edges": [{ "from": "Accounts", "to": "Payer", "name": "invoices" }]
  }
}
```

### profile (UML profile)

Nodes `stereotype` (default, with `attributes` as tag definitions), `metaclass`, `enumeration`;
edges `extension` (default) from a stereotype to the metaclass it extends, `generalization`.

```json build_diagram
{
  "kind": "profile",
  "name": "Persistence profile",
  "spec": {
    "nodes": [
      { "name": "Table", "attributes": ["schema: String"] },
      { "name": "Key" },
      { "name": "Class", "type": "metaclass" },
      { "name": "Property", "type": "metaclass" }
    ],
    "edges": [{ "from": "Table", "to": "Class" }, { "from": "Key", "to": "Property" }]
  }
}
```

### dfd (data flow, Gane-Sarson)

Nodes `process` (default), `external`, `store`; edges `flow`. `properties.id` numbers a process
or a store.

```json build_diagram
{
  "kind": "dfd",
  "name": "Order processing",
  "spec": {
    "nodes": [
      { "name": "Customer", "type": "external", "documentation": "Places and receives orders." },
      { "name": "Place order", "properties": { "id": "1" } },
      { "name": "Ship order", "properties": { "id": "2" } },
      { "name": "Orders", "type": "store", "properties": { "id": "D1" } }
    ],
    "edges": [
      { "from": "Customer", "to": "Place order", "name": "order" },
      { "from": "Place order", "to": "Orders", "name": "order record" },
      { "from": "Orders", "to": "Ship order", "name": "pending order" },
      { "from": "Ship order", "to": "Customer", "name": "parcel" }
    ]
  }
}
```

### bdd (SysML block definition)

Nodes `block` (default), `valueType`, `interfaceBlock`, `constraintBlock`, `enumeration`,
`signal`, `stakeholder`, `viewpoint`, `view`; edges `composition` (default, `from` is the whole),
`association`, `directed`, `aggregation`, `generalization`, `dependency`, `realization`,
`conform`, `expose`.

```json build_diagram
{
  "kind": "bdd",
  "name": "Vehicle blocks",
  "spec": {
    "nodes": [
      { "name": "Vehicle", "attributes": ["mass: Kilogram"], "operations": ["accelerate(by: Real)"] },
      { "name": "Car", "stereotype": "system" },
      { "name": "Engine" },
      { "name": "Wheel" },
      { "name": "Kilogram", "type": "valueType" },
      { "name": "Newton", "type": "constraintBlock" }
    ],
    "edges": [
      { "from": "Car", "to": "Vehicle", "type": "generalization" },
      { "from": "Car", "to": "Engine" },
      { "from": "Car", "to": "Wheel" }
    ]
  }
}
```

### ibd (SysML internal block)

The inside of one block, `spec.block` (an existing block by name or path, or a new one). Nodes
`part` (default), `reference`, `value`, `port`; edges `connector`.

```json build_diagram
{
  "kind": "ibd",
  "name": "Car internals",
  "spec": {
    "block": "Car",
    "nodes": [{ "name": "engine" }, { "name": "gearbox" }, { "name": "wheels" }, { "name": "fuel", "type": "port" }],
    "edges": [{ "from": "fuel", "to": "engine" }, { "from": "engine", "to": "gearbox" }, { "from": "gearbox", "to": "wheels" }]
  }
}
```

### parametric (SysML parametric)

The constraints of `spec.block`. Nodes `constraint` (default), `parameter`, `value`, `part`;
edges `connector` binding a value to a constraint.

```json build_diagram
{
  "kind": "parametric",
  "name": "Car dynamics",
  "spec": {
    "block": "Car",
    "nodes": [{ "name": "newton" }, { "name": "mass", "type": "value" }, { "name": "acceleration", "type": "value" }],
    "edges": [{ "from": "newton", "to": "mass" }, { "from": "newton", "to": "acceleration" }]
  }
}
```

### bpmn (BPMN process)

Nodes `task` (default), `userTask`, `serviceTask`, `sendTask`, `receiveTask`, `manualTask`,
`scriptTask`, `businessRuleTask`, `callActivity`, `subProcess`, events `start`, `end`, `throw`,
`catch`, gateways `exclusive`, `parallel`, `inclusive`, `eventBased`, `complex`, and `pool`,
`lane`, `dataObject`, `dataStore`, `annotation`; edges `sequence` (default), `message`,
`association`, `data`. Lanes go `in` a pool, flow nodes `in` a lane.

```json build_diagram
{
  "kind": "bpmn",
  "name": "Order fulfilment",
  "spec": {
    "nodes": [
      { "name": "Shop", "type": "pool" },
      { "name": "Sales", "type": "lane", "in": "Shop" },
      { "name": "Warehouse", "type": "lane", "in": "Shop" },
      { "name": "Order received", "type": "start", "in": "Sales" },
      { "name": "Check order", "type": "userTask", "in": "Sales" },
      { "id": "ok", "name": "In stock?", "type": "exclusive", "in": "Sales" },
      { "name": "Pack", "in": "Warehouse" },
      { "name": "Done", "type": "end", "in": "Warehouse" }
    ],
    "edges": [
      { "from": "Order received", "to": "Check order" },
      { "from": "Check order", "to": "ok" },
      { "from": "ok", "to": "Pack", "name": "yes" },
      { "from": "Pack", "to": "Done" }
    ]
  }
}
```

### wireframe

Frames `frame` (default), `webFrame`, `mobileFrame`, `desktopFrame`, holding `panel` and the
controls `button`, `text`, `input`, `dropdown`, `checkbox`, `radio`, `switch`, `link`, `tabList`,
`tab`, `image`, `separator`, `avatar`, `slider`, stacked top to bottom in spec order. No edges.

```json build_diagram
{
  "kind": "wireframe",
  "name": "Login screen",
  "spec": {
    "nodes": [
      { "name": "Login", "type": "webFrame" },
      { "name": "Email", "type": "input", "in": "Login" },
      { "name": "Password", "type": "input", "in": "Login" },
      { "name": "Remember me", "type": "checkbox", "in": "Login", "properties": { "checked": true } },
      { "name": "Sign in", "type": "button", "in": "Login" }
    ]
  }
}
```

### aws, azure, gcp (cloud architecture)

aws: nodes `service` (default), `resource`, `generalResource`, `group` (cloud, VPC, subnet),
`genericGroup`, `availabilityZone`, `securityGroup`, `callout`; edges `arrow`. azure: nodes
`service` (default), `group`, `callout`; edges `connector` (`properties: {"dashed": true}`).
gcp: nodes `product` (default), `service`, `zone` (project, region), `user`; edges `path`.
Services go `in` their group or zone.

```json build_diagram
{
  "kind": "aws",
  "name": "Web tier",
  "spec": {
    "nodes": [
      { "name": "AWS Cloud", "type": "group" },
      { "name": "VPC", "type": "group", "in": "AWS Cloud" },
      { "name": "Load balancer", "in": "VPC" },
      { "name": "Web server", "in": "VPC" },
      { "name": "Database", "type": "resource", "in": "VPC" }
    ],
    "edges": [{ "from": "Load balancer", "to": "Web server" }, { "from": "Web server", "to": "Database" }]
  }
}
```

```json build_diagram
{
  "kind": "azure",
  "name": "App platform",
  "spec": {
    "nodes": [
      { "name": "Resource group", "type": "group" },
      { "name": "App Service", "in": "Resource group" },
      { "name": "SQL Database", "in": "Resource group" }
    ],
    "edges": [{ "from": "App Service", "to": "SQL Database", "properties": { "dashed": true } }]
  }
}
```

```json build_diagram
{
  "kind": "gcp",
  "name": "Serverless app",
  "spec": {
    "nodes": [
      { "name": "User", "type": "user" },
      { "name": "Project", "type": "zone" },
      { "name": "Cloud Run", "in": "Project" },
      { "name": "Cloud SQL", "type": "service", "in": "Project" }
    ],
    "edges": [{ "from": "User", "to": "Cloud Run" }, { "from": "Cloud Run", "to": "Cloud SQL" }]
  }
}
```

None of these has a Mermaid or PlantUML form, so `diagram_as_text` reads them back as their
spec with `format: "spec"`, on one line:

```json diagram_as_text
{ "diagram": "Order processing", "format": "spec" }
```

The spec holds the names, types, nesting, members, slots and edges, not `documentation` or
`properties`; `build_diagram` with the same `kind` builds the diagram again from it. To change a
diagram, edit the spec and pass it with `upsert: true`, which adds what is new. For composite,
communication, timing and overview diagrams an upsert adds parts, messages, timing states and
segments, and unnamed control nodes again instead of matching them: change those diagrams with
`update_element` or rebuild them under a new name. A composite structure's class also lists its
parts and ports among its `attributes`; drop those before building from it.

## 5. The build loop and drawing good UML

Draw every diagram in this loop:

1. **Plan**: `build_diagram` with `dryRun: true` changes nothing and answers the plan, the
   paths it would create, update and delete. Check the names and that `reuse` found the existing
   elements you meant.
2. **Build**: the same call without `dryRun` (with `upsert: true` once the diagram exists).
3. **Score**: the build already ran the quality loop; its answer's `quality: {score, target}`
   says how the picture reads. Below target, `improve_diagram` lays the diagram out again by the
   style profile and applies the lint autofixes (stacked or overlapping nodes, edges through
   nodes, names wider than their box), keeping each step only when the score rises (section 6).
   `uml_lint` (through `call_endpoint`) lists modelling mistakes, each with a `fix` line; apply
   those with a `build_diagram` upsert or `update_element`.
4. **Look**: `view_diagram` once, or `diagram_as_text` when the content is what matters.

Take a `snapshot` before a larger change: `diff_since` lists what changed since, and
`restore_snapshot` undoes all of it in one step.

```json build_diagram
{
  "kind": "class",
  "name": "Ordering",
  "dryRun": true,
  "upsert": true,
  "spec": {
    "classes": [{ "name": "Order" }, { "name": "Invoice", "attributes": ["+number: String"] }],
    "relations": [{ "from": "Order", "to": "Invoice", "type": "directed", "fromMultiplicity": "1", "toMultiplicity": "0..1" }]
  }
}
```

```json improve_diagram
{ "ref": "Ordering" }
```

```json call_endpoint
{ "name": "uml_lint", "body": { "rules": { "naming": "info" } } }
```

What a diagram needs to read well:

- **One concern per diagram**, about 5 to 15 nodes. Split when it passes 20, when two clusters
  share a single edge, or when a reader needs two questions answered; one diagram per package
  for a larger model.
- **Names**: classifiers are singular nouns in PascalCase, attributes nouns and operations verbs
  in camelCase, enumeration literals UPPER_CASE (`uml_lint` U012). Use the domain's words, the
  same word for the same thing on every diagram.
- **Direction and layering**: superclasses above subclasses (the class default,
  `hierarchy-down`); dependencies run one way, from user interface through services to the
  domain and persistence, top to bottom or left to right; `LR` for pipelines and long flows.
- **Grouping**: give classes a `package`; put what changes together in one package and draw
  packages on an overview.
- **Class diagrams**: a multiplicity on both ends of every association (U001); `directed` when
  only one side knows the other (U002); `composition` when parts live and die with the whole,
  `aggregation` for a shared part, `from` being the whole that gets the diamond; `generalization`
  for is-a, `realization` for an interface; typed attributes (U003); an abstract class needs a
  subclass (U005) and an interface a realizer (U006); show only the members the concern needs.
- **Sequence diagrams**: one scenario; participants left to right in order of first use; every
  message names an operation of its receiver (U007); replies as `kind: "reply"`; `alt`, `opt` and
  `loop` fragments instead of conditions in message text.
- **Use case diagrams**: actors outside the `system` boundary; use cases as verb phrases; every
  use case has an actor (U008); `include` for a step always shared, `extend` for an optional one;
  no ordering, which belongs on an activity diagram.
- **State machines**: one initial (U009) and at least one final state (U010); states named as
  conditions (`Paid`), transitions as `trigger [guard] / effect`.
- **ER diagrams**: a primary key on every entity (U011), foreign keys marked `FK` with a
  relationship giving both cardinalities, one naming style for tables and columns.

## 6. Consistent, good-looking diagrams

The project's style profile holds every convention a diagram follows: naming rules, colours,
fonts and edge style, the layout preset per kind, the element limit per diagram and the quality
target. Every authoring call (`build_diagram`, `build_model`, `apply_pattern`,
`derive_diagrams`) applies it and runs the quality loop, so diagrams look alike without being
told to.

- **Set the profile once**, at the start of a project: a built-in (`uml-standard`, the default;
  `minimal`, `presentation`, `print`) or a patch of the current one. It is stored in the `.mdj`.
  `apply_style_profile` brings what the project (or a `scope`) already has in line, with a dry
  run first.
- **Let the engine lay out.** Name what a diagram shows and leave positions, sizes and colours to
  the build. Never pass coordinates or call `move_views`, `resize_node` or `set_view_style`
  unless the user asks for that placement; a `strict` profile refuses them with `STYLE_LOCKED`,
  and `override: true` is for a change the user asked for, not a way around the profile.
- **Read `quality` and iterate.** Every build answers `quality: {score, target, iterations,
  findings}`; `diagram_quality` scores an existing diagram and its `penalties` say what costs
  points. Below target, `improve_diagram`, then `view_diagram`.
- **Split big diagrams.** More nodes than the profile's `maxElements` (30) never score well:
  split by package or concern, one diagram each, before improving further.
- `explain_style_violation` says which rule a name breaks before you create it; with
  `blockSaveOnErrors` in the profile, saving and exporting answer `SAVE_BLOCKED` until
  `uml_lint` and `model_lint` report no errors.

```json call_endpoint
{ "name": "set_style_profile", "body": { "profile": "uml-standard" } }
```

```json call_endpoint
{ "name": "apply_style_profile", "body": { "dryRun": true } }
```

```json diagram_quality
{ "ref": "Ordering" }
```

```json call_endpoint
{ "name": "explain_style_violation", "body": { "kind": "classifier", "name": "order_line" } }
```

## 7. Model first

When the user describes a domain, requirements or a system rather than a picture, build the
model first and draw diagrams of it afterwards. `build_model` makes the packages, classes,
members and relationships of one model from an object-level spec in one undo step, without any
diagram; `build_diagram` then shows those same elements (its `reuse` finds them by name) on as
many diagrams as the concerns need.

Write the spec as the domain talks:

- `contexts` are the packages (bounded contexts), each with an `id` classes refer to.
- `classes[{name, context, kind: class|abstract|interface|enum, responsibility, knows, does,
  collaboratesWith, attributes, operations, literals}]`. The `responsibility` (and `knows`,
  `does`) becomes the class's documentation, so write one sentence of what it is for;
  attributes and operations are UML strings such as `"+due: Date"`, `"+renew(days: int): void"`.
- `relationships[{from, to, type, fromMult, toMult}]` take a verb, and the verb decides the UML
  relationship and which end is which:

| `type` | UML | `from` is |
|---|---|---|
| `owns` | composition | the whole; the part lives and dies with it |
| `has` | aggregation | the whole of a shared part |
| `uses` | dependency | the client |
| `isA` | generalization | the specific kind |
| `implements` | interface realization | the implementing class |
| `knows` | directed association | the side that navigates |
| `association` | plain association | either side |

- `actors` and `useCases`, `collaborations` (each an interaction with lifelines and messages)
  and `lifecycles` (state machines) complete it; diagram sections are listed in `skipped`, for
  `build_diagram`.

Run it with `dryRun: true` first: the answer names every element and relationship it would make
by path, and changes nothing. `upsert: true` extends the model of the same name later and never
removes anything.

```json build_model
{
  "spec": {
    "system": "Lending",
    "contexts": [{ "id": "loans", "name": "Loans", "responsibility": "Who borrowed which copy, until when" }],
    "classes": [
      { "name": "Member", "context": "loans", "responsibility": "A person allowed to borrow", "attributes": ["+name: String"] },
      { "name": "Loan", "context": "loans", "responsibility": "One copy lent to one member until a due date", "attributes": ["+due: Date"], "operations": ["+renew(days: int): void"] },
      { "name": "Copy", "context": "loans", "responsibility": "A physical book on the shelf" },
      { "name": "Fine", "context": "loans", "responsibility": "What a late return costs", "operations": ["+amount(): double"] }
    ],
    "relationships": [
      { "from": "Member", "to": "Loan", "type": "owns", "fromMult": "1", "toMult": "0..*" },
      { "from": "Loan", "to": "Copy", "type": "knows", "toMult": "1" },
      { "from": "Loan", "to": "Fine", "type": "has", "toMult": "0..1" }
    ]
  }
}
```

Then a `build_diagram` class spec that names `Member`, `Loan`, `Copy` and `Fine` shows these
elements rather than copies. For a collaboration drawn as a sequence diagram,
`call_endpoint({name: "check_messages", body: {diagram}})` lists the messages that name no
operation of their receiver, and `sync_operations` adds those operations to the classes.

## 8. Object-first, never draw

When the server runs with `--tools oo` (or after `doctor({tools: "oo"})`), it lists only the
model-first tools: `build_model`, `derive_diagrams`, `explain_model`, `model_lint`,
`apply_pattern`, `detect_patterns`, `validate_model`, `diagram_quality`, `view_diagram`,
`diagram_as_text`, `doctor` and the two generic ones. Nothing in that tier places, sizes or
colours a view: `call_endpoint` answers `NOT_IN_TIER` for `build_diagram`, `move_views`,
`batch` and the like. Before its first change the tier makes the project's style profile strict,
so the extension refuses them too, and `override` is not part of the tier. The work is stating the
domain; the diagrams follow from it.

The tier is the user's choice when the server starts. `doctor({tools})` can narrow it but not
widen it: asking for `core` or a drawing tool answers `TIER_LOCKED` unless the user started the
server with `--allow-tier-switch`. A `NOT_IN_TIER` refusal therefore means "change the model":
edit the spec or the model and run `derive_diagrams` or `improve_diagram` again. If the user wants
a hand-drawn diagram, say that it needs a server started with another tier.

1. **Explain the domain back** in a few sentences: contexts, classes with one responsibility
   each, how they relate (section 7's verbs), actors and use cases, the collaborations worth a
   sequence diagram, the lifecycles worth a state machine.
2. **Write it as one spec** and check it with `dryRun: true`.
3. **Build** it: `build_model` makes the model in one undo step.
4. **Derive**: `derive_diagrams` draws every diagram the model implies by rule (a package
   overview, class diagrams per context or `classViews`, a sequence diagram per collaboration,
   use case diagrams, a state machine per lifecycle, and the activities, ERD, C4, deployment and
   mind map sections), each laid out by the style profile and run through the quality loop. The
   answer lists each diagram's name and score; `quality.failing` names any below target.
5. **Look and review**: `view_diagram` on the diagrams that matter, `explain_model` for the
   whole model as text, `model_lint` for the design (god classes, feature envy, package cycles,
   anaemic entities, ...).
6. **Iterate through the spec**: fix it, `build_model` with `upsert: true`, `derive_diagrams`
   again. Both update in place; the same spec and profile give the same diagrams, so a second
   derive of an unchanged model changes nothing.

A complete example, a clinic's scheduling and billing:

```json build_model oo
{
  "spec": {
    "system": "Clinic",
    "contexts": [
      {"id": "scheduling", "name": "scheduling", "responsibility": "Who sees whom, and when"},
      {"id": "billing", "name": "billing", "responsibility": "What a visit costs", "dependsOn": ["scheduling"]}
    ],
    "classes": [
      {"name": "Patient", "context": "scheduling", "responsibility": "A person who books visits", "attributes": ["+name: String"]},
      {"name": "Doctor", "context": "scheduling", "responsibility": "Sees patients in free slots", "attributes": ["+specialty: String"], "operations": ["+isFree(at: DateTime): boolean"]},
      {"name": "Appointment", "context": "scheduling", "responsibility": "One patient with one doctor at one time", "attributes": ["+at: DateTime"], "operations": ["+confirm(): void", "+cancel(): void"]},
      {"name": "Schedule", "context": "scheduling", "responsibility": "Books appointments into free slots", "operations": ["+book(patient: Patient, doctor: Doctor, at: DateTime): Appointment"]},
      {"name": "Invoice", "context": "billing", "responsibility": "What one appointment costs", "attributes": ["+amount: double"], "operations": ["+pay(): void"]}
    ],
    "relationships": [
      {"from": "Schedule", "to": "Appointment", "type": "owns", "fromMult": "1", "toMult": "0..*"},
      {"from": "Appointment", "to": "Patient", "type": "knows", "toMult": "1"},
      {"from": "Appointment", "to": "Doctor", "type": "knows", "toMult": "1"},
      {"from": "Invoice", "to": "Appointment", "type": "knows", "toMult": "1"}
    ],
    "actors": ["Receptionist"],
    "useCases": [
      {"name": "Book appointment", "system": "Clinic", "actors": ["Receptionist"]},
      {"name": "Cancel appointment", "system": "Clinic", "actors": ["Receptionist"]}
    ],
    "collaborations": [
      {
        "name": "Booking",
        "context": "scheduling",
        "participants": [{"name": "Receptionist", "kind": "actor"}, "Schedule", "Doctor", "Appointment"],
        "messages": [
          ["Receptionist", "Schedule", "book(patient, doctor, at)"],
          ["Schedule", "Doctor", "isFree(at)"],
          ["Schedule", "Appointment", "confirm()"]
        ]
      }
    ],
    "lifecycles": [
      {
        "name": "Appointment states",
        "subject": "Appointment",
        "states": [{"id": "start", "type": "initial"}, "Booked", "Confirmed", "Cancelled", {"id": "end", "type": "final"}],
        "transitions": [
          {"from": "start", "to": "Booked"},
          {"from": "Booked", "to": "Confirmed", "trigger": "confirm"},
          {"from": "Booked", "to": "Cancelled", "trigger": "cancel"},
          {"from": "Confirmed", "to": "end"},
          {"from": "Cancelled", "to": "end"}
        ]
      }
    ]
  }
}
```

```json derive_diagrams oo
{ "scope": "Clinic" }
```

```json model_lint oo
{ "scope": "Clinic" }
```

```json explain_model oo
{ "scope": "Clinic" }
```

That is two calls for five diagrams: the package overview, the class diagram of `scheduling`
and of `billing`, the `Booking` sequence diagram, the use case diagram and the `Appointment
states` state machine, every one a view of the model's own elements. `model_lint` points out
that nothing calls `Invoice#pay()` (M007); add a collaboration that does, or let it be.

## 9. Design patterns with correct properties

A pattern is more than its class shapes: Strategy wants the strategy's operation abstract, the
context's end of the association a shared aggregation that does not navigate, and the far end
navigable, named `strategy`, with multiplicity 1. `apply_pattern` sets every such property from
the pattern's data, on existing classes or new ones, in one undo step; writing the same by hand
in a `batch` takes a dozen ops and usually misses some. The default tools reach it through
`call_endpoint`; `doctor({tools: "core,apply_pattern"})` lists it as a tool, and the `oo` tier
lists it anyway.

1. Pick the pattern: `staruml://patterns` lists the 23 GoF patterns and Repository, Unit of
   Work, Specification, Value Object, Entity, Service and DTO with their intent and roles (`*`
   binds several elements, `?` is optional).
2. Read what it prescribes: `staruml://pattern/{name}` or `describe_pattern`.
3. Bind each role to an existing class by path (`Loans/Loan` names `Loan` in package `Loans`
   wherever that package is), a list for a `*` role; a name nothing resolves to
   becomes a new element of that name, and an unbound role gets one named after the role. New
   elements go into `parent` (default the diagram's owner, else the project's first model), so
   pass the package the bound classes live in.
4. Dry run, apply (with `diagram` to show it laid out), and confirm with `detect_patterns`:
   confidence 1 and nothing `missing` means every prescribed property is there. `uml_lint`
   rule U013 reports a detected pattern that breaks one of its rules later.

```json call_endpoint
{ "name": "describe_pattern", "body": { "name": "Strategy" } }
```

```json call_endpoint
{
  "name": "apply_pattern",
  "body": {
    "pattern": "Strategy",
    "bindings": { "Context": "Loans/Loan", "Strategy": "FinePolicy", "ConcreteStrategy": ["DailyFine", "FlatFine"] },
    "parent": "Lending/Loans",
    "dryRun": true
  }
}
```

```json call_endpoint
{
  "name": "apply_pattern",
  "body": {
    "pattern": "Strategy",
    "bindings": { "Context": "Loans/Loan", "Strategy": "FinePolicy", "ConcreteStrategy": ["DailyFine", "FlatFine"] },
    "parent": "Lending/Loans",
    "diagram": "Fine policy"
  }
}
```

```json call_endpoint
{ "name": "detect_patterns", "body": { "scope": "Lending", "patterns": ["Strategy"] } }
```

For one class rather than a pattern, `apply_preset` gives it the properties of a kind
(`interface`, `abstract`, `value-object`, `entity`, `enum`, `static-utility`, `immutable`):

```json call_endpoint
{ "name": "apply_preset", "body": { "ref": "Loans/Copy", "preset": "entity", "dryRun": true } }
```

`describe_type` explains what each property of a metamodel type means (`isLeaf`, `aggregation`,
`navigable`, ...), when a pattern or preset sets one you need to understand.

## 10. Mermaid

`build_diagram` reads `classDiagram`, `sequenceDiagram`, `flowchart`/`graph`, `erDiagram` and
`stateDiagram` and names the diagram from `name`, front matter `title:` or a `title` line. `kind`
reads a flowchart as an `activity` or `usecase` diagram:

```json build_diagram
{ "mermaid": "flowchart TD\n  A[Receive order] --> B{In stock?}\n  B -->|yes| C[Ship]\n  B -->|no| D[Back-order]", "kind": "activity", "name": "Fulfilment" }
```

`generate_diagram` takes any Mermaid StarUML's built-in importer reads, `mindmap` and
`requirementDiagram` included, and hands the call to `build_diagram` when it needs a name, a
kind, a title or line breaks, which the built-in importer cannot do:

```json generate_diagram
{ "code": "classDiagram\n  class Invoice\n  class Line\n  Invoice *-- Line" }
```

Prefer a spec when you write the diagram yourself; use Mermaid when the user already has it.

## 11. batch and `$name` references

`batch` runs endpoint calls in order as one undo step and, by default, rolls every op back when
one fails. `as` names an op's result; a later body refers to its id as `"$name"`, to a
`{view, model}` result's parts as `"$name.view"` and `"$name.model"`, to a nested field as
`"$name.path.0"`. Paths are endpoint paths, so any endpoint works here, listed as a tool or not.
The server checks every op's body and every reference before anything is sent. Each op answers
its success and the id it made or acted on; `result: "ids"` or `"full"` returns more.

```json batch
{
  "ops": [
    { "path": "/create_element", "body": { "type": "UMLModel", "parent": "@project", "name": "Billing" }, "as": "m" },
    { "path": "/create_diagram", "body": { "type": "UMLClassDiagram", "parent": "$m", "name": "Billing classes" }, "as": "d" },
    { "path": "/create_element_with_view", "body": { "type": "UMLClass", "parent": "$m", "diagram": "$d", "name": "Invoice", "x": 80, "y": 80 }, "as": "inv" },
    { "path": "/create_element_with_view", "body": { "type": "UMLClass", "parent": "$m", "diagram": "$d", "name": "Line", "x": 360, "y": 80 }, "as": "line" },
    { "path": "/add_attribute", "body": { "ref": "Billing/Invoice", "name": "total", "type": "double" } },
    { "path": "/create_edge_with_view", "body": { "type": "UMLAssociation", "diagram": "$d", "tail": "$inv.view", "head": "$line.view" } },
    { "path": "/update_element", "body": { "ref": "Billing/Line", "field": "isAbstract", "value": true } }
  ]
}
```

`atomic: false` runs every op and reports each result instead.

## 12. Endpoints without a tool

The default tool list is a core set. The other endpoints (project open/save, views, layout,
styles, undo/redo, commands, code generation, PDF/HTML export, deleting, patterns, and the
project features of section 14) are one step away:

```json describe_endpoints
{ "names": ["layout_diagram", "save_project"] }
```

`describe_endpoints({})` lists them all by group, one line each; `{group: "diagram"}` describes
a group in full. Then call one; its body is checked against the endpoint's schema first:

```json call_endpoint
{ "name": "get_project_info" }
```

Saving is `call_endpoint({name: "save_project", body: {filename: "/absolute/path/model.mdj"}})`.
If a session needs one endpoint often, `doctor({tools: "core,layout_diagram"})` lists it as a
tool, and `doctor({tools: "core"})` goes back.

## 13. Reading, viewing and exporting

Read a diagram as text. For a six-class diagram with members, Mermaid or a `describe_diagram`
summary (through `call_endpoint`) is about 270 tokens, a PNG about 1,600 (an estimate, billed as an image) and an element
dump with `summary: false` about 4,400.

```json diagram_as_text
{ "diagram": "Ordering" }
```

`diagram_as_text` writes a diagram (default the current one) as Mermaid, or as PlantUML with
`format: "plantuml"`, or as its `build_diagram` spec with `format: "spec"` for the families of
section 4, then a line with its `kind` and any `warnings` about what the text cannot
carry. The Mermaid is the form `build_diagram` reads back: edit it and pass it as `mermaid`, with
`kind` for use case and activity diagrams, to rebuild. `describe_diagram` lists the
nodes with their members and the edges as `"tail" -[Type "name"]-> "head"`, without
multiplicities or composition; `staruml://diagram/{id}.mmd` and `.puml` serve the text as
resources.

```json call_endpoint
{ "name": "search_types", "body": { "query": "composition", "limit": 3 } }
```

`search_types` finds the metamodel type, palette item, relationship kind or command id for a
word, each with an example request body; use it instead of guessing a `type`.

```json call_endpoint
{ "name": "validate_model" }
```

`validate_model` runs StarUML's validation rules over the project, or `scope` (an element and
what it owns), and lists each problem with its element and rule id.

```json find_elements
{ "type": "UMLClass", "name": "Invoice", "fields": ["name", "attributes"], "depth": 1 }
```

```json view_diagram
{}
```

`view_diagram` shows the current diagram (or `diagram`): an interactive SVG viewer with pan, zoom and
dark mode in clients that render MCP Apps, a PNG image elsewhere, no wider than the style
profile's page (1,600 px by default; `maxWidth: 0` for full size). Use it to check a layout
after building. With `path` (an absolute `.png`, `.jpg` or `.svg` file) it writes the image there
and answers only the path and size; do that when looking at many diagrams, or when the user
wants the picture:

```json view_diagram
{ "diagram": "Ordering", "path": "/tmp/ordering.png" }
```
 `annotate: "paths"` labels every view with its element's path on the picture, so
what you see can be named in the next call:

```json view_diagram
{ "diagram": "Ordering", "annotate": "paths" }
```

```json export_diagram
{ "format": "png", "scale": 2 }
```

`export_diagram` returns PNG or JPEG as an image and SVG as text; with `path` it writes the file
and returns only its size, which is what to do for anything the user wants on disk.

## 14. The project: finding, preferences, templates, fragments

`quick_find` finds elements whose name, documentation or tag values contain a text, in any case,
as Edit > Find does; each match names the element with its path, the field that matched and the
text around it. Use it when the user names something loosely; `find_elements` wants a type or
the exact name.

```json quick_find
{ "text": "invoice" }
```

The rest are one `call_endpoint` away, in the `project`, `io` and `perf` groups of
`describe_endpoints`:

**Metadata**: `get_project_metadata` and `set_project_metadata` read and set the project's
name, author, company, copyright, version and documentation, as one undo step.

```json call_endpoint
{ "name": "set_project_metadata", "body": { "author": "Modelling team", "version": "1.2" } }
```

**Preferences** (File > Preferences): `get_preference` answers a key's value, default, type and
whether it may be changed; `set_preference` changes view, editor, theme, validation and each
diagram extension's defaults (`uml.*`, `bpmn.*`, `c4.*`, ...) for what is drawn next. Who may
call the server is not changeable here, and the access token is never answered.

```json call_endpoint
{ "name": "get_preference", "body": { "key": "diagramEditor.showGrid" } }
```

**Templates**: `list_templates` names the File > New From Template projects (`UMLConventional`,
`C4Model`, `BusinessProcessModel`, `WireframeModel`, ...); `new_from_template` replaces the open
project with one, unsaved changes lost, so save first.

```json call_endpoint
{ "name": "list_templates" }
```

**Editor tabs**: `list_working_diagrams` lists the open diagram tabs and which is current;
`close_diagrams` closes the named ones, or every one but `keep`. The diagrams stay in the model.

```json call_endpoint
{ "name": "close_diagrams", "body": { "keep": ["Ordering"] } }
```

**Fragments**: `export_fragment` writes an element and everything it owns to a `.mfj` file and
`import_fragment` reads one into any project, under `parent` (default the project). Undo skips
the import (StarUML records it that way); delete the imported element to take it out.

```json call_endpoint
{ "name": "export_fragment", "body": { "ref": "Billing", "filename": "/tmp/billing.mfj" } }
```

```json call_endpoint
{ "name": "import_fragment", "body": { "filename": "/tmp/billing.mfj", "parent": "@project" } }
```

**XMI**: `export_xmi` and `import_xmi` go through the staruml-xmi extension and answer
`NOT_FOUND` naming it when it is not installed; `list_extensions` shows what StarUML loads and
the menu commands each adds.
**Diagnostics**: `performance_stats` counts the repository's listeners, the undo depth, the
elements, the open tabs and the heap. A count that grows over a session while the model does
not is what slows StarUML down; report it.

```json call_endpoint
{ "name": "performance_stats" }
```

## 15. Keeping token use down

- Element results are summaries `{_id, _type, name, _parent, path}`. Ask for more with `fields`
  (attribute names), `depth` (owned elements) or, rarely, `summary: false`.
- `find_elements` pages: pass `limit` and the `nextCursor` it returns.
- Results omit null and empty fields and the arguments you sent; a bare `ok` means success.
- Resources cost nothing until read: `staruml://project/tree` (ownership tree),
  `staruml://diagrams`, `staruml://diagram/{id}.png`, `.mmd` and `.puml`,
  `staruml://introspect/metamodel` (types and attributes), `staruml://patterns` and
  `staruml://pattern/{name}` (the pattern library), `staruml://introspect/endpoints`
  (every request schema).
- To understand a diagram, `diagram_as_text`; `view_diagram` only when the
  layout itself matters.
- One `build_diagram` or `batch` call replaces dozens of single calls and their results.
- Export to a `path` instead of inline base64 when the image is for the user, not for you.
- `doctor` reports the StarUML and extension versions; `call_endpoint({name: "introspect"})`
  returns them alone unless asked for `include` sections; narrow the metamodel with
  `types: ["UMLClass"]`.

## 16. Access token and refusals

If the extension's access token is set in StarUML (Server Info, Generate Access Token...), the
server must be started with `--ext-token <token>` or the `STARUML_EXT_TOKEN` environment variable;
otherwise every extension call answers `UNAUTHORIZED`. Never ask the user to paste the token into
the chat; ask them to set the variable where the MCP server is configured.

Errors come back as results with `isError`, a `[CODE, endpoint, HTTP status]` line and often a
`Hint:` line; follow the hint. `INVALID_ARGUMENT` names the failing field (`ops.2.body.ref`
inside a batch). `DIALOG_REQUIRED` means the command would open a dialog: pass the arguments
`describe_commands` lists, or use the dedicated endpoint. `RATE_LIMITED` says when to retry.
`AMBIGUOUS_REF` means a path fits several elements; the hint names them, pass one of those.
`DUPLICATE_NAME` means a sibling of that kind has the name: refer to the existing element, keep
`build_diagram`'s `reuse` on, rename, or pass `allowDuplicateNames: true`. `SNAPSHOT_STALE` means
the undo history no longer reaches the snapshot; `UNSUPPORTED_SYNTAX` names a construct of the
diagram text and its line that StarUML cannot draw. `STYLE_LOCKED` means the style profile is
strict (section 6): use `improve_diagram` or `apply_style_profile` instead of placing views.
`SAVE_BLOCKED` lists the lint errors that block saving; fix them first.
