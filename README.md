# staruml-mcp

[![npm version](https://img.shields.io/npm/v/staruml-mcp.svg)](https://www.npmjs.com/package/staruml-mcp)
[![npm downloads](https://img.shields.io/npm/dm/staruml-mcp.svg)](https://www.npmjs.com/package/staruml-mcp)
[![CI](https://github.com/hqqw2h-lgtm/staruml-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hqqw2h-lgtm/staruml-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io/)

This is the [hqqw2h-lgtm fork](https://github.com/hqqw2h-lgtm/staruml-mcp) of
[ezrabrilliant/staruml-mcp](https://github.com/ezrabrilliant/staruml-mcp); it pairs with the
[hqqw2h-lgtm fork of staruml-mcp-extension](https://github.com/hqqw2h-lgtm/staruml-mcp-extension).

Model Context Protocol (MCP) server for [StarUML](https://staruml.io). Lets AI agents (Claude Code, Cursor, VS Code Copilot, Codex) drive StarUML programmatically — generate UML diagrams from Mermaid, build native models and diagrams element by element, execute any built-in command, save projects, and more.

## How it fits together

```
  AI Agent  ──MCP──►  staruml-mcp (this package)  ──HTTP──►  StarUML
                                                  :58321 (built-in, 4 tools)
                                                  :58322 (extension 0.3.x, 69 endpoints
                                                          from its manifest: core ones as
                                                          tools, the rest via call_endpoint)
```

| Package | What it is | Where it runs |
|---|---|---|
| **`staruml-mcp`** (this repo) | MCP server for AI agents | your machine via `npx -y staruml-mcp` |
| **[`staruml-mcp-extension`](https://github.com/hqqw2h-lgtm/staruml-mcp-extension)** 0.3.x | StarUML plugin adding 69 HTTP endpoints and a manifest of them (`POST /introspect`) | inside StarUML (install once via Extension Manager) |

- Using only Mermaid-based diagram tools? Install `staruml-mcp` only. The 4 built-in tools, `doctor` and `view_diagram` (as a PNG) work.
- Want the extension's 69 endpoints (whole diagrams from a spec or Mermaid in one call, elements addressed by path instead of id, diagram and UML lint with fixes, diffs and snapshots, diagrams read back as Mermaid, PlantUML or a text summary, type search, model validation, project save/open, element CRUD, relationships, attributes and operations, layout presets and edge routing, styling, export, undo, batches, code generation, any StarUML command)? Install **both**.

## Prerequisites

- **StarUML v7.0.0+** with API Server enabled (see below)
- **Node.js 20+** on the machine running the AI agent
- **(Optional)** [`staruml-mcp-extension`](https://github.com/hqqw2h-lgtm/staruml-mcp-extension) 0.3.x installed in StarUML — required for every tool except the 4 built-in ones and `doctor`

### Enable StarUML API Server

Edit `settings.json` at:
- **Windows:** `%APPDATA%\StarUML\settings.json`
- **macOS:** `~/Library/Application Support/StarUML/settings.json`
- **Linux:** `~/.config/StarUML/settings.json`

Add or update:
```json
{
  "apiServer": true,
  "apiServerPort": 58321
}
```

Restart StarUML.

Verify:
```bash
curl http://localhost:58321/
# → "Hello from StarUML API Server!"
```

### Keep StarUML's API off the network

StarUML 7.1.1's built-in API server listens on every interface (`lsof -nP -iTCP:58321` shows
`*:58321`) and has no authentication, so on a shared network anyone who can reach the machine
can create diagrams in the open project. StarUML has no setting to bind it to localhost. The
extension listens on `127.0.0.1:58322` only and can require a token ([Access
token](#access-token)); this server's HTTP transport binds `127.0.0.1` by default
([below](#http-transport-binding)). Block 58321 from other machines with the host firewall;
loopback traffic, which is all this server needs, is not affected by any of these:

- **macOS**: System Settings > Network > Firewall > Options, add StarUML and choose "Block
  incoming connections", or from a terminal:
  ```bash
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /Applications/StarUML.app
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --blockapp /Applications/StarUML.app
  ```
- **Linux**: `sudo ufw deny in to any port 58321 proto tcp` (ufw keeps loopback open), or
  `sudo iptables -A INPUT -p tcp --dport 58321 ! -i lo -j DROP` and the same with `ip6tables`.
- **Windows** (elevated PowerShell): `New-NetFirewallRule -DisplayName "StarUML API" -Direction
  Inbound -Protocol TCP -LocalPort 58321 -Action Block`; Windows Defender Firewall does not filter
  loopback connections.

Check from another machine that `curl --max-time 3 http://<this machine>:58321/` times out while
`curl http://localhost:58321/` still answers here.

## Install & Use

### Claude Code (recommended — HTTP transport)

Start the server in a terminal:
```bash
npx -y staruml-mcp --transport http
# listens on http://127.0.0.1:58323/mcp by default
```

Register with Claude Code:
```bash
claude mcp add --transport http staruml http://localhost:58323/mcp
```

> **Port `58323`** is the canonical HTTP port, chosen to sit alongside StarUML's built-in API (`58321`) and `staruml-mcp-extension` (`58322`). Override with `--port <n>` if needed.

#### HTTP transport binding

`--transport http` listens on `127.0.0.1` and answers only requests whose `Host` is a loopback
name (`localhost`, `127.0.0.1`, `[::1]`) and whose `Origin`, when a browser sends one, is a
loopback origin; anything else gets `403` (DNS rebinding protection, as the MCP spec's transport
security warning asks of local servers). `--host <address>` binds elsewhere, for example
`--host 0.0.0.0` for a container or another machine; the server then accepts any `Host` and
prints a warning on start, since the endpoint has no authentication and its tools save, open and
change projects and run StarUML commands. Put it behind a firewall or an authenticating proxy
in that case.

The HTTP transport keeps sessions (MCP 2025-06-18, Transports, "Session Management"): the
answer to `initialize` carries an `Mcp-Session-Id`, and every request with that header reaches the
same server, which remembers the client's capabilities and resource reads and holds its GET
stream. So over HTTP, as over stdio, `view_diagram` shows the [inline viewer](#inline-viewer-mcp-apps)
to clients that render MCP Apps, and `notifications/tools/list_changed` reaches every session when
`doctor` reloads the manifest or switches the tier. Limits:

- A session with no request in flight for `--session-timeout` (default 30 minutes) is closed; an
  open GET stream counts as a request in flight. Its id then gets `404`, on which the spec has the
  client initialize again.
- At most `--max-sessions` (default 64) live sessions; one more closes the least recently used.
  A core-tier session holds about 160 KB of heap.
- A request without a session id (`curl`, scripts, clients that never initialize) is served
  statelessly by a server built for it alone, as every request was in 0.4.0: it works, but has
  no viewer and receives no notifications. `--max-sessions 0` serves every request that way.
- Sessions live in memory: restarting the server ends them all.
- A POST body over 4 MiB, the MCP SDK's own message cap (`MAXIMUM_MESSAGE_SIZE` in its SSE
  transport), is refused with `413` and the connection closed, unread, in both modes; the largest
  real request, a `build_diagram` spec, is tens of KiB.

Restart Claude Code. Ask:
> "What StarUML tools do you have?"

### Claude Desktop (stdio transport)

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "staruml": {
      "command": "npx",
      "args": ["-y", "staruml-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Cursor / VS Code Copilot / Codex CLI

Point your MCP client at `npx -y staruml-mcp` (stdio) or `http://localhost:58323/mcp` (HTTP).

### Agent skill and plugins

`plugins/` packages a `staruml` agent skill that teaches the workflow: `doctor` first, the
`build_diagram` spec of each diagram kind with an example, when Mermaid goes where, `batch` and its
`$name` references, `describe_endpoints` / `call_endpoint`, viewing and exporting, keeping tokens
down, and the access token. The Claude Code plugin also registers this server over stdio
(`npx -y staruml-mcp`, passing `STARUML_EXT_TOKEN` through when it is set).

```bash
# Claude Code
claude plugin marketplace add hqqw2h-lgtm/staruml-mcp
claude plugin install staruml@staruml
# or from a clone: claude --plugin-dir ./plugins/claude-code

# Codex CLI (skill only; add the MCP server as above)
codex plugin marketplace add hqqw2h-lgtm/staruml-mcp
codex plugin add staruml@staruml

# GitHub Copilot CLI (skill only)
copilot plugin marketplace add hqqw2h-lgtm/staruml-mcp
copilot plugin install staruml@staruml
```

The marketplaces are `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` and
`.github/plugin/marketplace.json`. `plugins/claude-code/skills/staruml/SKILL.md` is the one copy
edited by hand; `npm run sync:skills` writes the Codex and Copilot copies, and the test suite fails
when they are stale. Every `json <tool>` block in the skill is a tool call that
`tests/skill.test.ts` runs through the in-memory transport against the HTTP stand-ins, and the live
suite runs again against StarUML, so an example that stops working fails the build.

[docs/comparison-drawio.md](docs/comparison-drawio.md) compares this server with jgraph/drawio-mcp
feature by feature, including what each lacks.

## CLI

```
staruml-mcp [options]

  -t, --transport <type>   stdio | http              (default: stdio)
  -p, --port <number>      HTTP listen port          (default: 58323)
      --host <address>     HTTP bind address         (default: 127.0.0.1; warns otherwise)
      --api-port <number>  StarUML built-in API port (default: 58321)
      --ext-port <number>  staruml-mcp-extension port(default: 58322)
      --ext-token <token>  extension access token    (env STARUML_EXT_TOKEN)
      --api-host <url>     StarUML API host prefix   (default: http://localhost)
      --doctor             Check the setup, print a report and exit (1 on failure)
      --tools <tiers>      core | all | comma list   (default: core; env STARUML_MCP_TOOLS)
      --session-timeout <duration>  close an idle HTTP session (default: 30m; ms, s, m or h)
      --max-sessions <number>       live HTTP sessions, LRU beyond (default: 64; 0 = stateless)
  -V, --version            Print version
  -h, --help               Show help
```

On start the server checks its setup and prints a report to stderr (stdout carries the stdio
transport); `--doctor` prints the same report to stdout and exits:

```
node         ok    22.23.3
staruml api  ok    http://localhost:58321
extension    ok    0.3.0 at http://localhost:58322
staruml      ok    7.1.1
manifest     ok    69 endpoints from the live manifest
tier         ok    core: 11 extension tools listed, 50 endpoints through call_endpoint
```

A failing check is followed by a `fix` line: start StarUML, enable `apiServer` in StarUML's
`settings.json`, install the extension from its URL, or restart StarUML. The `doctor` tool runs the
same check for an agent; `doctor({tools: "all"})` also switches the listed tier.

### Access token

When the extension's `mcp-ext.token` preference is set, it answers `401 UNAUTHORIZED` to every
request without `Authorization: Bearer <token>`, `GET /` included. In StarUML,
Tools > MCP Extension > Server Info says whether a token is required, and Generate Access Token...
creates one and shows it once (it is stored in Preferences > MCP Extension > Access Token). Give it to this server with
`STARUML_EXT_TOKEN` (preferred: command-line arguments are visible to every local user) or
`--ext-token`; the flag wins, and an empty value means none. The token goes with every request to
the extension, the startup check and `doctor` included, and never to StarUML's built-in API. Clearing
the preference turns the check off; a token the extension does not require is ignored. Without the
right token the startup report says so:

```
extension    fail  http://localhost:58322 refused the request: Missing or wrong bearer token [UNAUTHORIZED]
             fix   The extension requires an access token. In StarUML, Tools > MCP Extension > Server Info says whether a token is required and Generate Access Token... creates one; pass it with --ext-token <token> or STARUML_EXT_TOKEN. To turn the check off, clear Preferences > MCP Extension > Access Token.
```

## Tools Exposed

### Built-in (always available, port 58321)

| Tool | Description |
|---|---|
| `generate_diagram` | Generate a UML diagram from Mermaid code; `name` names it and `kind` (`activity`, `usecase`) reads a flowchart as that kind. Routed to the extension's `build_diagram` when needed (below). |
| `get_all_diagrams_info` | List all diagrams in the current project (id, name, type). |
| `get_current_diagram_info` | Get metadata of the currently focused diagram. |
| `get_diagram_image_by_id` | Export a diagram as PNG by its ID. |
| `view_diagram` | Show `diagram` (an id or a path; default the current one): an interactive SVG viewer in clients that render MCP Apps, the `get_diagram_image_by_id` PNG otherwise ([below](#inline-viewer-mcp-apps)). The SVG comes from the extension, which also resolves a path to the id the PNG needs. |
| `diagram_as_text` | `diagram` (an id or a path; default the current one) as Mermaid, or PlantUML with `format: "plantuml"`, through the extension's `export_text`: the text in a block of its own, then `{id?, kind, warnings?}`. The Mermaid is the form `build_diagram` reads back. |
| `doctor` | Check Node, both StarUML ports, the extension and StarUML versions; reloads the extension's tools and, given `tools`, switches the tier. |

### generate_diagram routing

StarUML 7.1.1's built-in `/generate_diagram` names every diagram "<Kind> Diagram by Mermaid", keeps
`<br/>` as text, cannot draw activity or use case diagrams, and refuses front matter, a leading
`%%` comment and the `graph` keyword (upstream staruml-mcp-server issues #2, #3, #4). The tool
therefore sends the Mermaid to the extension's `build_diagram` when the call has a `name` or
`kind`, a front matter `title:` or `title` line, `<br/>` or a literal `\n`, or a start the built-in
cannot read, and the extension reads the diagram type (`classDiagram`, `sequenceDiagram`,
`flowchart`/`graph`, `erDiagram`, `stateDiagram`). It then answers `build_diagram`'s result, with
the diagram's id and name and the model and view ids of every node; otherwise the built-in renders
it and the answer stays `ok`.

Without a usable extension (not installed, incompatible, or not answering), a title or `<br/>` only
costs the naming and line breaks: the built-in renders the diagram and the answer says so (`ok;
built-in API without title, line breaks: staruml-mcp-extension did not answer`). An explicit `name`
or `kind` cannot be honoured there and fails with `EXTENSION_REQUIRED` (or the extension's own
`EXTENSION_UNREACHABLE`); a `name` or `kind` for a type `build_diagram` does not read from Mermaid,
such as `mindmap`, fails with `INVALID_ARGUMENT` and points to `build_diagram`'s spec.

`<br/>` and `\n` become a newline in the element's name. StarUML 7.1.1 draws every label with a
single canvas `fillText` call, which does not break lines at a newline (`LabelView.draw`; its word
wrap splits at spaces only), so the diagram shows `Web App` on one line rather than the literal
`Web<br/>App`; drawing two lines needs a change to the extension or StarUML. The live suite checks
both the stored newline and the one-line rendering.

### Tiers

Every tool definition is resent to the model on each turn, so the server lists a small core tier by
default and reaches every other extension endpoint through two generic tools:

| Tier | Listed as tools | Definition tokens |
|---|---|---|
| `core` (default) | the 7 above; `introspect` (summary), `find_elements`, `get_element_by_id`, `update_element`, `delete_element`, `batch`, `build_diagram`, `export_diagram`, `search_types`, `describe_diagram`, `validate_model`; `describe_endpoints`, `call_endpoint` | 1,973 |
| `all` | the 7 above and one tool per manifest endpoint | 10,954 |
| `core,create_diagram,…` | the 7 above and the named endpoints (`core` expands as above); `describe_endpoints`, `call_endpoint` while any endpoint is left out | |

Token counts include the server instructions (o200k_base, extension 0.3.0, `npm run
benchmark:tokens`). Pick the tier with `--tools`, or `STARUML_MCP_TOOLS` for clients that pass
environment but no arguments; the flag wins. An agent can switch it at runtime with
`doctor({tools: "all"})`; the server then sends `notifications/tools/list_changed`, as it does when
`doctor` finds a manifest with other endpoints. Names that are neither endpoints nor tools are
reported by the `tier` check.

- **`describe_endpoints()`** returns the endpoints without a tool, grouped (`project`, `command`,
  `meta`, `feature`, `editor`, `code`, `diagram`, `element`; grouped by name, since the manifest has none), one line
  each. `describe_endpoints({names: [...]})` or `({group})` returns their full description, `readOnly`
  / `destructive` flags and request schema as `tools/list` would show it. Named endpoints may be
  listed ones.
- **`call_endpoint({name, body})`** checks `body` against the endpoint's request schema from the
  manifest, unknown keys included, and forwards it. A rejected body comes back as
  `INVALID_ARGUMENT`, an unknown name as `UNKNOWN_ENDPOINT`, both before any request; results and
  extension errors look exactly like those of a dedicated tool.
- **`introspect`** is a summary: StarUML and extension versions, plus `factory`, `metamodel` (narrow
  it with `types`) or `toolbox` when asked for. The endpoint manifest is left to
  `describe_endpoints` and `staruml://introspect/endpoints`; the full `/introspect` stays callable
  through `call_endpoint`.

### Extension tools (require [`staruml-mcp-extension`](https://github.com/hqqw2h-lgtm/staruml-mcp-extension) 0.3.x, port 58322)

These tools are not written by hand. The extension publishes a manifest from `POST /introspect`:
each endpoint's name, description, read-only and destructive flags, and JSON Schemas for request
and response. On start, and whenever `doctor` runs, the server reads it and registers one tool per
endpoint:

- **name** is the path without `/` (`/find_elements` → `find_elements`);
- **description** is the endpoint description cut to the sentences that fit in 100 characters,
  on one line;
- **input schema** is the endpoint's request schema converted with zod's `fromJSONSchema` and
  listed back by the MCP SDK without the `$schema` URL the SDK would add, otherwise unchanged
  except that the projection parameters (`summary`, `fields`, `depth`) are accepted without being
  listed (the instructions explain them once) and the shared `properties` description is
  shortened;
- **annotations**: `readOnlyHint` from the manifest's `readOnly`, `destructiveHint` from
  `destructive` (stated for every writing tool, since MCP defaults it to true),
  `openWorldHint: false`;
- **canonical names only**: extension 0.3.0 renamed its id fields when they began to take paths
  (`id` → `ref`, `ids` → `refs`, `diagramId` → `diagram`, `tailId`/`tailViewId` → `tail`,
  `parentId` → `parent`, `containerViewId` → `container`, `viewIds` → `views`, ...) and keeps the
  old names as aliases marked `x-alias-of` and `deprecated`. Listings and `describe_endpoints`
  leave the aliases out. A body sent through `call_endpoint`, `batch` or a short-listed tool may
  still use them: they are renamed before the body is checked, as the extension renames them,
  and both spellings of one field are refused with `INVALID_ARGUMENT`.

Every field that takes an element takes its `_id` or a path: `Model/Shop/Order` (owners from the
project down, or only the trailing steps when they name one element), `Order.total` (a member),
`Order#pay()` or `Order#pay(int, String)` (an operation and overload), a diagram's name,
`Order@Main` (the view of `Order` on diagram `Main`), `@current` (the open diagram) and
`@project`; `\` escapes a separator inside a name. A path that fits several elements is refused
with `AMBIGUOUS_REF` and the candidates' ids and paths. Element summaries carry the `path` each
element resolves by.

A copy of the 0.3.0 manifest (69 endpoints) is bundled (`src/extension-manifest.json`), so `tools/list` is
complete while StarUML is closed; calls then fail with `EXTENSION_UNREACHABLE` and an install hint.
`npm run sync:manifest` refreshes the copy from a running extension (`-- --url <base>`) or from a
recorded `/introspect` response (`-- --from <file>`). When the running extension's version is
incompatible (another major version, or another minor version while it is 0.x), the server lists no
extension tools at all and the startup report and `doctor` say which version to install.

With extension 0.3.0 (each a tool under `--tools all`, otherwise a `call_endpoint` name unless in
the core tier):

| Endpoint | Does |
|---|---|
| `build_diagram` | A whole diagram in one call and one undo step, from a compact spec per kind (class, sequence, usecase, activity, statemachine, erd, flowchart, mindmap) or from Mermaid; laid out with a `layout` preset (default by kind), optionally upserted into the diagram of the same name; answers the model and view ids by node name. |
| `export_text` / `describe_diagram` | A diagram as Mermaid (the form `build_diagram` reads back) or PlantUML, with warnings for what the text cannot carry / a bounded text summary of its nodes, members and edges. |
| `search_types` / `validate_model` | Fuzzy search over metamodel types, palette items, relationship kinds and commands, each hit with an example request / StarUML's validation rules over the open model, problems with element and rule ids. |
| `get_all_commands` / `describe_commands` / `execute_command` | List command ids / their arguments and whether they open a dialog / run any StarUML command. |
| `get_project_info` / `new_project` / `open_project` / `save_project` / `save_project_as` | Project lifecycle. |
| `get_element_by_id` / `find_elements` | Read elements; `find_elements` pages with `limit`/`cursor`. |
| `create_element` / `update_element` / `delete_element` | Model elements without views; `update_element` sets, adds, removes, reorders or relocates. |
| `create_element_with_view` / `create_edge_with_view` / `create_relationship` | Elements and relationships drawn on a diagram; `create_relationship` also sets association ends. |
| `add_attribute` / `add_operation` / `add_parameter` / `add_enumeration_literal` / `add_template_parameter` / `add_slot` / `add_tag` | Features of classifiers and instances. |
| `set_stereotype` / `set_documentation` | Common element properties. |
| `create_diagram` / `switch_diagram` / `close_diagram` | Diagrams. |
| `get_views_of` / `get_edge_views_of` / `get_relationships_of` / `get_refs_to` / `get_connected_node_views` | Lookups between models, views and relationships. |
| `layout_diagram` / `route_edges` / `move_views` / `resize_node` / `set_view_style` / `set_z_order` | Arrange and style views; `layout_diagram` takes a preset (`flow-down`, `hierarchy-right`, …), node and rank separations and `fit`, `route_edges` gives every edge one line style. |
| `get_selection` / `set_selection` / `get_editor_state` / `set_editor_state` | Selection, current diagram, zoom and grid. |
| `export_diagram` / `export_diagrams` / `export_pdf` / `export_html` | Diagram as PNG, JPEG or SVG (inline or to a file) / many diagrams into a directory / PDF / HTML docs. |
| `list_code_generators` / `generate_code` / `reverse_code` | Installed language generators and their options / source code from a model element / a source directory into the model. |
| `undo` / `redo` / `is_modified` | History and unsaved state. |
| `batch` | Several calls in one request, by default one undo step that rolls back when an op fails. |
| `introspect` / `debug` | Versions, factory ids, metamodel, toolbox and manifest (the `introspect` tool is the summary) / the raw `app` surface. |

To enable extension tools: install `staruml-mcp-extension` in StarUML (Tools → Extension Manager → Install From URL → `https://github.com/hqqw2h-lgtm/staruml-mcp-extension`).

### Results

Tool results are minified JSON. Properties that are `null`, `[]` or `{}` are dropped from every
object, top-level properties that repeat an argument (such as the `filename` passed to
`save_project`) are dropped, and a call with nothing left to report returns `ok`. A missing
property therefore means null or empty. `get_current_diagram_info` returns `null` when no diagram
is active.

Elements come back as the extension's summaries, `{_id, _type, name, _parent, path}`; references and
owned elements are `{$ref: id}`. Every tool that returns elements accepts `fields` (attribute
names), `summary: false` (every saved attribute) and `depth` (levels of owned elements to expand);
no tool lists them, since the server instructions name them once for all. `find_elements` pages with `limit` and `cursor` (`nextCursor` is absent on the last page). The
`/create_*_with_view` and `/create_relationship` tools return `{view, model}`.

`batch` takes `{ops: [{path, body, as}], atomic}`. A string `"$a"` in a body stands for the id of
the result of the op named `a`, `"$a.view"` and `"$a.model"` for those of a `{view, model}` result,
a numeric segment indexes a list (`"$a.model.operands.0"`), and `"$$"` escapes a literal `$`. Before sending, the server checks every op against its endpoint's
manifest schema (a reference may stand where the schema wants another type, since its value is
only known once the batch runs) and that each reference names an earlier op; a failure is
`INVALID_ARGUMENT` with the op index, as in `ops.2.body.ref: …`. Each result comes back without
the op's `path` and, when it succeeded, without `success: true`. An atomic batch that fails in
StarUML is rolled back and reported with the failing op's code; the extension's
`details: {index, results}` come back in `structuredContent.error.details`, the results compacted as
above, and the text adds `Details: {"index": n}` (the results name elements the rollback removed).

`build_diagram` lists a hand-written description and seven parameters (`kind`, `spec`, `mermaid`,
`name`, `upsert`, `direction`, `layout`, 267 tokens); the manifest's own description of `spec` alone is ~400
tokens, so `spec` lists a one-line grammar per kind and `describe_endpoints({names:
["build_diagram"]})` serves the full one. The unlisted `parent` (an id or a path) and `autoLayout` are accepted, and
every body is checked against the manifest's whole request schema before it is sent, as for `batch`.

`export_diagram` lists a hand-written description and shorter parameter descriptions (139 tokens
against the manifest's 208); the colour pattern is left to the check against the whole request
schema, as for `build_diagram`. It returns a PNG or JPEG as an image content block followed by the rest of the answer
(`width`, `height`, `bytes`) as JSON; as text, the base64 of even a small diagram costs thousands of
tokens. SVG and exports written to `path` come back as JSON.

`find_elements`, `update_element`, `search_types`, `describe_diagram` and `validate_model` list
hand-written descriptions too, in 95, 202, 86, 68 and 58 tokens; `update_element` keeps the
meaning of each `op` in one line. These short listings, like `build_diagram`'s and
`export_diagram`'s, leave string lengths and integer bounds to the check against the whole
request schema, keep the manifest's `required`, and, like every listing, leave out
`additionalProperties: {}` and `propertyNames: {type: "string"}`, which hold for every object.
`search_types` answers its hits without the ranking `score`; `describe_diagram` answers its
summary text alone, whose first line already names the diagram and counts its nodes and edges.

### Resources

Clients that support MCP resources can read these instead of calling the matching tool, which keeps
diagram PNGs out of tool results:

| URI | Content | Tool equivalent |
|---|---|---|
| `staruml://diagrams` | `application/json` list of diagrams | `get_all_diagrams_info` |
| `staruml://project` | `application/json` project info (needs the extension) | `get_project_info` |
| `staruml://project/tree` | `application/json` ownership tree of every model element and diagram, `[{_id, _type, name, children}]`, built from paged `find_elements` summaries (needs the extension) | `find_elements` with `type: "Model"` |
| `staruml://introspect/metamodel` | `application/json` every metamodel type with attributes, supertypes and view types, schema values intact (needs the extension) | `introspect` with `include: ["metamodel"]` |
| `staruml://introspect/endpoints` | `application/json` the endpoint manifest this server uses (live or bundled), with request and response JSON Schemas | `describe_endpoints` |
| `ui://staruml/viewer.html` | `text/html;profile=mcp-app` the diagram viewer `view_diagram` names in its `_meta` | |
| `staruml://diagram/{id}.png` | `image/png` blob; `{id}` is percent-encoded, since ids can contain `/`, `+` and `=` | `get_diagram_image_by_id` |
| `staruml://diagram/{id}.mmd`, `staruml://diagram/{id}.puml` | `text/plain` Mermaid or PlantUML (no media type is registered for either), `_meta: {kind, warnings?}` (needs the extension) | `diagram_as_text` |

`resources/list` enumerates one `staruml://diagram/{id}.png` per diagram, and
`resources/templates/list` the three templates; the text forms are not listed per diagram. When StarUML is not
reachable it lists only the six static resources. A failed read is a JSON-RPC error whose `data`
holds the same `error` object a failed tool call returns.

StarUML 7.1.1's `/get_diagram_image_by_id` ignores every field except `diagramId` (`scale`,
`maxWidth`, `width` and `format` return identical bytes; the live suite checks this), so the
image tool and resource offer no size options.

### Prompts

Clients that surface MCP prompts (as slash commands in Claude Code, for instance) offer two:

| Prompt | Arguments | Workflow |
|---|---|---|
| `model-codebase` | `path`, `language`, `description`, `name` (all optional) | `doctor`; with a source directory, `list_code_generators` and `reverse_code` (StarUML's Java reverse adds type hierarchy and package overview diagrams by default); otherwise one `build_diagram` of the central classes from the code or the description; then `describe_diagram` and `validate_model` on the result. |
| `review-diagram` | `diagram`, an id or a path (default `@current`) | `describe_diagram`, `validate_model` scoped to the diagram's owner, `diagram_as_text`; then a review with a concrete fix per finding, changing nothing until asked. |

The text names each endpoint as a tool when the current tier lists it and as `call_endpoint`
otherwise, so it is right under `--tools` selections too.

### Inline viewer (MCP Apps)

`view_diagram` follows the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) extension,
protocol version `2026-01-26` as published in `@modelcontextprotocol/ext-apps` 1.7.4. The MCP
TypeScript SDK this server runs on (1.29.0) has no UI helpers, so the server side is the
convention itself: the tool carries `_meta.ui.resourceUri` (and the older flat `ui/resourceUri`)
pointing at `ui://staruml/viewer.html`, a resource of type `text/html;profile=mcp-app`. The page
is one self-contained HTML file with no external requests; it speaks the protocol's JSON-RPC over
`postMessage` itself (`ui/initialize`, `ui/notifications/tool-result`,
`ui/notifications/host-context-changed`, `ui/notifications/size-changed`).

- **Client renders MCP Apps**: it declared `capabilities.extensions["io.modelcontextprotocol/ui"]`
  with that MIME type at `initialize`, or it has read the viewer resource in this session (some
  hosts render without declaring). The tool exports the diagram as SVG through the extension's
  `export_diagram` and looks up its name, then returns the SVG in `structuredContent` for the view
  and a one-line JSON summary (`diagram`, `name`, `width`, `height`, `viewer`) as text for the
  model, so the SVG does not enter the model's context. The view shows the diagram's name, pans by
  dragging, zooms with the wheel or the −/+ buttons, fits on `Fit` or a double-click, and follows
  the host's light or dark theme until the Dark button overrides it. The SVG is shown as an
  `<img>` data URL, which runs no script whatever text the model put in element names.
- **Any other client**, or no compatible extension: the PNG image block `get_diagram_image_by_id`
  returns, from StarUML's built-in API, for `diagram` or the current diagram.

Over `--transport http` this works within a session; a request sent without a session id gets
a server of its own, which sees neither sign, and answers the PNG.

### Errors

A failed tool call returns `isError: true` with a one-line cause, a hint where one helps, and
`structuredContent.error = { code, message, endpoint, upstream, status?, hint? }`. The message is the
`error` field of StarUML's or the extension's JSON body, so the calling agent sees the real cause
(for example `Element not found: …`) instead of `HTTP 400 Bad Request`.

| `code` | Meaning |
|---|---|
| `STARUML_UNREACHABLE` | Nothing answers on the built-in API port: StarUML is closed or `apiServer` is off. |
| `EXTENSION_UNREACHABLE` | StarUML answers but the extension port does not: the extension is not installed or listens elsewhere. |
| `ENDPOINT_NOT_FOUND` | HTTP 404 for the endpoint: the installed StarUML or extension version does not provide it. |
| `REQUEST_REJECTED` | HTTP 4xx or `success: false` without a `code`: the arguments were rejected; read `message`. |
| `UPSTREAM_ERROR` | HTTP 5xx without a `code` from StarUML or the extension. |
| `INVALID_RESPONSE` | The port answered with something other than the `{ success, data, error }` envelope. |
| `EXTENSION_REQUIRED` | `generate_diagram` was given a `name` or `kind` while no compatible extension with `build_diagram` is available. |
| `INVALID_ARGUMENT`, `UNKNOWN_ENDPOINT` | Also raised by `call_endpoint` itself, before any request, for a body the manifest schema rejects or a name it does not have; `endpoint` and `hint` say which and how to look it up. |
| extension 0.3.0 codes | Passed through with their HTTP status: `INVALID_ARGUMENT` (400), `UNKNOWN_TYPE` (400), `NOT_FOUND` (404), `UNKNOWN_ENDPOINT` (404, with the upgrade hint), `NO_PROJECT` (409), `STARUML_ERROR` (422, StarUML refused the operation), `DIALOG_REQUIRED` (422, the command or generator would have opened a dialog; the hint points to `describe_commands` for `execute_command` and to `list_code_generators` for code generation, and `details` names the missing arguments), `INTERNAL` (500). An error body's `details` is passed through as `error.details` and, except for a rolled-back batch's results, as a `Details:` line. |
| extension request checks | Passed through with a hint naming the setting: `UNAUTHORIZED` (401: no or wrong access token; how to set or clear it), `FORBIDDEN_ORIGIN` (403: an `Origin` header not in Allowed Origins), `PAYLOAD_TOO_LARGE` (413: Max Request Body (KiB) or Max Batch Ops), `UNSUPPORTED_MEDIA_TYPE` (415: not `application/json`), `RATE_LIMITED` (429: Commands per Minute, with the `Retry-After` seconds), `TIMEOUT` (504: Request Timeout (s); the work may still complete). A 401/403/413/415/429/504 without these codes, as from a proxy, gets the same hint. |

Arguments are checked against the tool's schema before any request, so a wrong-typed field fails
with an MCP input validation error and the extension never sees it.

## Example Prompts

- *"Create an ER diagram in StarUML for a POS database: users, menus, transactions with relationships."*
- *"Generate a sequence diagram for JWT login: frontend → /api/auth/login → AuthService → DB → JWT response."*
- *"Show me the current diagram in StarUML."*
- *"Export diagram with ID `xyz123` as an image."*

## Development

```bash
git clone https://github.com/hqqw2h-lgtm/staruml-mcp.git
cd staruml-mcp
npm install            # also installs the pre-commit hook (lint-staged: eslint + prettier)
npm run dev            # tsx watch on src/
npm run build          # bundle to dist/
npm test               # vitest: unit, tool-level, HTTP transport, property and fuzz tests
npm run test:coverage  # same, failing below 100% lines/branches/functions/statements
npm run test:live      # STARUML_LIVE=1: every tool and endpoint against a running StarUML + extension
npm run load-test      # HTTP transport load test (needs npm run build)
npm run soak-test      # 2000 calls over stdio: RSS, live heap and p99 must not grow (needs npm run build)
npm run test:mutation  # Stryker over src/, fails below 85% of mutants killed (92.89% now)
npm run benchmark:tokens # four scenarios under two accountings vs. 56864ca, 0cfc06b, 45bedd4; reading a diagram five ways
npm run sync:manifest  # refresh src/extension-manifest.json from a running extension
node scripts/capture-read-diagram.mjs # re-record the read-a-diagram benchmark data from StarUML
npm run typecheck      # tsc --noEmit for src and tests
```

[docs/verification.md](docs/verification.md) lists every verification layer (unit, property,
fuzz, contract, mutation, live, load, soak, skill-example replay), what it proves and how to run it.

Tool-level tests drive each tool through the MCP SDK's in-memory transport against local
`http.Server` stubs of ports 58321 and 58322; the generated tools are tested one per manifest
endpoint under `--tools all`, including that each listed input schema round-trips the manifest's JSON
Schema; `tests/tiers.test.ts` covers the core tier, `describe_endpoints`, `call_endpoint` validation
and the `--tools`/`STARUML_MCP_TOOLS` parsing, and checks the core listing stays within 2,000
tokens. The live suite runs the core tier, so it calls the other endpoints through
`call_endpoint`. It saves the open project to a temp file, works in a fresh project, and reopens
the original file when done; unsaved changes of the original are kept only in that temp copy, whose
path it prints.

## Performance

`scripts/load-test.mjs` starts `dist/index.js` with `--transport http` and sends
`tools/call get_all_diagrams_info` at each concurrency level; `--call-endpoint` sends a
`call_endpoint` of `find_elements`, which adds the manifest schema check and the extension port,
`--batch` a `batch` of four read-only ops, one of them with a `"$p.project"` reference, which adds
the per-op schema checks, and `--build` a `build_diagram` of a three-class Mermaid diagram with
`upsert`, which adds the check against the whole request schema. StarUML and the extension are
replaced by an in-process stub, which serves the bundled 0.3.0 manifest, so the numbers measure
this server and a local StarUML does not change them. By default no request carries a session
id, so each builds a fresh `McpServer` (the stateless fallback), which dominates the cost;
`--session` initializes once and sends every request in that session, as an MCP client does. Any
failed request makes the script exit non-zero; `--max-p99-ms` and `--min-rps` add budgets, and CI
runs the default, `--session`, `--batch` and `--build` paths with `--requests 2000 --max-p99-ms
4000 --min-rps 100`.

Measured on an Intel i9-9980HK (8 cores / 16 threads), macOS, Node 22.23.3, 5000 requests per
level after 500 warm-up requests, load generator on the same machine, core tier (15 tools
registered per request). Ranges span two runs on a machine shared with other work (load average
4–6 during the runs):

| Tool | Concurrency | req/s | p50 | p99 | Errors |
|---|---|---|---|---|---|
| `get_all_diagrams_info` | 50 | 936–940 | 48–49 ms | 94–97 ms | 0 |
| `get_all_diagrams_info` | 200 | 1048–1094 | 168–173 ms | 313–375 ms | 0 |
| `call_endpoint` | 50 | 877–897 | 51–53 ms | 94–99 ms | 0 |
| `call_endpoint` | 200 | 972–1050 | 175–184 ms | 306–401 ms | 0 |
| `batch` (4 ops) | 50 | 678–875 | 53–61 ms | 96–197 ms | 0 |
| `batch` (4 ops) | 200 | 940–979 | 191–206 ms | 290–325 ms | 0 |
| `build_diagram` | 50 | 626–874 | 52–64 ms | 97–254 ms | 0 |
| `build_diagram` | 200 | 988–998 | 178–194 ms | 325–550 ms | 0 |

At concurrency 200 the slowest request of each run took 1.7–4.0 s, every path alike: queueing in the
single Node process, not a slower code path. Against the real StarUML 7.1.1 with extension 0.3.0
(`--live --requests 1000 --concurrency 50`, two runs each, 0 errors): `get_all_diagrams_info`
729–730 req/s, p50 67–68 ms, p99 83–85 ms; `call_endpoint` `find_elements` 690–728 req/s, p50
68–70 ms, p99 83–119 ms; `batch` of four ops 695–698 req/s, p50 72 ms, p99 86–87 ms;
`build_diagram` 620–648 req/s, p50 76 ms, p99 114–124 ms (3,000 upserts, warm-up included, of one three-class
diagram, which StarUML built once and then found complete). The generated tools' zod schemas are
built once per manifest and shared by every per-request server.

Re-run for 0.4.0 (core tier of 20 tools registered per request, loopback binding with the
`Host` check) on the same machine while other test suites kept the load average at 9–14, 5000
requests per level, 0 errors on every path: `get_all_diagrams_info` 341–480 req/s at 50 (p99
183–626 ms) and 472–562 at 200; `call_endpoint` 379–566 / 608–650; `batch` 517–535 / 483–594;
`build_diagram` 306–570 / 559–639. Against StarUML 7.1.1 with the extension (`--live --requests
1000 --concurrency 50`, 0 errors): `get_all_diagrams_info` 273 req/s, p99 362 ms;
`call_endpoint` 463 req/s, p99 184 ms; `batch` 482 req/s, p99 139 ms. These runs shared the CPU,
so they show the paths still finish without errors under load rather than a regression against
the table above.

### HTTP sessions (#14)

Stateless against one session, same build, runs interleaved (stateless, session, stateless,
session) so both modes share the machine's state. 5000 requests per level after 500 warm-up
requests, stub upstream, Node 22.23.3 on the i9-9980HK above; the machine ran other agents' test
suites at a load average of 16–35, so absolute numbers are low and the ratio is what carries
over. Ranges span the two runs of each mode, 0 errors throughout:

| Tool | Concurrency | Stateless req/s | Session req/s | Stateless p99 | Session p99 |
|---|---|---|---|---|---|
| `get_all_diagrams_info` | 50 | 187–299 | 781–1148 | 624–817 ms | 78–120 ms |
| `get_all_diagrams_info` | 200 | 371–376 | 719–1033 | 1848–2741 ms | 403–698 ms |
| `call_endpoint` | 50 | 300–481 | 481–1403 | 225–784 ms | 64–257 ms |
| `call_endpoint` | 200 | 470–488 | 1078–1770 | 956–3235 ms | 173–1045 ms |
| `batch` (4 ops) | 50 | 326–596 | 1241–1341 | 142–538 ms | 61–68 ms |
| `batch` (4 ops) | 200 | 543–659 | 1508–1601 | 553–1647 ms | 194–785 ms |
| `build_diagram` | 50 | 387–577 | 512–1473 | 149–441 ms | 61–298 ms |
| `build_diagram` | 200 | 549–651 | 1695–1791 | 548–655 ms | 175–390 ms |

In a session a request no longer builds a server, registers 20 tools and connects a transport, so
throughput rises 2–4x and p99 falls by a similar factor. Against StarUML 7.1.1 with the extension
(`--live --requests 1000 --concurrency 50`, `get_all_diagrams_info`, two interleaved runs each, 0
errors): stateless 270–428 req/s, p99 152–351 ms; one session 769–898 req/s, p99 73–94 ms.

### Caching (#14)

Two caches, both shared by every session of a process:

- **Manifest compilation.** Each manifest entry's tool (its two zod schemas from the JSON Schema,
  description and annotations) is kept by the entry's JSON, 512 entries at most. Compiling the
  bundled 61-endpoint manifest takes 37 ms (median of 20 runs with an empty cache; 72 ms for the
  first, before the JIT warms up) and 1.05 ms once cached, which is `JSON.stringify` of the entries.
  `doctor`, the startup check and every fallback to the bundled manifest hit it; an entry the
  extension changed has a new key, so it is compiled again and its tool re-registered.
- **Catalogue reads.** `/introspect` answers (the `introspect` tool's sections and the
  `staruml://introspect/metamodel` resource, keyed by request body) and `describe_endpoints`
  answers are kept until the catalog changes: `doctor`, which reads the manifest again, or a tier
  switch. Failed reads are not kept, concurrent reads of one key share a single request, and 64
  entries at most are held. StarUML and the extension only change these by restarting, after which
  `doctor` (which the skill runs first) refreshes them.

`tests/cache.test.ts` shows repeated calls answering from the cache (one `/introspect` request for
repeated tool calls, resource reads from two sessions and the matching tool call) and each
invalidation path.

### Soak

`scripts/soak-test.mjs` starts `dist/index.js` over stdio against the stub, makes 2,000 warm-up
calls, then 2,000 measured calls rotating `get_all_diagrams_info`, `call_endpoint`, a two-op `batch`
and `build_diagram`, and fails when the mean RSS, the live heap after a full GC or the p99 latency
of the last 200 calls exceeds the first 200 by more than 25%, or any call fails; a p99 increase must
also exceed 2 ms to count, since the p99 of 200 calls of about 1 ms is their second slowest and
doubles on one scheduler stall. The live workflow runs it.

Three runs on the machine above (load average 21–27), 0 errors:

| Window | RSS | Live heap after GC | p50 | p99 |
|---|---|---|---|---|
| first 200 | 150.0–156.6 MB | 21.4–21.6 MB | 0.66–0.94 ms | 1.34–1.61 ms |
| last 200 | 159.9–162.8 MB | 22.2–22.3 MB | 0.54–0.68 ms | 1.14–1.35 ms |
| growth | 3.9–8.3% | 2.8–4.0% | | −14 to −18% |

Without warm-up (`--warmup 0`) RSS grows 51% (104 to 157 MB) over the first 2,000 calls while the
live heap grows 5% (20.5 to 21.6 MB); over 20,000 calls the heap after GC stays at 19–22 MB and RSS
levels off near 200 MB after about 8,000. The growth is V8 sizing its heap spaces, not retained
objects, which is why the measured windows follow a warm-up.

## Token efficiency

`scripts/token-benchmark.mjs` (`npm run benchmark:tokens`) replays four modelling scenarios
through the MCP in-memory transport against the test stand-ins for ports 58321/58322, so it runs
offline. Upstream responses are shaped like StarUML 7.1.1 + extension 0.3.0 output (element
summaries; the command list is the 322 ids captured from 7.1.1 in `scripts/benchmark-data/`). Four
servers see the same data: `56864ca` (before issue #5), `0cfc06b` (issue #5, the last hand-written
tool set, 21 tools), `45bedd4` (phase 2a, one tool per manifest endpoint, 34 tools) and the current
one with the default core tier (20 tools). The first three are loaded with `git show` and run on
the current dependencies (zod 4 lists schemas about 100 tokens shorter than zod 3 did, so #5's
definitions measure 1831 here, 1930 when it was committed). When a step's tool is not listed, the
scenario calls it through `call_endpoint` and first asks `describe_endpoints` for every such
endpoint it uses, in one call that is counted. The two native-diagram scenarios are one
`build_diagram` call from a spec on a server that lists it, which is what the endpoint is for, and
one call per element on the others; "now batch" replays the current server with every creation in
one `batch` call instead, for comparison. Both use `export_diagram` for the preview and keep the
`save_project` step every server makes. Tokenizer: `o200k_base` from `gpt-tokenizer`; image bytes
are excluded, since they are the same on every side and billed as vision input.

Two accountings, side by side:

- **(a) per scenario**: the tool definitions a client forwards to the model (name, description,
  input schema) and the server instructions once per scenario, plus the text of every result. This
  is how the issue #5 baseline was measured; clients resend the definitions with every turn, so one
  copy per scenario is the conservative floor.
- **(b) per session with prompt caching**: the definitions and instructions once for the whole
  session of four scenarios, then for every call its result text and the call itself (tool name
  and JSON arguments, which the model writes as output tokens). A client that caches its prompt
  prefix sends the fixed tool list once and reads it from the cache at a fraction of the price after
  that, so this is closer to how sessions are billed.

| | pre-#5 | #5 | phase 2a | now batch | now (core) |
|---|---|---|---|---|---|
| Tools listed | 21 | 21 | 34 | 20 | 20 |
| Definitions + instructions | 3011 | 1831 | 6154 | 1992 | 1992 |

(a) Definitions once per scenario, plus results:

| Scenario | Calls before / now | pre-#5 | #5 | phase 2a | now batch | now | vs pre-#5 | vs #5 |
|---|---|---|---|---|---|---|---|---|
| Mermaid class diagram + preview | 4 / 4 | 3197 | 1951 | 6274 | 2112 | 2112 | −33.9% | +8.3% |
| Native use-case diagram | 11 / 2 | 3982 | 2497 | 6820 | 3723 | 2332 | −41.4% | −6.6% |
| Inspect and refactor a class model | 8 / 8 | 6227 | 4234 | 8557 | 4598 | 4598 | −26.2% | +8.6% |
| Native class diagram + export | 11 / 3 | 3917 | 2458 | 6781 | 3742 | 2355 | −39.9% | −4.2% |
| All scenarios | 34 / 17 | 17323 | 11140 | 28432 | 14175 | 11397 | −34.2% | +2.3% |

(b) Definitions once per session, plus results and calls:

| Scenario | pre-#5 | #5 | phase 2a | now batch | now | vs pre-#5 | vs #5 |
|---|---|---|---|---|---|---|---|
| Mermaid class diagram + preview | 282 | 216 | 216 | 216 | 216 | −23.4% | 0.0% |
| Native use-case diagram | 1490 | 1185 | 1185 | 2223 | 449 | −69.9% | −62.1% |
| Inspect and refactor a class model | 3369 | 2556 | 2556 | 2805 | 2805 | −16.7% | +9.7% |
| Native class diagram + export | 1434 | 1155 | 1155 | 2259 | 496 | −65.4% | −57.1% |
| Definitions, once | 3011 | 1831 | 6154 | 1992 | 1992 | | |
| Session | 9586 | 6943 | 11266 | 9495 | 5958 | −37.8% | −14.2% |

Targets of issues #5 and #8, under each accounting:

| Target | (a) per scenario | (b) per session |
|---|---|---|
| #5 / #8: 60% below pre-#5, first three scenarios | not met: 9042 against ≤ 5362 (−32.6%) | not met: 5462 against ≤ 3260 (−33.0%) |
| #5 / #8: 60% below pre-#5, all four scenarios | not met: 11397 against ≤ 6929 (−34.2%) | not met: 5958 against ≤ 3834 (−37.8%) |
| #8: core definitions ≤ 2,000 | met: 1992 | met: 1992 |
| #8: all scenarios below #5 | not met: 11397 against 11140 (+2.3%) | met: 5958 against 6943 (−14.2%) |

`build_diagram` does what it is for: a native diagram costs 449 and 496 tokens of results and calls
(the spec it is given included), against 1185 and 1155 for #5's one call per element and 2223 and
2259 for one `batch`, whose ops repeat every parent and diagram id and need `describe_endpoints` for
four endpoint schemas. Under (a) that saving is hidden by the definitions, counted four times
(7968 of 11397 tokens); under (b) the session is 14.2% below #5 and 37.8% below pre-#5. What keeps
(b) above the 60% target is the fixed definitions (1992, a third of the session) and the refactor
scenario, whose `get_all_commands` result alone is 1947 tokens of the 322 command ids; neither is
touched by diagram building. `--tools all` lists 68 tools for 9136 tokens (all scenarios (a)
39638, (b) 12675). Generated descriptions stay one line of at most 100 characters (a test enforces
it on every listed tool), and a test keeps the core listing within 2,000 tokens.

### Reading a diagram back

A fifth scenario, "read and explain a diagram", runs on the current server only and compares the
ways to read one diagram: five classes and an enumeration with 13 attributes, 5 operations and 4
literals, and five relationships (two associations with multiplicities, one of them named, a
composition, a directed association and a dependency). The upstream answers are what StarUML 7.1.1 and the extension
returned for it, recorded by `scripts/capture-read-diagram.mjs` into
`scripts/benchmark-data/read-diagram-7.1.1.json`. Each read is one call; the table counts the call,
its result text and, for the PNG, an estimate of its image tokens (width × height / 750 after
Anthropic's downscaling to 1568 px on the long edge and about 1,600 tokens; the 1382×1342 PNG is
scaled down, so its member text arrives smaller than StarUML drew it).

| Read | Call | Result text | Image (est.) | Total | vs PNG |
|---|---|---|---|---|---|
| PNG (`get_diagram_image_by_id`) | 29 | 0 | 1600 | 1629 | |
| Element dump (`find_elements`, `summary: false`, `depth: 2`) | 27 | 4425 | 0 | 4452 | +173.3% |
| `describe_diagram` | 26 | 260 | 0 | 286 | −82.4% |
| `diagram_as_text` (Mermaid) | 25 | 242 | 0 | 267 | −83.6% |
| `diagram_as_text` (PlantUML) | 30 | 253 | 0 | 283 | −82.6% |

What each carries for an explanation: the PNG has the layout and nothing machine-readable; the
element dump has every saved attribute and the ids, but relationships are association ends that
reference classes by id; `describe_diagram` has the members and every edge with its type and
name, but not multiplicities, aggregation or navigability; Mermaid and PlantUML have all of that
in a notation the model already reads, and the Mermaid can be edited and rebuilt with
`build_diagram`. Reading the diagram as Mermaid instead of a PNG saves about 1,360 tokens per read,
and about 4,190 against the dump.

## Architecture

```
AI Agent (Claude Code / Cursor / VS Code / …)
        │
        │  MCP (stdio or Streamable HTTP)
        ▼
  staruml-mcp  (this package)
        │
        │  HTTP JSON (POST /<endpoint>)
        ├──────────────────────────────┐
        ▼                              ▼
StarUML API Server (58321)     staruml-mcp-extension (58322)
  4 hand-written tools           POST /introspect → manifest → core tools +
        │                              │   describe_endpoints / call_endpoint
        │                              │   (bundled snapshot when unreachable)
        ▼                              ▼
           StarUML Application (v7+)
```

## Acknowledgments

Inspired by [`staruml/staruml-mcp-server`](https://github.com/staruml/staruml-mcp-server) (official stdio-only server by Minkyu Lee, StarUML creator). This project reimplements it with multi-transport support and strict TypeScript.

## License

[MIT](LICENSE) © Ezra Brilliant Konterliem
