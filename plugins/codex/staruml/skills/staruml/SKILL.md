---
name: staruml
description: Use when creating, reading, changing or exporting UML models and diagrams in StarUML through the staruml MCP server - class, sequence, use case, activity, state machine, ER, flowchart or mind map diagrams, Mermaid into StarUML, .mdj projects - or whenever the user mentions StarUML.
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
| A new diagram of a kind below | `build_diagram` with a `spec`: exact names, one undo step, ids back |
| Their Mermaid source rendered | `generate_diagram` (routes itself, see section 4) |
| Small edits to an existing model | `find_elements`, then `update_element` / `delete_element` |
| Many related creations or edits | one `batch` |
| To read or explain a diagram | `diagram_as_text` or `describe_diagram` (section 7), not a picture |
| The `type` or command id to pass | `search_types` |
| To check a model | `validate_model` |
| Anything else StarUML can do | `describe_endpoints`, then `call_endpoint` |
| To see a diagram | `view_diagram`; `export_diagram` for files |

A user may also start the server's prompts `model-codebase` (reverse-engineer a source directory
or build class diagrams from a description) and `review-diagram`; they spell out the same calls.

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
references (section 5) for what a batch creates.

## 3. build_diagram: one spec per kind

`kind` is required with `spec`. Nodes are named by `name`; edges refer to nodes by name, or by
`id` where a node has one. `\n` or `<br/>` in a name stores a line break (StarUML 7.1.1 draws it
on one line). The answer carries the diagram id and the model and view id of every node, keyed
by name. `upsert: true` updates the diagram of the same name instead of adding a second one;
it adds what is missing and never deletes. `direction` is `TB` (default), `BT`, `LR` or `RL`;
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

The full grammar with every optional field: `describe_endpoints({names: ["build_diagram"]})`.

## 4. Mermaid

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

## 5. batch and `$name` references

`batch` runs endpoint calls in order as one undo step and, by default, rolls every op back when
one fails. `as` names an op's result; a later body refers to its id as `"$name"`, to a
`{view, model}` result's parts as `"$name.view"` and `"$name.model"`, to a nested field as
`"$name.path.0"`. Paths are endpoint paths, so any endpoint works here, listed as a tool or not.
The server checks every op's body and every reference before anything is sent.

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

## 6. Endpoints without a tool

The default tool list is a core set. The other endpoints (project open/save, views, layout,
styles, undo/redo, commands, code generation, PDF/HTML export) are one step away:

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

## 7. Reading, viewing and exporting

Read a diagram as text. For a six-class diagram with members, Mermaid or a `describe_diagram`
summary is about 270 tokens, a PNG about 1,600 (an estimate, billed as an image) and an element
dump with `summary: false` about 4,400.

```json diagram_as_text
{ "diagram": "Ordering" }
```

`diagram_as_text` writes a diagram (default the current one) as Mermaid, or as PlantUML with
`format: "plantuml"`, then a line with its `kind` and any `warnings` about what the text cannot
carry. The Mermaid is the form `build_diagram` reads back: edit it and pass it as `mermaid`, with
`kind` for use case and activity diagrams, to rebuild. `describe_diagram({diagram})` lists the
nodes with their members and the edges as `"tail" -[Type "name"]-> "head"`, without
multiplicities or composition; `staruml://diagram/{id}.mmd` and `.puml` serve the text as
resources.

```json search_types
{ "query": "composition", "limit": 3 }
```

`search_types` finds the metamodel type, palette item, relationship kind or command id for a
word, each with an example request body; use it instead of guessing a `type`.

```json validate_model
{}
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
dark mode in clients that render MCP Apps, a PNG image elsewhere. Use it to check a layout
after building.

```json export_diagram
{ "format": "png", "scale": 2 }
```

`export_diagram` returns PNG or JPEG as an image and SVG as text; with `path` it writes the file
and returns only its size, which is what to do for anything the user wants on disk.

## 8. Keeping token use down

- Element results are summaries `{_id, _type, name, _parent, path}`. Ask for more with `fields`
  (attribute names), `depth` (owned elements) or, rarely, `summary: false`.
- `find_elements` pages: pass `limit` and the `nextCursor` it returns.
- Results omit null and empty fields and the arguments you sent; a bare `ok` means success.
- Resources cost nothing until read: `staruml://project/tree` (ownership tree),
  `staruml://diagrams`, `staruml://diagram/{id}.png`, `.mmd` and `.puml`,
  `staruml://introspect/metamodel` (types and attributes), `staruml://introspect/endpoints`
  (every request schema).
- To understand a diagram, `diagram_as_text` or `describe_diagram`; `view_diagram` only when the
  layout itself matters.
- One `build_diagram` or `batch` call replaces dozens of single calls and their results.
- Export to a `path` instead of inline base64 when the image is for the user, not for you.
- `introspect` returns versions only unless asked for `include` sections; narrow the metamodel
  with `types: ["UMLClass"]`.

## 9. Access token and refusals

If the extension's access token is set in StarUML (Server Info, Generate Access Token...), the
server must be started with `--ext-token <token>` or the `STARUML_EXT_TOKEN` environment variable;
otherwise every extension call answers `UNAUTHORIZED`. Never ask the user to paste the token into
the chat; ask them to set the variable where the MCP server is configured.

Errors come back as results with `isError`, a `[CODE, endpoint, HTTP status]` line and often a
`Hint:` line; follow the hint. `INVALID_ARGUMENT` names the failing field (`ops.2.body.ref`
inside a batch). `DIALOG_REQUIRED` means the command would open a dialog: pass the arguments
`describe_commands` lists, or use the dedicated endpoint. `RATE_LIMITED` says when to retry.
