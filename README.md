# staruml-mcp

[![npm version](https://img.shields.io/npm/v/staruml-mcp.svg)](https://www.npmjs.com/package/staruml-mcp)
[![npm downloads](https://img.shields.io/npm/dm/staruml-mcp.svg)](https://www.npmjs.com/package/staruml-mcp)
[![CI](https://github.com/ezrabrilliant/staruml-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ezrabrilliant/staruml-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io/)

Model Context Protocol (MCP) server for [StarUML](https://staruml.io). Lets AI agents (Claude Code, Cursor, VS Code Copilot, Codex) drive StarUML programmatically — generate UML diagrams from Mermaid, build native models and diagrams element by element, execute any built-in command, save projects, and more.

## How it fits together

```
  AI Agent  ──MCP──►  staruml-mcp (this package)  ──HTTP──►  StarUML
                                                  :58321 (built-in, 4 tools)
                                                  :58322 (extension 0.3.x, 56 endpoints
                                                          from its manifest: core ones as
                                                          tools, the rest via call_endpoint)
```

| Package | What it is | Where it runs |
|---|---|---|
| **`staruml-mcp`** (this repo) | MCP server for AI agents | your machine via `npx -y staruml-mcp` |
| **[`staruml-mcp-extension`](https://github.com/ezrabrilliant/staruml-mcp-extension)** 0.3.x | StarUML plugin adding 56 HTTP endpoints and a manifest of them (`POST /introspect`) | inside StarUML (install once via Extension Manager) |

- Using only Mermaid-based diagram tools? Install `staruml-mcp` only. The 4 built-in tools, `doctor` and `view_diagram` (as a PNG) work.
- Want the extension's 56 endpoints (whole diagrams from a spec or Mermaid in one call, project save/open, element CRUD, relationships, attributes and operations, view layout and styling, export, undo, batches, code generation, any StarUML command)? Install **both**.

## Prerequisites

- **StarUML v7.0.0+** with API Server enabled (see below)
- **Node.js 20+** on the machine running the AI agent
- **(Optional)** [`staruml-mcp-extension`](https://github.com/ezrabrilliant/staruml-mcp-extension) 0.3.x installed in StarUML — required for every tool except the 4 built-in ones and `doctor`

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

## Install & Use

### Claude Code (recommended — HTTP transport)

Start the server in a terminal:
```bash
npx -y staruml-mcp --transport http
# listens on http://localhost:58323/mcp by default
```

Register with Claude Code:
```bash
claude mcp add --transport http staruml http://localhost:58323/mcp
```

> **Port `58323`** is the canonical HTTP port, chosen to sit alongside StarUML's built-in API (`58321`) and `staruml-mcp-extension` (`58322`). Override with `--port <n>` if needed.

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
claude plugin marketplace add ezrabrilliant/staruml-mcp
claude plugin install staruml@staruml
# or from a clone: claude --plugin-dir ./plugins/claude-code

# Codex CLI (skill only; add the MCP server as above)
codex plugin marketplace add ezrabrilliant/staruml-mcp
codex plugin add staruml@staruml

# GitHub Copilot CLI (skill only)
copilot plugin marketplace add ezrabrilliant/staruml-mcp
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
      --api-port <number>  StarUML built-in API port (default: 58321)
      --ext-port <number>  staruml-mcp-extension port(default: 58322)
      --ext-token <token>  extension access token    (env STARUML_EXT_TOKEN)
      --api-host <url>     StarUML API host prefix   (default: http://localhost)
      --doctor             Check the setup, print a report and exit (1 on failure)
      --tools <tiers>      core | all | comma list   (default: core; env STARUML_MCP_TOOLS)
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
manifest     ok    56 endpoints from the live manifest
tier         ok    core: 8 extension tools listed, 48 endpoints through call_endpoint
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
| `view_diagram` | Show a diagram (default the current one): an interactive SVG viewer in clients that render MCP Apps, the `get_diagram_image_by_id` PNG otherwise ([below](#inline-viewer-mcp-apps)). The SVG comes from the extension. |
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
| `core` (default) | the 6 above; `introspect` (summary), `find_elements`, `get_element_by_id`, `update_element`, `delete_element`, `batch`, `build_diagram`, `export_diagram`; `describe_endpoints`, `call_endpoint` | 1,992 |
| `all` | the 6 above and one tool per manifest endpoint | 9,322 |
| `core,create_diagram,…` | the 6 above and the named endpoints (`core` expands as above); `describe_endpoints`, `call_endpoint` while any endpoint is left out | |

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

### Extension tools (require [`staruml-mcp-extension`](https://github.com/ezrabrilliant/staruml-mcp-extension) 0.3.x, port 58322)

These tools are not written by hand. The extension publishes a manifest from `POST /introspect`:
each endpoint's name, description, read-only and destructive flags, and JSON Schemas for request
and response. On start, and whenever `doctor` runs, the server reads it and registers one tool per
endpoint:

- **name** is the path without `/` (`/find_elements` → `find_elements`);
- **description** is the endpoint description cut to the sentences that fit in 100 characters,
  on one line;
- **input schema** is the endpoint's request schema converted with zod's `fromJSONSchema` and
  listed back by the MCP SDK without the `$schema` URL the SDK would add, otherwise unchanged
  except that the projection parameters (`summary`,
  `fields`, `depth`) and the shared `properties` description are shortened, and tools that write
  accept the projection without listing it (the instructions explain it once);
- **annotations**: `readOnlyHint` from the manifest's `readOnly`, `destructiveHint` from
  `destructive` (stated for every writing tool, since MCP defaults it to true),
  `openWorldHint: false`.

A copy of the 0.3.0 manifest (56 endpoints) is bundled (`src/extension-manifest.json`), so `tools/list` is
complete while StarUML is closed; calls then fail with `EXTENSION_UNREACHABLE` and an install hint.
`npm run sync:manifest` refreshes the copy from a running extension (`-- --url <base>`) or from a
recorded `/introspect` response (`-- --from <file>`). When the running extension's version is
incompatible (another major version, or another minor version while it is 0.x), the server lists no
extension tools at all and the startup report and `doctor` say which version to install.

With extension 0.3.0 (each a tool under `--tools all`, otherwise a `call_endpoint` name unless in
the core tier):

| Endpoint | Does |
|---|---|
| `build_diagram` | A whole diagram in one call and one undo step, from a compact spec per kind (class, sequence, usecase, activity, statemachine, erd, flowchart, mindmap) or from Mermaid; laid out, optionally upserted into the diagram of the same name; answers the model and view ids by node name. |
| `get_all_commands` / `describe_commands` / `execute_command` | List command ids / their arguments and whether they open a dialog / run any StarUML command. |
| `get_project_info` / `new_project` / `open_project` / `save_project` / `save_project_as` | Project lifecycle. |
| `get_element_by_id` / `find_elements` | Read elements; `find_elements` pages with `limit`/`cursor`. |
| `create_element` / `update_element` / `delete_element` | Model elements without views; `update_element` sets, adds, removes, reorders or relocates. |
| `create_element_with_view` / `create_edge_with_view` / `create_relationship` | Elements and relationships drawn on a diagram; `create_relationship` also sets association ends. |
| `add_attribute` / `add_operation` / `add_parameter` / `add_enumeration_literal` / `add_template_parameter` / `add_slot` / `add_tag` | Features of classifiers and instances. |
| `set_stereotype` / `set_documentation` | Common element properties. |
| `create_diagram` / `switch_diagram` / `close_diagram` | Diagrams. |
| `get_views_of` / `get_edge_views_of` / `get_relationships_of` / `get_refs_to` / `get_connected_node_views` | Lookups between models, views and relationships. |
| `layout_diagram` / `move_views` / `resize_node` / `set_view_style` / `set_z_order` | Arrange and style views. |
| `get_selection` / `set_selection` / `get_editor_state` / `set_editor_state` | Selection, current diagram, zoom and grid. |
| `export_diagram` / `export_diagrams` / `export_pdf` / `export_html` | Diagram as PNG, JPEG or SVG (inline or to a file) / many diagrams into a directory / PDF / HTML docs. |
| `list_code_generators` / `generate_code` / `reverse_code` | Installed language generators and their options / source code from a model element / a source directory into the model. |
| `undo` / `redo` / `is_modified` | History and unsaved state. |
| `batch` | Several calls in one request, by default one undo step that rolls back when an op fails. |
| `introspect` / `debug` | Versions, factory ids, metamodel, toolbox and manifest (the `introspect` tool is the summary) / the raw `app` surface. |

To enable extension tools: install `staruml-mcp-extension` in StarUML (Tools → Extension Manager → Install From URL → `https://github.com/ezrabrilliant/staruml-mcp-extension`).

### Results

Tool results are minified JSON. Properties that are `null`, `[]` or `{}` are dropped from every
object, top-level properties that repeat an argument (such as the `filename` passed to
`save_project`) are dropped, and a call with nothing left to report returns `ok`. A missing
property therefore means null or empty. `get_current_diagram_info` returns `null` when no diagram
is active.

Elements come back as the extension's summaries, `{_id, _type, name, _parent}`; references and
owned elements are `{$ref: id}`. Every tool that returns elements accepts `fields` (attribute
names), `summary: false` (every saved attribute) and `depth` (levels of owned elements to expand),
and `find_elements` pages with `limit` and `cursor` (`nextCursor` is absent on the last page). The
`/create_*_with_view` and `/create_relationship` tools return `{view, model}`.

`batch` takes `{ops: [{path, body, as}], atomic}`. A string `"$a"` in a body stands for the id of
the result of the op named `a`, `"$a.view"` and `"$a.model"` for those of a `{view, model}` result,
a numeric segment indexes a list (`"$a.model.operands.0"`), and `"$$"` escapes a literal `$`. Before sending, the server checks every op against its endpoint's
manifest schema (a reference may stand where the schema wants another type, since its value is
only known once the batch runs) and that each reference names an earlier op; a failure is
`INVALID_ARGUMENT` with the op index, as in `ops.2.body.ownerId: …`. Each result comes back without
the op's `path` and, when it succeeded, without `success: true`. An atomic batch that fails in
StarUML is rolled back and reported with the failing op's code; the extension's
`details: {index, results}` come back in `structuredContent.error.details`, the results compacted as
above, and the text adds `Details: {"index": n}` (the results name elements the rollback removed).

`build_diagram` lists a hand-written description and six parameters (`kind`, `spec`, `mermaid`,
`name`, `upsert`, `direction`, 260 tokens); the manifest's own description of `spec` alone is ~400
tokens, so `spec` lists a one-line grammar per kind and `describe_endpoints({names:
["build_diagram"]})` serves the full one. The unlisted `parentId` and `autoLayout` are accepted, and
every body is checked against the manifest's whole request schema before it is sent, as for `batch`.

`export_diagram` lists a hand-written description and shorter parameter descriptions (147 tokens
against the manifest's 208); the colour pattern is left to the check against the whole request
schema, as for `build_diagram`. It returns a PNG or JPEG as an image content block followed by the rest of the answer
(`width`, `height`, `bytes`) as JSON; as text, the base64 of even a small diagram costs thousands of
tokens. SVG and exports written to `path` come back as JSON.

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

`resources/list` enumerates one `staruml://diagram/{id}.png` per diagram; when StarUML is not
reachable it lists only the six static resources. A failed read is a JSON-RPC error whose `data`
holds the same `error` object a failed tool call returns.

StarUML 7.1.1's `/get_diagram_image_by_id` ignores every field except `diagramId` (`scale`,
`maxWidth`, `width` and `format` return identical bytes; the live suite checks this), so the
image tool and resource offer no size options.

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
  returns, from StarUML's built-in API, for `id` or the current diagram.

The stateless HTTP transport builds a fresh server per request, which never sees the client's
`initialize` or its resource reads, so over `--transport http` `view_diagram` always answers the
PNG; the viewer needs stdio (Claude Desktop, Claude Code with a command) until the HTTP transport
keeps sessions.

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
git clone https://github.com/ezrabrilliant/staruml-mcp.git
cd staruml-mcp
npm install            # also installs the pre-commit hook (lint-staged: eslint + prettier)
npm run dev            # tsx watch on src/
npm run build          # bundle to dist/
npm test               # vitest: unit, tool-level and HTTP transport tests
npm run test:coverage  # same, failing below 100% lines/branches/functions/statements
npm run test:live      # STARUML_LIVE=1: every tool and endpoint against a running StarUML + extension
npm run load-test      # HTTP transport load test (needs npm run build)
npm run benchmark:tokens # token cost of four scenarios under two accountings, current vs. 56864ca, 0cfc06b and 45bedd4
npm run sync:manifest  # refresh src/extension-manifest.json from a running extension
npm run typecheck      # tsc --noEmit for src and tests
```

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
this server and a local StarUML does not change them. Every request builds a fresh `McpServer`
(stateless mode), which dominates the cost. Any failed request makes the script exit non-zero;
`--max-p99-ms` and `--min-rps` add budgets, and CI runs the default, `--batch` and `--build` paths
with `--requests 2000 --max-p99-ms 2000 --min-rps 100`.

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

## Token efficiency

`scripts/token-benchmark.mjs` (`npm run benchmark:tokens`) replays four modelling scenarios
through the MCP in-memory transport against the test stand-ins for ports 58321/58322, so it runs
offline. Upstream responses are shaped like StarUML 7.1.1 + extension 0.3.0 output (element
summaries; the command list is the 322 ids captured from 7.1.1 in `scripts/benchmark-data/`). Four
servers see the same data: `56864ca` (before issue #5), `0cfc06b` (issue #5, the last hand-written
tool set, 21 tools), `45bedd4` (phase 2a, one tool per manifest endpoint, 34 tools) and the current
one with the default core tier (16 tools). The first three are loaded with `git show` and run on
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
| Tools listed | 21 | 21 | 34 | 16 | 16 |
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
touched by diagram building. `--tools all` lists 62 tools for 9322 tokens (all scenarios (a)
40382, (b) 12861). Generated descriptions stay one line of at most 100 characters (a test enforces
it on every listed tool), and a test keeps the core listing within 2,000 tokens.

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
