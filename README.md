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
                                                  :58322 (extension 0.3.x, 103 endpoints
                                                          from its manifest: core ones as
                                                          tools, the rest via call_endpoint)
```

| Package | What it is | Where it runs |
|---|---|---|
| **`staruml-mcp`** (this repo) | MCP server for AI agents | your machine via `npx -y staruml-mcp` |
| **[`staruml-mcp-extension`](https://github.com/hqqw2h-lgtm/staruml-mcp-extension)** 0.3.x | StarUML plugin adding 103 HTTP endpoints and a manifest of them (`POST /introspect`) | inside StarUML (install once via Extension Manager) |

- Using only Mermaid-based diagram tools? Install `staruml-mcp` only. The 4 built-in tools, `doctor` and `view_diagram` (as a PNG) work.
- Want the extension's 103 endpoints (whole diagrams from a spec or Mermaid in one call, 29 diagram kinds from class and sequence to SysML, BPMN, timing, wireframes and AWS/Azure/GCP, models from an object spec with every diagram derived from them, a project style profile and a quality loop that scores and re-lays out diagrams, elements addressed by path instead of id, diagram and UML lint with fixes, diffs and snapshots, diagrams read back as Mermaid, PlantUML or a text summary, type search, model validation, project save/open, element CRUD, relationships, attributes and operations, layout presets and edge routing, styling, export, undo, batches, code generation, quick find, preferences, templates, model fragments, XMI, any StarUML command)? Install **both**.

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
`build_diagram` spec of each diagram kind with an example, a section per diagram family
(composite structure, object, communication, timing, interaction overview, information flow,
profile, DFD, SysML block, internal block and parametric, BPMN, wireframe, AWS, Azure, GCP) with
an example and the spec read-back, the build and lint loop, model first
(`build_model` with the relationship verbs, responsibilities as documentation), design patterns
with every property they prescribe (`apply_pattern` bound by path, `detect_patterns` to
confirm), when Mermaid goes where, `batch` and its
`$name` references, `describe_endpoints` / `call_endpoint`, viewing and exporting, the project
features (`quick_find`, metadata, preferences, templates, editor tabs, fragments, XMI,
`performance_stats`), keeping tokens down, and the access token. The Claude Code plugin also registers this server over stdio
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
      --tools <tiers>      core | oo | all | comma list (default: core; env STARUML_MCP_TOOLS)
      --allow-tier-switch  let doctor({tools}) widen the tier (env STARUML_MCP_ALLOW_TIER_SWITCH=1)
      --image-max-width <px>  widest inline image, 0 = none (default: the profile's page width;
                           env STARUML_MCP_IMAGE_MAX_WIDTH)
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
manifest     ok    103 endpoints from the live manifest
tier         ok    core: 10 extension tools listed, 93 endpoints through call_endpoint
```

A failing check is followed by a `fix` line: start StarUML, enable `apiServer` in StarUML's
`settings.json`, install the extension from its URL, or restart StarUML. The `doctor` tool runs the
same check for an agent; `doctor({tools: "all"})` also switches the listed tier, within what the
server was started with (see the `oo` tier below).

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
| `view_diagram` | Show `diagram` (an id or a path; default the current one): an interactive SVG viewer in clients that render MCP Apps, a PNG otherwise ([below](#inline-viewer-mcp-apps)), no wider than the image cap ([Image size](#image-size)). `path` (absolute; `.svg`, `.jpg`/`.jpeg`, anything else PNG) writes the image to that file instead and answers its path, pixel size and bytes; `maxWidth` (pixels, 0 for full size, accepted but unlisted) overrides the cap for one call. `annotate: "paths"` or `"ids"` labels every view with its element on the picture (never on the model). Since `path` writes files, the tool is annotated as not read-only. |
| `diagram_as_text` | `diagram` (an id or a path; default the current one) as Mermaid, or PlantUML with `format: "plantuml"`, or with `format: "spec"` as the `build_diagram` spec of the sixteen diagram families neither has (sent on one line), through the extension's `export_text`: the text in a block of its own, then `{id?, kind, warnings?}`. Each is a form `build_diagram` reads back. |
| `doctor` | Check Node, both StarUML ports, the extension and StarUML versions; reloads the extension's tools and, given `tools`, switches the tier. |

### generate_diagram routing

StarUML 7.1.1's built-in `/generate_diagram` names every diagram "<Kind> Diagram by Mermaid", keeps
`<br/>` as text, cannot draw activity or use case diagrams, and refuses front matter, a leading
`%%` comment and the `graph` keyword (upstream staruml-mcp-server issues #2, #3, #4). The tool
therefore sends the Mermaid to the extension's `build_diagram` when the call has a `name` or
`kind`, a front matter `title:` or `title` line, `<br/>` or a literal `\n`, or a start the built-in
cannot read, and the extension reads the diagram type (`classDiagram`, `sequenceDiagram`,
`flowchart`/`graph`, `erDiagram`, `stateDiagram`). It then answers `build_diagram`'s result, with
the diagram's id and name and the model and view ids of every node (it asks for `result: "ids"`,
since the extension answers counts alone by default); otherwise the built-in renders
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
| `core` (default) | the 7 above; `find_elements`, `quick_find`, `get_element_by_id`, `update_element`, `batch`, `build_diagram`, `export_diagram`, `build_model`, `diagram_quality`, `improve_diagram`; `describe_endpoints`, `call_endpoint` | 1,998 |
| `oo` | model-first only: `build_model`, `derive_diagrams`, `explain_model`, `model_lint`, `apply_pattern`, `detect_patterns`, `validate_model`, `diagram_quality`; `view_diagram`, `diagram_as_text`, `doctor`; `describe_endpoints`, `call_endpoint` | 1,217 |
| `all` | the 7 above and one tool per manifest endpoint | 14,385 |
| `core,create_diagram,…` | the 7 above and the named endpoints (`core` expands as above); `describe_endpoints`, `call_endpoint` while any endpoint is left out | |

Token counts include the server instructions (o200k_base, extension 0.3.0 with 103 endpoints, `npm run
benchmark:tokens`). 0.6.0 added `build_model` and `apply_pattern` (237 tokens) to the core tier
and, to stay under 2,000, moved four endpoints out: `introspect` (`doctor` reports the versions),
`describe_diagram` (`diagram_as_text`, always listed, reads a diagram in as many tokens),
`validate_model` (a final check that sits with `uml_lint` in the `quality` group) and
`search_types` (the spec tools take names, not metamodel ids). 0.7.0 added the quality loop,
`diagram_quality` and `improve_diagram` (130 tokens), and moved `lint_diagram` out (70):
`improve_diagram` applies its autofixes in its loop and `diagram_quality` reports what it still
finds by rule. `update_element`'s `op`, `export_diagram`'s `format` and `generate_diagram`'s `kind`
list their values in the description only (the request schemas still check them), which paid for
the rest. 0.8.0 lists `build_diagram`'s `kind` with the manifest's enum, now 29 kinds (111 tokens),
and adds `quick_find` (51); `apply_pattern` (112) moves to the `patterns` group, still listed by
the `oo` tier and reached by the `apply-pattern` prompt through `call_endpoint`, and
`delete_element` (53) leaves too, a deletion being one `batch` op or `call_endpoint` away.
`--tools core,lint_diagram,search_types,describe_diagram,validate_model,apply_pattern,delete_element`
lists them again. 0.9.1 lists `explain_model`'s `sections` and `cursor` and `detect_patterns`'
`minConfidence` under `oo` (98 tokens, which the tier's 1,500 budget has room for); the core tier
paid for `diagram_quality`'s `failures` and `build_model`'s `detail` hint with shorter
`build_diagram` lines and stays at 1,998. Pick the tier with `--tools`, or `STARUML_MCP_TOOLS` for clients that pass
environment but no arguments; the flag wins. An agent can change it at runtime with
`doctor({tools: "all"})`; the server then sends `notifications/tools/list_changed`, as it does when
`doctor` finds a manifest with other endpoints. Names that are neither endpoints nor tools are
reported by the `tier` check.

The tier is fixed at launch (issue #19): `doctor({tools})` may only narrow what the server
reaches. From an open tier (`core`, `all`, a list without `oo`) every endpoint is reachable through
`call_endpoint` anyway, so any change is taken; from `oo` a selection that reaches an endpoint or
lists a tool the current one does not (`core`, `all`, `oo,move_views`, an open list) is refused
with `TIER_LOCKED` before anything is read, and narrowing is one-way. `--allow-tier-switch` (or
`STARUML_MCP_ALLOW_TIER_SWITCH=1`) lifts this for a user who wants an agent to switch freely;
`doctor`'s schema says which rule applies. A property test (`tests/properties.test.ts`) drives
random sequences of `doctor` selections from random launch tiers and checks that each step
reaches at most what the one before it did.

The **`oo` tier** (issue #17) is for object-first authoring: the agent states the domain as
objects and the extension derives and lays out every diagram, so nothing in the tier draws. Its
guarantees are structural, not advice in a prompt: only the tools above are listed, the
hand-written ones included (`generate_diagram` and the built-in image and diagram tools are
disabled); `call_endpoint` and `describe_endpoints` reach model-level endpoints only (reads,
elements, members, relationships without views, history, patterns, `uml_lint`, the style
profile's read side, `apply_style_profile`, `improve_diagram`, saving and exporting) and answer
`NOT_IN_TIER` (whose hint names the model-first way, `build_model`, `derive_diagrams`,
`improve_diagram`, and never a way out of the tier) for everything that places, sizes or colours views (`build_diagram`,
`create_*_with_view`, `layout_diagram`, `move_views`, `set_view_style`, ...), for `batch` and
`execute_command`, which could run those, and for `set_style_profile`, which could turn strict
mode off; `update_element` setting a view attribute (`left`, `fillColor`, `suppressAttributes`,
...) is refused the same way, and so is `override` on any endpoint the tier reaches, which
`describe_endpoints` leaves out of their schemas. Before every call that changes something (any
endpoint the manifest does not mark read-only, saves and exports included, but not `new_project`
or `open_project`), the server reads the project's style profile and, when it is not strict, sets
`strict: true` (`blockSaveOnErrors` stays as the profile has it) and reads it back; a profile it
cannot make strict refuses the call with `PROFILE_NOT_STRICT` and nothing is sent (issue #19).
The read costs one local request per change; a session-wide flag would miss an `undo`, a
`restore_snapshot`, another project or another client turning strict off. With the profile strict
the extension refuses the drawing endpoints itself (`STYLE_LOCKED`), so a client that bypasses
this server cannot draw either, and the only way past `STYLE_LOCKED` is `override`, which the
tier does not expose. `build_model`'s strict spec refuses geometry and colour. `oo,save_project` adds a
name to the tier; `oo` with `core` or `all` is open again. The prompts follow the tier:
`model-codebase`, which draws with `build_diagram`, is not listed under `oo`.

- **`describe_endpoints()`** returns the endpoints without a tool, grouped (`quality`: lints,
  validation, `diff_diagram` and the quality loop; `history`: snapshots, undo and redo;
  `patterns`: the pattern library, detection and presets; `model`: diagrams derived from a model,
  its text explanation, messages checked against and synced into operations; `style`: the style
  profile, themes and view styles; `project`: the file, metadata, templates, preferences, the
  extensions StarUML loads and the open editor tabs; `io`: model fragments and XMI; `perf`:
  `performance_stats`; `command`, `meta`, `feature`, `editor`, `code`, `diagram`, `element`;
  grouped by name, since the manifest has none), one line
  each. `describe_endpoints({names: [...]})` or `({group})` returns their full description, `readOnly`
  / `destructive` flags and request schema as `tools/list` would show it. Named endpoints may be
  listed ones.
- **`call_endpoint({name, body})`** checks `body` against the endpoint's request schema from the
  manifest, unknown keys included, and forwards it. A rejected body comes back as
  `INVALID_ARGUMENT`, an unknown name as `UNKNOWN_ENDPOINT`, both before any request; results and
  extension errors look exactly like those of a dedicated tool.
- **`introspect`** is a summary: StarUML and extension versions, plus `factory`, `metamodel` (narrow
  it with `types`) or `toolbox` when asked for. The endpoint manifest is left to
  `describe_endpoints` and `staruml://introspect/endpoints`. Since 0.6.0 it is outside the core
  tier (`doctor` reports both versions, `search_types` and the metamodel resource answer type
  questions); `--tools core,introspect` lists it, and `call_endpoint({name: "introspect"})`
  applies the same defaults, since the extension's own default, every section, is 522 KB.

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

A copy of the 0.3.0 manifest (103 endpoints) is bundled (`src/extension-manifest.json`), so `tools/list` is
complete while StarUML is closed; calls then fail with `EXTENSION_UNREACHABLE` and an install hint.
`npm run sync:manifest` refreshes the copy from a running extension (`-- --url <base>`) or from a
recorded `/introspect` response (`-- --from <file>`). When the running extension's version is
incompatible (another major version, or another minor version while it is 0.x), the server lists no
extension tools at all and the startup report and `doctor` say which version to install.

With extension 0.3.0 (each a tool under `--tools all`, otherwise a `call_endpoint` name unless in
the core tier):

| Endpoint | Does |
|---|---|
| `build_model` | A model without diagrams from an object-level spec, in one undo step: packages (`contexts`), classes with members and a `responsibility` that becomes their documentation, relationships named by verb (`owns` composition, `has` aggregation, `uses` dependency, `isA` generalization, `implements` realization, `knows` directed association), actors and use cases, collaborations as interactions, lifecycles as state machines; a UML word (`composition`, `generalization`, ...) as a relationship type is refused with the verb to write; `upsert` extends the model of the same name, `dryRun` names the first 20 changes of each kind by path and counts the rest (`detail: "full"` names every one). |
| `apply_pattern` / `list_patterns` / `describe_pattern` / `detect_patterns` / `apply_preset` | A design pattern (the 23 GoF and seven domain patterns, kept as data) applied to existing classes bound by path or to new ones, with every property it prescribes on elements, members and relationship ends / the library / one pattern's roles and properties / instances found in the model by structure at or above `minConfidence` (default 0.8), with a confidence and what is missing / a kind's properties (value object, entity, immutable, ...) on one class. |
| `derive_diagrams` / `explain_model` / `model_lint` | Every diagram a model implies, by rule, in one undo step: a package overview, class diagrams per class view or package, a sequence diagram per collaboration, use case diagrams, a state machine per lifecycle, and the activities, ERD, C4 containers, deployments and feature mind map `build_model` stored with the model; each laid out by the style profile and run through the quality loop; again after a model change, it updates them in place / the model as compact text to reason about, by section (`sections`: summary, classes, collaborations, lifecycles, useCases, views); a cut answer ends with a line naming the section and the `cursor` that reads on / design review: god classes, feature envy, cyclic packages, anaemic entities, single-implementation interfaces, unused classes, uncalled operations, each with a fix line. |
| `get_style_profile` / `set_style_profile` / `apply_style_profile` / `explain_style_violation` | The project's style profile (naming rules, visuals, layout presets, quality thresholds, `strict`, `blockSaveOnErrors`; built-ins `uml-standard`, `minimal`, `presentation`, `print`) / store one, a built-in or a patch / bring existing names and views in line with it / which rule an element breaks, or whether a name would pass, with a fix. |
| `diagram_quality` / `improve_diagram` | A diagram's score 0–100 from its geometry (overlap, edges through nodes, crossings, length variation, bends, alignment, whitespace, aspect, page size) against the profile's target / the quality loop on an existing diagram in one undo step: the profile's layout preset, post-processing, lint autofixes, each step kept only when it raises the score. |
| `sync_operations` / `check_messages` / `describe_type` / `apply_theme` | Add the operations a sequence diagram's messages name to their receivers / list the messages that name none / a metamodel type's properties and their UML meaning / colour a diagram by a theme preset. |
| `build_diagram` | A whole diagram in one call and one undo step, from a compact spec per kind (class, sequence, usecase, activity, statemachine, erd, flowchart, mindmap, requirement, c4, package, component, deployment, and the sixteen families composite, object, communication, timing, overview, infoflow, profile, dfd, bdd, ibd, parametric, bpmn, wireframe, aws, azure and gcp, which share one shape of typed nodes nested with `in` and typed edges) or from Mermaid, PlantUML, SQL DDL or JSON Schema text; laid out with a `layout` preset (default by kind), optionally upserted into the diagram of the same name (`prune` deletes what the spec lacks); elements named like existing ones are shown again, not copied (`reuse`); `dryRun` answers the plan and changes nothing; answers the diagram and counts, with `result: "ids"` the model and view ids by node name. |
| `lint_diagram` / `uml_lint` | How a diagram reads (stacked, overlapping or off-canvas views, edges through nodes, names wider than their box, unconnected nodes, crowding), each finding with an `autofix` request / modelling mistakes StarUML's validation skips (association ends without multiplicity or navigability, untyped attributes, abstract classes without subclasses, unrealized interfaces, messages naming no operation, use cases without actors, state machines without initial or final state, entities without a key, naming conventions), each with a fix line. |
| `diff_diagram` / `snapshot` / `diff_since` / `restore_snapshot` | What a spec or diagram text would change on a diagram / a model checkpoint / what changed since one / undo back to one in a single step. |
| `create_view_of` / `divide_fragment` | Show an existing element on another diagram / set where a combined fragment's operands begin. |
| `export_text` / `describe_diagram` | A diagram as Mermaid or PlantUML, or a family's diagram as its `build_diagram` spec (`format: "spec"`), each a form `build_diagram` reads back, with warnings for what the text cannot carry / a bounded text summary of its nodes, members and edges. |
| `search_types` / `validate_model` | Fuzzy search over metamodel types, palette items, relationship kinds and commands, each hit with an example request / StarUML's validation rules over the open model, problems with element and rule ids. |
| `get_all_commands` / `describe_commands` / `execute_command` | List command ids / their arguments and whether they open a dialog / run any StarUML command. |
| `get_project_info` / `new_project` / `open_project` / `save_project` / `save_project_as` | Project lifecycle. |
| `get_project_metadata` / `set_project_metadata` / `list_templates` / `new_from_template` | The project's name, author, company, copyright, version and documentation / the File > New From Template projects / a new project from one. |
| `get_preference` / `set_preference` / `list_extensions` | A StarUML preference with its default and type / change one (view, editor, theme, validation and the diagram extensions' defaults; never who may call the server) / the extensions StarUML loads and the commands each adds. |
| `export_fragment` / `import_fragment` / `export_xmi` / `import_xmi` | An element and what it owns to a `.mfj` file / one read into any project / XMI 2.1 out and in through the staruml-xmi extension (`NOT_FOUND` without it). |
| `list_working_diagrams` / `close_diagrams` / `performance_stats` | The open editor tabs / close several / the write path's counters: listeners per event, undo depth, elements, tabs, heap. |
| `get_element_by_id` / `find_elements` / `quick_find` | Read elements; `find_elements` pages with `limit`/`cursor`; `quick_find` finds a text in names, documentation and tag values, in any case, as Edit > Find does. |
| `create_element` / `update_element` / `delete_element` | Model elements without views; `update_element` sets, adds, removes, reorders or relocates. |
| `create_element_with_view` / `create_edge_with_view` / `create_relationship` | Elements and relationships drawn on a diagram; `create_relationship` also sets association ends. |
| `add_attribute` / `add_operation` / `add_parameter` / `add_enumeration_literal` / `add_template_parameter` / `add_slot` / `add_tag` | Features of classifiers and instances. |
| `set_stereotype` / `set_documentation` | Common element properties. |
| `create_diagram` / `switch_diagram` / `close_diagram` | Diagrams. |
| `get_views_of` / `get_edge_views_of` / `get_relationships_of` / `get_refs_to` / `get_connected_node_views` | Lookups between models, views and relationships. |
| `layout_diagram` / `route_edges` / `move_views` / `resize_node` / `set_view_style` / `set_z_order` | Arrange and style views; `layout_diagram` takes a preset (`flow-down`, `hierarchy-right`, …), node and rank separations and `fit`, `route_edges` gives every edge one line style. |
| `get_selection` / `set_selection` / `get_editor_state` / `set_editor_state` | Selection, current diagram, zoom and grid. |
| `export_diagram` / `export_diagrams` / `export_pdf` / `export_html` | Diagram as PNG, JPEG or SVG (inline or to a file), with `annotate` labelling each view by its element's path or id / many diagrams into a directory / PDF / HTML docs. |
| `list_code_generators` / `generate_code` / `reverse_code` | Installed language generators and their options / source code from a model element / a source directory into the model. |
| `undo` / `redo` / `is_modified` | History and unsaved state. |
| `batch` | Several calls in one request, by default one undo step that rolls back when an op fails; each op answers its success and id, or more with `result: "ids"` or `"full"`. |
| `introspect` / `debug` | Versions, factory ids, metamodel, toolbox and manifest (the `introspect` tool is the summary; `call_endpoint` applies its defaults) / the raw `app` surface. |

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

`build_diagram` lists a hand-written description and nine parameters (`kind`, `spec`, `mermaid`,
`name`, `upsert`, `prune`, `dryRun`, `direction`, `layout`, 442 tokens); `kind` lists the
manifest's enum, so the 29 kinds follow the running extension. The manifest's own description of
`spec` alone is 1,805 tokens, so `spec` lists a one-line grammar per kind, the families' shared
shape once, and `describe_endpoints({names: ["build_diagram"]})` serves the full one. The unlisted `parent` (an id or a path), `text`, `format`, `reuse`, `allowDuplicateNames` and `autoLayout` are accepted, and
every body is checked against the manifest's whole request schema before it is sent, as for `batch`.

`export_diagram` lists a hand-written description and shorter parameter descriptions (154 tokens
against the manifest's 276); the colour pattern, the scale bounds and the `annotate` modes are left to the check against the whole request
schema, as for `build_diagram`. With `annotate`, each label comes back as `{text, x, y, width,
height}` without the extension's `ref`: the text is already the element's id or a path naming it. It returns a PNG or JPEG as an image content block followed by the rest of the answer
(`width`, `height`, `bytes`) as JSON; as text, the base64 of even a small diagram costs thousands of
tokens. SVG and exports written to `path` come back as JSON.

A `build_diagram` dry run answers the plan's `creates`,
`updates` and `deletes` and counts its `/batch` ops instead of listing them: they are the largest
part of the answer, and the build runs them. Its `ids` and `edges`, "$name" placeholders for
elements that do not exist yet, are left out too.

`diagram_quality` and `improve_diagram` (core) list `ref` (the diagram, default the current one)
in 56 tokens, and `ref` and `dryRun` in 74; `target`, `maxIterations`, `relayout` and `preset`
pass unlisted. `diagram_quality` answers the diagram by name, the score and the target, the
penalties that cost points (largest first, the zero ones left out) and the lint findings counted
by rule; the raw metrics, the 1–5 rating and `passes` follow from those and are left out (27
tokens instead of 189 for a two-class diagram). Since extension #38 the score is fitted to human
ratings and a diagram past a hard limit (aspect over the profile's `maxAspect` on a diagram larger
than the page, more boxes than `maxNodes`) scores at most 59; `failures` names those limits and is
kept, in this answer and in every compacted `quality` report, whenever it names one: no relayout
fixes it, the diagram has to be split. `improve_diagram` answers the diagram by name and
the loop's compacted report. `set_style_profile` answers the profile's name, `strict`,
`blockSaveOnErrors`, where it is stored and whether it changed, not the whole merged profile
(about 600 tokens), which `get_style_profile` reads.

`lint_diagram` (`--tools core,lint_diagram`) lists `diagram` and `rules` in 70 tokens. Its
findings, and those of `uml_lint`, `model_lint` and `diff_diagram`, come back with the checked diagram as its path and without the ids
a finding's paths already name (a view of no model keeps its id); each lint `autofix` is a
`{path, body}` request, the shape of a `batch` op, so every autofix of an answer goes into one
`batch`. `get_element_by_id` and `delete_element` (when named in `--tools`) list `ref` and a
whole one-line description, which the manifest's run past 100 characters. `quick_find` lists
`text` alone in 51 tokens; `limit` (default 50) passes unlisted.

`find_elements`, `update_element`, `search_types`, `describe_diagram` and `validate_model` list
hand-written descriptions too, in 95, 186, 86, 67 and 59 tokens (the last three when named in
`--tools`); `update_element` keeps the
meaning of each `op` in one line. These short listings, like `build_diagram`'s and
`export_diagram`'s, leave string lengths and integer bounds to the check against the whole
request schema, keep the manifest's `required`, and, like every listing, leave out
`additionalProperties: {}` and `propertyNames: {type: "string"}`, which hold for every object.
`search_types` answers its hits without the ranking `score`; `describe_diagram` answers its
summary text alone, whose first line already names the diagram and counts its nodes and edges.

`build_model` lists `spec` (one line naming the sections and the relationship verbs), `upsert`
and `dryRun` in 125 tokens against the manifest's 488; `apply_pattern` (under `oo`, or named in
`--tools`) lists `pattern`, `bindings`, `diagram` and `dryRun` in 112 against 454, `bindings`
without its two nested unions.
`parent`, `result`, `variant`, `sequence` and `upsert` pass unlisted, and every body is checked
against the whole request schema first, so a bad binding is `INVALID_ARGUMENT` before StarUML sees
it. Their answers, and those of `apply_preset`, `detect_patterns`, `sync_operations` and
`apply_theme` through `call_endpoint`, name elements by path: each role's elements as paths,
created and updated elements as `{path: type}` and `{path: fields}`, every property set grouped
as `{path: {field: value}}`, and a dry run's `/batch` ops counted with the "$name" placeholder ids
left out (its `changes` name every step). Since extension #39 those dry runs answer a summary by
default: the first 20 changes of each kind, with `omitted` counting the rest; the op count here
adds the omitted ops, so it is what applying runs either way, and `omitted` keeps only the counts
of lists the answer still has. ThingsBoard's 646-op model answers 914 tokens as a summary and
20,131 with `detail: "full"` (StarUML 7.1.1, live suite).

`explain_model`, `derive_diagrams` and `detect_patterns` are listed by the `oo` tier.
`explain_model` lists `scope`, `sections` (with its enum), `maxChars` and `cursor`, and answers
plain text; since extension #40 a cut answer ends with the extension's own line naming the section
it stopped in and the cursor to pass next, which this server leaves as it is (an older build's cut
text gets `[cut at maxChars; raise it or narrow scope]`). `detect_patterns` lists `scope`,
`patterns` and `minConfidence` (default 0.8, below which a candidate is mostly a guess from names
and shape).

Since extension #31 and #32 authoring answers carry two reports, compacted wherever they appear
(`build_diagram`, `build_model`, `apply_pattern`, `layout_diagram`, the single-view creates):
`style`, what the style profile changed, with each rename as `{from: to}`, and `quality`, the
quality loop's outcome as `{score, target, iterations, findings}` with the lint findings it left
counted by rule name; the `rating` (the score in fifths), `passes` (score ≥ target), `before` and
the post-processing `steps` are left out. A report with one finding left is 25 o200k_base tokens instead of 62, a clean one 21 instead of 38.

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
| `staruml://patterns` | `application/json` the pattern library: each pattern's category, intent, roles (`*` many, `?` optional) and variants (needs the extension) | `list_patterns` |
| `staruml://pattern/{name}` | `application/json` one pattern (percent-encoded name, e.g. `Abstract%20Factory`): roles with element types, properties, stereotypes and members, relationships with their end properties, sequence messages and the checks `uml_lint` holds it to | `describe_pattern` |
| `ui://staruml/viewer.html` | `text/html;profile=mcp-app` the diagram viewer `view_diagram` names in its `_meta` | |
| `staruml://diagram/{id}.png` | `image/png` blob; `{id}` is percent-encoded, since ids can contain `/`, `+` and `=` | `get_diagram_image_by_id` |
| `staruml://diagram/{id}.mmd`, `staruml://diagram/{id}.puml` | `text/plain` Mermaid or PlantUML (no media type is registered for either), `_meta: {kind, warnings?}` (needs the extension) | `diagram_as_text` |

`resources/list` enumerates one `staruml://diagram/{id}.png` per diagram, and
`resources/templates/list` the four templates; the text forms and the patterns are not listed one
by one (`staruml://patterns` names them). The pattern reads are cached like the catalogues until
`doctor` reloads the catalog. When StarUML is not
reachable it lists only the seven static resources. A failed read is a JSON-RPC error whose `data`
holds the same `error` object a failed tool call returns.

StarUML 7.1.1's `/get_diagram_image_by_id` ignores every field except `diagramId` (`scale`,
`maxWidth`, `width` and `format` return identical bytes; the live suite checks this), so the
image tool and resource offer no size options.

### Prompts

Clients that surface MCP prompts (as slash commands in Claude Code, for instance) offer five:

| Prompt | Arguments | Workflow |
|---|---|---|
| `model-codebase` | `path`, `language`, `description`, `name` (all optional) | `doctor`; with a source directory, `list_code_generators` and `reverse_code` (StarUML's Java reverse adds type hierarchy and package overview diagrams by default); otherwise one `build_diagram` of the central classes from the code or the description; then `describe_diagram` and `validate_model` on the result. |
| `review-diagram` | `diagram`, an id or a path (default `@current`) | `describe_diagram`, `validate_model` scoped to the diagram's owner, `diagram_as_text` (`format: "spec"` for the diagram families); then a review with a concrete fix per finding, changing nothing until asked. |
| `improve-diagram` | `diagram`, an id or a path (default `@current`) | `view_diagram`; `diagram_quality` (score, target, penalties); `improve_diagram` (the profile's layout and the lint autofixes in one undo step, each step kept only when the score rises); `view_diagram` again; below target, split a diagram past the profile's `maxElements`, try another preset, `uml_lint` for the model; never placing views by hand. |
| `model-first` | `system`, `description` (both optional) | Explain the domain back as contexts, classes with responsibilities, relationship verbs, actors, collaborations and lifecycles; `build_model` with `dryRun`, then for real; `derive_diagrams`; `view_diagram`, `diagram_as_text`, `explain_model`; `model_lint`, fixes in the spec, `build_model` upsert and `derive_diagrams` again, at most three rounds. Never places views. |
| `apply-pattern` | `pattern`, `scope` (the package holding the classes), `diagram` (all optional) | `staruml://patterns` when no pattern is named; `describe_pattern`; bindings by path; `apply_pattern` (through `call_endpoint` under `core`) with `dryRun`, then for real into `scope`; `view_diagram` with `annotate: "paths"`; `detect_patterns` to confirm confidence 1 and nothing missing. |

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
- **Any other client**: the PNG the extension's `export_diagram` draws for `diagram` or the
  current diagram, capped in width (below). With no compatible extension, or none answering, the
  PNG `get_diagram_image_by_id` returns from StarUML's built-in API, at its own size.

### Image size

An inline PNG or JPEG (`view_diagram` without the viewer, `export_diagram` without `path` or
`scale`) is exported no wider than a cap (issue #19). The re-validation viewed 25 ThingsBoard
diagrams as 8.7 MB of base64, up to 5,800 px wide, which a vision model scales down to 1,568 px on
the long edge anyway. The cap is, in order: the call's `maxWidth` (`view_diagram` only),
`--image-max-width <px>` (or `STARUML_MCP_IMAGE_MAX_WIDTH`), the style profile's
`layout.page.width` (1,600 px in `uml-standard`, `minimal` and `presentation`, 1,123 in `print`),
and 1,600 when no profile can be read. 0 turns it off. StarUML has no endpoint for a diagram's
extent, so the image is exported at scale 1 first and, when it is wider than the cap, again at
the scale that fits, rounded down to three places; a narrower diagram, the usual case, is
exported once. The second answer carries `fullWidth`, the width at scale 1. Files are written at
full size unless the call passes `maxWidth`; SVG is never scaled. For a picture the user wants
to keep, pass `path`: the answer is the pixel size and bytes, and the diagram's id when the call
named it by path, about 15 tokens instead of an image.

The 25 diagrams `derive_diagrams` makes of ThingsBoard, viewed one by one under `--tools oo`
against StarUML 7.1.1 (live suite, "views every derived diagram capped inline and writes each to
disk"; vision tokens estimated as Anthropic's vision docs bill them, the long edge scaled to
1,568 px and about width × height / 750 tokens, at most about 1,600 an image):

| How | Image bytes | Widest | Vision tokens (est.) | Text tokens |
|---|---|---|---|---|
| 0.8.0: StarUML's built-in PNG | 9.0 MB (12.0 MB base64) | 5,942 px | ~36,600 | 0 |
| `export_diagram` at scale 1 (`maxWidth: 0`) | 3.3 MB | 2,971 px | ~29,200 | 0 |
| capped at the profile's 1,600 px (default) | 2.8 MB (3.7 MB base64) | 1,599 px | ~29,200 | 0 |
| `path`, written to disk | 3.3 MB in files, none in context | | 0 | 376 |

The built-in PNG is rendered at the display's pixel ratio (2 here), which doubles every side; the
export at scale 1 is a third of its bytes, and the cap takes off the widest diagrams' extra
pixels, which the model's own downscaling would have dropped anyway, so the vision estimate
barely moves between the two. What the cap saves is transfer and context bytes; what saves
tokens is not sending images at all: 25 diagrams to disk cost 376 text tokens.

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
| extension reference codes | Passed through with a hint: `AMBIGUOUS_REF` (409: a path fits several elements; the hint names up to five of `details.candidates` by path, or by id where their paths collide), `DUPLICATE_NAME` (409: a sibling of that kind has the name; refer to `details.existing` by its path, keep `build_diagram`'s `reuse` on, rename, or pass `allowDuplicateNames: true`), `SNAPSHOT_STALE` (409: the undo history no longer reaches the snapshot; take a new one), `UNSUPPORTED_SYNTAX` (422: diagram text with a construct StarUML cannot draw; the message names it and its line). |
| `NOT_IN_TIER` | Raised by `call_endpoint` and `describe_endpoints` before any request under a closed tier (`--tools oo`) for an endpoint the tier leaves out, or an `update_element` of a view attribute; the hint explains the model-first alternative (change the model with `build_model`, then `derive_diagrams` and `improve_diagram`) and never names a way out of the tier. |
| `PROFILE_NOT_STRICT` | Under `--tools oo`, before a call that changes something: the project's style profile could not be made strict (reading or setting it failed, or it still reads `strict: false`). The message says which; nothing was sent. |
| `TIER_LOCKED` | `doctor({tools})` asked for a tier that reaches more than the current one, without `--allow-tier-switch`; nothing changed. The hint gives the model-first alternative and says only the user can start the server with a wider tier. |
| extension style codes | Passed through with a hint: `STYLE_LOCKED` (403: the project's style profile is `strict`, so the endpoints that place, size or colour views by hand refuse; the hint names `improve_diagram`, `apply_style_profile`, a rebuild, `override: true` for a change the user asked for, and `set_style_profile({patch: {strict: false}})`), `SAVE_BLOCKED` (409: the profile's `blockSaveOnErrors` refuses saving and exporting while `uml_lint` or `model_lint` report errors; the hint names the first ones from `details.findings` and `override: true`). |
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
npm run test:mutation  # Stryker over src/, fails below 85% of mutants killed (94.23% now)
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
the per-op schema checks, `--build` a `build_diagram` of a three-class Mermaid diagram with
`upsert`, which adds the check against the whole request schema, `--lint` a `lint_diagram`
of the current diagram, whose findings are reshaped, `--model` and `--pattern` dry runs of
`build_model` and `apply_pattern`, whose answers are reshaped by path, and `--quick-find` a
`quick_find`. StarUML and the extension are
replaced by an in-process stub, which serves the bundled 0.3.0 manifest, so the numbers measure
this server and a local StarUML does not change them. By default no request carries a session
id, so each builds a fresh `McpServer` (the stateless fallback), which dominates the cost;
`--session` initializes once and sends every request in that session, as an MCP client does. Any
failed request makes the script exit non-zero; `--max-p99-ms` and `--min-rps` add budgets, and CI
runs the default, `--session`, `--batch`, `--build`, `--lint --session`, `--model --session`, `--pattern --session`, `--quality --session`, `--improve --session`, `--derive --session` and `--quick-find --session` paths with
`--requests 2000 --max-p99-ms 4000 --min-rps 100`.

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

Re-run for 0.5.0 in one session (core tier of 21 tools, the 69-endpoint manifest, request bodies
read by the server and capped at 4 MiB), two runs per path, 5000 requests per level after 500
warm-up requests, stub upstream, load average 10–16 from other agents' work, 0 errors throughout:

| Tool | Concurrency | req/s | p50 | p99 |
|---|---|---|---|---|
| `get_all_diagrams_info` | 50 | 1464–1515 | 31–33 ms | 59–82 ms |
| `get_all_diagrams_info` | 200 | 1830–1943 | 86–96 ms | 222–287 ms |
| `call_endpoint` | 50 | 1348–1543 | 31–35 ms | 58–63 ms |
| `call_endpoint` | 200 | 1796–1847 | 93–98 ms | 198–220 ms |
| `batch` (4 ops) | 50 | 898–1364 | 35–39 ms | 61–191 ms |
| `batch` (4 ops) | 200 | 1076–1614 | 111–146 ms | 234–388 ms |
| `build_diagram` | 50 | 1428–1466 | 32–33 ms | 57–87 ms |
| `build_diagram` | 200 | 1675–1870 | 98–101 ms | 171–319 ms |
| `lint_diagram` | 50 | 1348–1446 | 32–36 ms | 61–67 ms |
| `lint_diagram` | 200 | 1063–1681 | 110–163 ms | 186–445 ms |

Re-run for 0.9.1 in one session, as for 0.9.0 below, two runs per path, 5000 requests per level
after 500 warm-up requests, stub upstream, load average about 10, 0 errors throughout. 0.9.1
changes no request path; the dry-run answers' `omitted` count and the kept `failures` are a few
object spreads per call:

| Tool | Concurrency | req/s | p50 | p99 |
|---|---|---|---|---|
| `get_all_diagrams_info` | 50 | 1596–1631 | 29–30 ms | 55–59 ms |
| `get_all_diagrams_info` | 200 | 2073–2088 | 83–84 ms | 153–154 ms |
| `call_endpoint` | 50 | 1503–1508 | 31–32 ms | 56–57 ms |
| `call_endpoint` | 200 | 1925–1952 | 86–90 ms | 170–245 ms |
| `batch` (4 ops) | 50 | 826–1383 | 34–39 ms | 60–173 ms |
| `batch` (4 ops) | 200 | 1740–1805 | 96–102 ms | 166–702 ms |
| `build_diagram` | 50 | 741–1644 | 29–66 ms | 52–179 ms |
| `build_diagram` | 200 | 1910–2027 | 89–93 ms | 164–179 ms |
| `lint_diagram` | 50 | 1629–1631 | 29 ms | 53 ms |
| `lint_diagram` | 200 | 1981–2016 | 92–94 ms | 155–156 ms |
| `build_model` (dry run) | 50 | 1521–1530 | 31 ms | 52–55 ms |
| `build_model` (dry run) | 200 | 1795–1842 | 103–105 ms | 151–161 ms |
| `apply_pattern` (dry run) | 50 | 1399–1541 | 31–32 ms | 55–113 ms |
| `apply_pattern` (dry run) | 200 | 1851–1860 | 88–103 ms | 153–603 ms |
| `diagram_quality` | 50 | 1686–1690 | 28 ms | 49–51 ms |
| `diagram_quality` | 200 | 1942–2093 | 86–93 ms | 142–155 ms |
| `improve_diagram` (dry run) | 50 | 1555–1679 | 28–31 ms | 52–56 ms |
| `improve_diagram` (dry run) | 200 | 1995–2013 | 87–90 ms | 165–194 ms |
| `derive_diagrams` (dry run, `oo`) | 50 | 1133–1142 | 41–42 ms | 70–78 ms |
| `derive_diagrams` (dry run, `oo`) | 200 | 1283–1288 | 145–148 ms | 248–251 ms |
| `quick_find` | 50 | 1333–1551 | 31–35 ms | 56–64 ms |
| `quick_find` | 200 | 762–1941 | 93–260 ms | 160–359 ms |

On a quieter machine than 0.9.0's every path's faster run is within 1% of the top of 0.9.0's
range; the slow outliers (`build_diagram`, `batch`, `quick_find` once each) are single runs
another process interrupted.

Re-run for 0.9.0 in one session, as for 0.8.0 below, two runs per path, 5000 requests per level
after 500 warm-up requests, stub upstream, with other agents' test runs on the machine (load
average 18–58), 0 errors throughout. `derive_diagrams` under `oo` now reads the style profile
before each call (#19), a second request to the stub per call:

| Tool | Concurrency | req/s | p50 | p99 |
|---|---|---|---|---|
| `get_all_diagrams_info` | 50 | 960–1401 | 34–49 ms | 59–108 ms |
| `get_all_diagrams_info` | 200 | 354–1892 | 95–644 ms | 196–1005 ms |
| `call_endpoint` | 50 | 958–1392 | 35–47 ms | 61–116 ms |
| `call_endpoint` | 200 | 622–1706 | 96–274 ms | 541–791 ms |
| `batch` (4 ops) | 50 | 406–1188 | 40–118 ms | 77–287 ms |
| `batch` (4 ops) | 200 | 353–1788 | 102–622 ms | 167–879 ms |
| `build_diagram` | 50 | 1055–1584 | 30–46 ms | 55–74 ms |
| `build_diagram` | 200 | 1221–1996 | 90–132 ms | 148–1070 ms |
| `lint_diagram` | 50 | 1012–1626 | 29–48 ms | 52–79 ms |
| `lint_diagram` | 200 | 1187–1951 | 95–158 ms | 203–265 ms |
| `build_model` (dry run) | 50 | 554–1544 | 30–80 ms | 56–211 ms |
| `build_model` (dry run) | 200 | 450–1849 | 100–413 ms | 162–1243 ms |
| `apply_pattern` (dry run) | 50 | 315–1463 | 33–160 ms | 53–258 ms |
| `apply_pattern` (dry run) | 200 | 439–1833 | 104–393 ms | 181–2123 ms |
| `diagram_quality` | 50 | 946–1639 | 29–49 ms | 51–101 ms |
| `diagram_quality` | 200 | 531–1961 | 90–376 ms | 156–506 ms |
| `improve_diagram` (dry run) | 50 | 985–1563 | 31–48 ms | 55–90 ms |
| `improve_diagram` (dry run) | 200 | 1312–1951 | 91–142 ms | 169–285 ms |
| `derive_diagrams` (dry run, `oo`) | 50 | 331–1133 | 42–98 ms | 72–455 ms |
| `derive_diagrams` (dry run, `oo`) | 200 | 353–1250 | 150–495 ms | 259–1824 ms |
| `quick_find` | 50 | 827–1265 | 37–58 ms | 82–107 ms |
| `quick_find` | 200 | 1107–1663 | 110–169 ms | 193–731 ms |

The machine was shared with up to 15 vitest workers of other agents, so the spread within a
path is mostly theirs: each path's faster run is at most 18% under the low end of 0.8.0's range,
except `derive_diagrams`, whose faster runs (1,133 and 1,250 req/s) are 24% and 36% under it,
the cost of the profile read that doubles its requests to the stub.

Re-run for 0.8.0 in one session (core tier of 19 tools, the 103-endpoint manifest; `lint_diagram`
under `--tools core,lint_diagram`, `apply_pattern` under `core,apply_pattern`, `derive_diagrams`
under `oo`), two runs per path, 5000 requests per level after 500 warm-up requests, stub upstream,
load average 8–17 from other agents' work, 0 errors throughout:

| Tool | Concurrency | req/s | p50 | p99 |
|---|---|---|---|---|
| `get_all_diagrams_info` | 50 | 705–1603 | 30–67 ms | 55–126 ms |
| `get_all_diagrams_info` | 200 | 1876–2069 | 85–86 ms | 149–318 ms |
| `call_endpoint` | 50 | 757–1539 | 32–63 ms | 57–125 ms |
| `call_endpoint` | 200 | 1330–1980 | 89–109 ms | 169–365 ms |
| `batch` (4 ops) | 50 | 1378–1411 | 34–35 ms | 62–64 ms |
| `batch` (4 ops) | 200 | 1715–1727 | 104–109 ms | 169–191 ms |
| `build_diagram` | 50 | 913–1491 | 32–48 ms | 58–159 ms |
| `build_diagram` | 200 | 1379–1889 | 95–101 ms | 161–386 ms |
| `lint_diagram` | 50 | 955–1596 | 30–45 ms | 52–123 ms |
| `lint_diagram` | 200 | 1312–1951 | 97–104 ms | 156–397 ms |
| `build_model` (dry run) | 50 | 1528–1529 | 31 ms | 54–55 ms |
| `build_model` (dry run) | 200 | 1831–1840 | 97–103 ms | 164–204 ms |
| `apply_pattern` (dry run) | 50 | 1529–1580 | 30–31 ms | 50–52 ms |
| `apply_pattern` (dry run) | 200 | 1857–1874 | 101–102 ms | 145–146 ms |
| `diagram_quality` | 50 | 1721–1722 | 27–28 ms | 50 ms |
| `diagram_quality` | 200 | 2069–2114 | 85–86 ms | 150–151 ms |
| `improve_diagram` (dry run) | 50 | 1700–1706 | 28 ms | 48–53 ms |
| `improve_diagram` (dry run) | 200 | 2058–2071 | 84–87 ms | 167–183 ms |
| `derive_diagrams` (dry run, `oo`) | 50 | 1498–1675 | 28–31 ms | 52–58 ms |
| `derive_diagrams` (dry run, `oo`) | 200 | 1948–2006 | 91–94 ms | 154–165 ms |
| `quick_find` | 50 | 1537–1708 | 28–32 ms | 50–55 ms |
| `quick_find` | 200 | 1960–2053 | 84–89 ms | 212–405 ms |

Each path's slower run at 50 (the plain call's and `build_diagram`'s first, `call_endpoint`'s
and `lint_diagram`'s second) ran at a load-average peak; its other run matches the rest. Against StarUML
7.1.1 with the extension's phase 1i build (`--live --session --requests 1000 --concurrency 50`,
0 errors): `get_all_diagrams_info` 1055 req/s, p99 78 ms; `quick_find` 1082 req/s, p99 77 ms.

Re-run for 0.7.0 in one session (core tier of 20 tools, the 88-endpoint manifest; `derive_diagrams`
under `--tools oo`), two runs per path, 5000 requests per level after 500 warm-up requests, stub
upstream, load average about 21 from other agents' work, 0 errors throughout:

| Tool | Concurrency | req/s | p50 | p99 |
|---|---|---|---|---|
| `get_all_diagrams_info` | 50 | 997–1100 | 38–47 ms | 97–119 ms |
| `get_all_diagrams_info` | 200 | 944–1722 | 104–191 ms | 201–339 ms |
| `call_endpoint` | 50 | 564–1459 | 33–86 ms | 59–152 ms |
| `call_endpoint` | 200 | 824–1722 | 100–200 ms | 229–1774 ms |
| `batch` (4 ops) | 50 | 470–1196 | 39–102 ms | 103–218 ms |
| `batch` (4 ops) | 200 | 653–1530 | 113–252 ms | 247–2559 ms |
| `build_diagram` | 50 | 570–1405 | 34–82 ms | 65–162 ms |
| `build_diagram` | 200 | 794–1824 | 100–226 ms | 165–1227 ms |
| `lint_diagram` (`core,lint_diagram`) | 50 | 559–1445 | 33–87 ms | 59–143 ms |
| `lint_diagram` (`core,lint_diagram`) | 200 | 730–1707 | 105–254 ms | 212–440 ms |
| `build_model` (dry run) | 50 | 524–1379 | 35–89 ms | 60–178 ms |
| `build_model` (dry run) | 200 | 577–1646 | 106–233 ms | 227–6147 ms |
| `apply_pattern` (dry run) | 50 | 475–1384 | 34–102 ms | 58–172 ms |
| `apply_pattern` (dry run) | 200 | 662–1632 | 117–288 ms | 204–483 ms |
| `diagram_quality` | 50 | 534–1544 | 31–89 ms | 55–163 ms |
| `diagram_quality` | 200 | 719–1840 | 96–256 ms | 169–446 ms |
| `improve_diagram` (dry run) | 50 | 574–1559 | 31–84 ms | 56–155 ms |
| `improve_diagram` (dry run) | 200 | 805–2028 | 89–222 ms | 144–389 ms |
| `derive_diagrams` (dry run, `oo`) | 50 | 531–1518 | 32–89 ms | 54–170 ms |
| `derive_diagrams` (dry run, `oo`) | 200 | 721–1974 | 91–262 ms | 160–471 ms |

The second run of every path ran while another agent's test suites peaked; the first matches
0.6.0's numbers. The 6.1 s p99 of one `build_model` run at 200 is one such stall: its p90 is
299 ms.

Re-run for 0.6.0 in one session (core tier of 19 tools, the 79-endpoint manifest), two runs per
path, 5000 requests per level after 500 warm-up requests, stub upstream, load average 13–21 from
other agents' work, 0 errors throughout:

| Tool | Concurrency | req/s | p50 | p99 |
|---|---|---|---|---|
| `get_all_diagrams_info` | 50 | 1676–1715 | 28–29 ms | 49–52 ms |
| `get_all_diagrams_info` | 200 | 2145–2168 | 78–82 ms | 180–322 ms |
| `call_endpoint` | 50 | 807–1650 | 29–58 ms | 54–136 ms |
| `call_endpoint` | 200 | 1100–2040 | 84–108 ms | 176–1855 ms |
| `batch` (4 ops) | 50 | 1284–1527 | 31–37 ms | 57–66 ms |
| `batch` (4 ops) | 200 | 1568–1811 | 101–114 ms | 178–228 ms |
| `build_diagram` | 50 | 1359–1573 | 30–36 ms | 53–68 ms |
| `build_diagram` | 200 | 1787–1890 | 95–101 ms | 168–222 ms |
| `lint_diagram` | 50 | 405–1511 | 32–131 ms | 57–253 ms |
| `lint_diagram` | 200 | 778–1901 | 96–282 ms | 155–477 ms |
| `build_model` (dry run) | 50 | 1284–1294 | 36–38 ms | 64–77 ms |
| `build_model` (dry run) | 200 | 779–1630 | 112–252 ms | 196–394 ms |
| `apply_pattern` (dry run) | 50 | 507–1374 | 35–92 ms | 61–226 ms |
| `apply_pattern` (dry run) | 200 | 1396–1736 | 106–120 ms | 171–464 ms |

The wide ranges are the shared machine: each path's slower run coincides with a load-average peak,
and its other run matches the plain call. Against StarUML 7.1.1 with the extension's working tree
(85 endpoints; `--live --session --requests 1000 --concurrency 50`, 0 errors):
`get_all_diagrams_info` 951 req/s, p99 72 ms; `build_model` dry run 712 req/s, p99 166 ms;
`apply_pattern` dry run of Strategy 947 req/s, p99 67 ms.

Against StarUML 7.1.1 with the extension, in one session (`--live --session --requests 1000
--concurrency 50`, 0 errors): `get_all_diagrams_info` 1049 req/s, p99 63 ms; `call_endpoint`
`find_elements` 644 req/s, p99 206 ms; `lint_diagram` of the open diagram 737 req/s, p99 166 ms.

### Caching (#14)

Two caches, both shared by every session of a process:

- **Manifest compilation.** Each manifest entry's tool (its two zod schemas from the JSON Schema,
  description and annotations) is kept by the entry's JSON, 512 entries at most. Compiling the
  bundled 69-endpoint manifest takes 44 ms (median of 20 runs with an empty cache; 53 ms for the
  first, before the JIT warms up) and 1.09 ms once cached, which is `JSON.stringify` of the entries
  (37 and 1.05 ms for the 61-endpoint manifest of 0.4.0).
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
calls, then 2,000 measured calls rotating `get_all_diagrams_info`, `quick_find`, `get_preference` and
`performance_stats` through `call_endpoint`, `call_endpoint`, a two-op `batch`,
`build_diagram`, `lint_diagram` through `call_endpoint`, `diagram_quality` and dry runs of
`improve_diagram`, `build_model`, `apply_pattern` and `derive_diagrams`, and fails when the mean RSS, the live heap after a full GC or the p99 latency
of the last 200 calls exceeds the first 200 by more than 25%, or any call fails; a p99 increase must
also exceed 2 ms to count, since the p99 of 200 calls of about 1 ms is their second slowest and
doubles on one scheduler stall. The live workflow runs it.

Four runs for 0.9.1, the same rotation (load average about 9), 0 errors, all within budget:

| Window | RSS | Live heap after GC | p50 | p99 |
|---|---|---|---|---|
| first 200 | 156.6–164.0 MB | 25.7–25.8 MB | 0.67–0.77 ms | 1.24–1.47 ms |
| last 200 | 166.8–174.6 MB | 26.6 MB | 0.56–0.66 ms | 1.28–1.80 ms |
| growth | 6.5–8.4% | 2.9–3.4% | | −8.8% to +44.9% |

The first run's p99 rose 0.56 ms, under the 2 ms floor.

Four runs for 0.9.0, the same rotation (load average 18–58 from other agents' work), 0 errors, all
within budget:

| Window | RSS | Live heap after GC | p50 | p99 |
|---|---|---|---|---|
| first 200 | 155.8–158.1 MB | 25.6–25.7 MB | 0.68–0.77 ms | 1.27–1.69 ms |
| last 200 | 167.3–170.1 MB | 26.5–26.6 MB | 0.56–1.18 ms | 1.30–3.08 ms |
| growth | 6.0–9.2% | 3.2–3.6% | | +2.8% to +98% |

The fourth run's p99 doubled (1.56 to 3.08 ms), 1.52 ms, under the 2 ms floor.

Four runs for 0.8.0, `quick_find`, `get_preference` and `performance_stats` added to the rotation
and `apply_pattern` through `call_endpoint` (load average 6–9), 0 errors:

| Window | RSS | Live heap after GC | p50 | p99 |
|---|---|---|---|---|
| first 200 | 157.1–160.4 MB | 25.6–25.8 MB | 0.70–1.49 ms | 1.38–4.77 ms |
| last 200 | 169.4–171.8 MB | 26.4–26.5 MB | 0.53–0.76 ms | 1.34–3.75 ms |
| growth | 6.3–7.8% | 2.4–3.5% | | −67% to +171% |

RSS and heap stay within budget in every run. The second run's p99 rose 2.37 ms (1.38 to 3.75
ms), just over the 2 ms floor, and failed the p99 budget; the other three moved −67% to −1% with
the same code, the third falling from a slow first window. As in 0.7.0, one window of 200 calls
of about 1 ms decides it.

Four runs for 0.7.0, the quality loop and `derive_diagrams` added to the rotation (load average
about 21), 0 errors:

| Window | RSS | Live heap after GC | p50 | p99 |
|---|---|---|---|---|
| first 200 | 157.1–160.9 MB | 25.3–25.4 MB | 1.64–2.23 ms | 3.19–6.89 ms |
| last 200 | 169.4–170.9 MB | 26.1 MB | 1.44–1.59 ms | 4.33–7.62 ms |
| growth | 6.2–8.7% | 2.8–3.1% | | −36% to +84% |

RSS and heap stay within budget in every run. The second run's p99 rose 3.47 ms (4.15 to 7.62 ms)
and failed the p99 budget; the runs before and after it moved
−4% to +43% (under the 2 ms floor) with the same code, so it is one window of 200 calls on a
machine at load average 21. A run that fails only on p99 is worth repeating before reading it as
a slowdown.

Three runs for 0.6.0, dry runs of `build_model` and `apply_pattern` added to the rotation (load
average 15–17), 0 errors:

| Window | RSS | Live heap after GC | p50 | p99 |
|---|---|---|---|---|
| first 200 | 156.9–158.4 MB | 23.0–23.2 MB | 0.89–1.65 ms | 1.47–6.16 ms |
| last 200 | 166.5–170.4 MB | 23.8–23.9 MB | 0.57–0.77 ms | 1.54–3.29 ms |
| growth | 6.0–7.6% | 2.9–3.7% | | −73% to +26% |

The 0.5.0 runs grew RSS by 5.1–6.9% and the heap by 3.0–3.8%. The p99 moves both ways between
runs and rose by 0.4 ms where it rose, under the 2 ms floor: one scheduler stall among 200 calls of
about 1 ms on a shared machine decides it (the 6.16 ms first window fell on a load-average peak). The 0.4.0 runs (load average 21–27) grew RSS by
3.9–8.3% and the heap by 2.8–4.0%.

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
one with the default core tier (19 tools). The first three are loaded with `git show` and run on
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
| Tools listed | 21 | 21 | 34 | 19 | 19 |
| Definitions + instructions | 3011 | 1831 | 6154 | 1998 | 1998 |

(a) Definitions once per scenario, plus results:

| Scenario | Calls before / now | pre-#5 | #5 | phase 2a | now batch | now | vs pre-#5 | vs #5 |
|---|---|---|---|---|---|---|---|---|
| Mermaid class diagram + preview | 4 / 4 | 3197 | 1951 | 6274 | 2118 | 2118 | −33.8% | +8.6% |
| Native use-case diagram | 11 / 2 | 3982 | 2497 | 6820 | 3982 | 2367 | −40.6% | −5.2% |
| Inspect and refactor a class model | 8 / 8 | 6227 | 4234 | 8557 | 4698 | 4698 | −24.6% | +11.0% |
| Native class diagram + export | 11 / 3 | 3917 | 2458 | 6781 | 3988 | 2377 | −39.3% | −3.3% |
| All scenarios | 34 / 17 | 17323 | 11140 | 28432 | 14786 | 11560 | −33.3% | +3.8% |

(b) Definitions once per session, plus results and calls:

| Scenario | pre-#5 | #5 | phase 2a | now batch | now | vs pre-#5 | vs #5 |
|---|---|---|---|---|---|---|---|
| Mermaid class diagram + preview | 282 | 216 | 216 | 216 | 216 | −23.4% | 0.0% |
| Native use-case diagram | 1490 | 1185 | 1185 | 2449 | 478 | −67.9% | −59.7% |
| Inspect and refactor a class model | 3369 | 2556 | 2556 | 2910 | 2910 | −13.6% | +13.8% |
| Native class diagram + export | 1434 | 1155 | 1155 | 2472 | 512 | −64.3% | −55.7% |
| Definitions, once | 3011 | 1831 | 6154 | 1998 | 1998 | | |
| Session | 9586 | 6943 | 11266 | 10045 | 6114 | −36.2% | −11.9% |

Targets of issues #5 and #8, under each accounting:

| Target | (a) per scenario | (b) per session |
|---|---|---|
| #5 / #8: 60% below pre-#5, first three scenarios | not met: 9183 against ≤ 5362 (−31.5%) | not met: 5602 against ≤ 3260 (−31.3%) |
| #5 / #8: 60% below pre-#5, all four scenarios | not met: 11560 against ≤ 6929 (−33.3%) | not met: 6114 against ≤ 3834 (−36.2%) |
| #8: core definitions ≤ 2,000 | met: 1998 | met: 1998 |
| #8: all scenarios below #5 | not met: 11560 against 11140 (+3.8%) | met: 6114 against 6943 (−11.9%) |

`build_diagram` does what it is for: a native diagram costs 478 and 512 tokens of results and calls
(the spec it is given included; its answer carries the style and quality reports since 0.7.0),
against 1185 and 1155 for #5's one call per element and 2449 and 2472 for one `batch`, whose ops repeat every parent and diagram id, whose results now carry each
element's path, and which needs `describe_endpoints` for four endpoint schemas. Under (a) that
saving is hidden by the definitions, counted four times (7992 of 11560 tokens); under (b) the
session is 11.9% below #5 and 36.2% below pre-#5. The refactor scenario grew 29 tokens in 0.7.0:
`save_project`'s schema, which `describe_endpoints` returns, gained `override`; and 64 (76 under
(b)) in 0.8.0, since its deletion goes through `call_endpoint` after `describe_endpoints` reads
`delete_element`'s schema; and 8 (2 under (b)) in 0.9.0, for `view_diagram`'s `path` and
`doctor`'s wording. What keeps
(b) above the 60% target is the fixed definitions (1998, a third of the session) and the refactor
scenario, whose `get_all_commands` result alone is 1947 tokens of the 322 command ids; neither is
touched by diagram building. The `batch` and `build_diagram` answers here are recorded in the
extension's full form; since its phase 1g it answers each op's success and id, and a build's
counts, unless asked for more, so both cost less against it. `--tools all` lists 110 tools for 14385 tokens (all scenarios (a)
60621, (b) 17911). Generated descriptions stay one line of at most 100 characters (a test enforces
it on every listed tool), and a test keeps the core listing within 2,000 tokens.

### Reading a diagram back

A fifth scenario, "read and explain a diagram", runs on the current server only and compares the
ways to read one diagram: five classes and an enumeration with 13 attributes, 5 operations and 4
literals, and five relationships (two associations with multiplicities, one of them named, a
composition, a directed association and a dependency). The upstream answers are what StarUML 7.1.1 and the extension
returned for it, recorded by `scripts/capture-read-diagram.mjs` into
`scripts/benchmark-data/read-diagram-7.1.1.json`. Each read is one call; the table counts the call,
its result text and, for the PNG, an estimate of its image tokens (width × height / 750 after
Anthropic's downscaling to 1568 px on the long edge and about 1,600 tokens; the 1402×1342 PNG is
scaled down, so its member text arrives smaller than StarUML drew it).

| Read | Call | Result text | Image (est.) | Total | vs PNG |
|---|---|---|---|---|---|
| PNG (`get_diagram_image_by_id`) | 27 | 0 | 1600 | 1627 | |
| Element dump (`find_elements`, `summary: false`, `depth: 2`) | 27 | 4288 | 0 | 4315 | +165.2% |
| `describe_diagram` (through `call_endpoint` since 0.6.0) | 31 | 277 | 0 | 308 | −81.1% |
| `diagram_as_text` (Mermaid) | 23 | 242 | 0 | 265 | −83.7% |
| `diagram_as_text` (PlantUML) | 28 | 253 | 0 | 281 | −82.7% |

What each carries for an explanation: the PNG has the layout and nothing machine-readable; the
element dump has every saved attribute and the ids, but relationships are association ends that
reference classes by id; `describe_diagram` has the members and every edge with its type and
name, but not multiplicities, aggregation or navigability; Mermaid and PlantUML have all of that
in a notation the model already reads, and the Mermaid can be edited and rebuilt with
`build_diagram`. Reading the diagram as Mermaid instead of a PNG saves about 1,360 tokens per read,
and about 4,050 against the dump (recaptured from the extension's phase 1j build for 0.9.1).

### Fixing a messy diagram

A sixth scenario, "fix a messy diagram", also on the current server only, fixes one class diagram
drawn as an agent placing views by hand leaves it: five classes with long names, three stacked at
one point and two overlapping, four associations. `scripts/capture-messy-diagram.mjs` drew it in
StarUML 7.1.1 with the extension's phase 1j build and recorded three ways of fixing it from the
same start into `scripts/benchmark-data/messy-diagram-7.1.1.json`. "By eye" is the way without
the lint: look at the PNG, run Format > Layout through `call_endpoint` after reading its schema,
look again. The lint loop is the #13 way: `lint_diagram`, every autofix in one `batch`,
`lint_diagram` again, one look at the PNG (`lint_diagram` listed, as `--tools core,lint_diagram`
would). The quality loop is the #16 way the `improve-diagram` prompt walks: look,
`diagram_quality`, `improve_diagram`, look again. The last columns are what `lint_diagram` still
finds after each and `diagram_quality`'s score against the profile's target of 80.

| Plan | Calls | Call tokens | Result text | Images (est.) | Total | Findings left | Score |
|---|---|---|---|---|---|---|---|
| By eye: PNG, layout, PNG | 4 | 96 | 477 | 1306 | 1879 | 0 | 73 → 99 |
| Lint loop: lint, batch of autofixes, lint, PNG | 4 | 297 | 972 | 1054 | 2323 | 0 | 73 → 98 |
| Quality loop: PNG, `diagram_quality`, `improve_diagram`, PNG | 4 | 96 | 92 | 1595 | 1783 | 0 | 73 → 99 |

Messy diagram → quality ≥ 80: the quality loop gets there in two calls whose text costs 188
tokens (96 for the calls, 92 for the answers: the score with the penalties that cost points, then
the score reached), against 1,269 for the lint loop's text, and scores as high as any. Extension
#38's calibrated metric scores the messy start 73 where 0.8.0's scored it 58: it weighs what a
reader sees, and stacked boxes with readable labels lose fewer points than before. Its two looks are
the rest of its cost; they are what the prompt asks for and can be left out. Since the phase 1h
build `layout_diagram` runs the quality loop as well, so "by eye" now clears the stacked views
and the long names too; under 0.6.0's build it left five findings. Most of the lint loop's text
is the seven findings with their paths, fix lines and autofix requests.

### Applying a design pattern

A seventh scenario applies Strategy to an existing three-class model (`Order`, `FlatRate`,
`ByWeight`; the strategy interface is new). `scripts/capture-pattern.mjs` built the model in
StarUML 7.1.1 and recorded both ways into `scripts/benchmark-data/pattern-7.1.1.json`.
`apply_pattern` reads the pattern through `call_endpoint` and applies it with the roles bound by
path, optionally after a dry run (the `apply-pattern` prompt's way). The batch way writes the same
nine changes as ops, after reading the three endpoint schemas they use: the ops of
`apply_pattern`'s own dry run, which is the best a model can write by hand, with every property
Strategy prescribes (the strategy's abstract `execute()`, a shared aggregation at the context that
does not navigate, the far end navigable, named `strategy`, multiplicity 1, the typed `in`
parameter of `setStrategy`). It is not charged for knowing those. The last column is what
`detect_patterns` scored afterwards.

| Plan | Calls | Call tokens | Result text | Total | Detect confidence |
|---|---|---|---|---|---|
| `apply_pattern`: `describe_pattern`, apply | 2 | 71 | 718 | 789 | 1 |
| `apply_pattern` with a dry run first | 3 | 127 | 983 | 1110 | 1 |
| `batch`: 3 schemas, 9 ops | 2 | 427 | 1643 | 2070 | 1 |

`apply_pattern` costs 62% less, 46% with the dry run, and the model writes 71 tokens instead of
427; since 0.8.0 the core tier calls it through `call_endpoint`, which adds 8 tokens per call. Its answer is 281 tokens against the extension's 505: roles and elements by path, the
properties grouped by path; a dry run's is 274 against 1,094, its `/batch` ops counted. Most of
the batch way's cost is reading the schemas (1,489 tokens of `describe_endpoints`) before
writing the ops.

### Modelling a domain object-first

An eighth scenario turns one domain into diagrams two ways: ThingsBoard, the object spec of the
extension's validation (`tests/fixtures/thingsboard.oo.json`: 93 classifiers in 15 contexts, 95
relationships, 6 actors, 21 use cases, 5 collaborations, 3 lifecycles, and the activity, ERD, C4,
deployment and mind map sections). `scripts/capture-oo.mjs` recorded both from StarUML 7.1.1 and
the extension's phase 1j build into `scripts/benchmark-data/oo-thingsboard-7.1.1.json`. The `oo`
tier way is the `model-first` prompt's: `build_model` with the spec, then `derive_diagrams`. The
drawing way is one `build_diagram` per diagram under the core tier, each spec written from the
same domain (every class with its members, every relation with its multiplicities, every message,
state and node), which is the best a model drawing by hand can do. Each tier's definitions are
counted once ("total") and, for a client without prompt caching, once per call.

| Plan | Calls | Definitions | Call tokens | Result text | Total | Definitions each turn | Diagrams | Scores | Below 80 |
|---|---|---|---|---|---|---|---|---|---|
| `oo` tier: `build_model`, `derive_diagrams` | 2 | 1217 | 14758 | 1449 | 17424 | 18641 | 25 | 81–98 | 0 |
| Drawing: 25 `build_diagram` calls | 25 | 1998 | 12385 | 2642 | 17025 | 64977 | 25 | 79–100 | 2 |

Both write the domain once, and that dominates: the spec is 14,758 tokens, the 25 drawing specs
12,385 (they leave out what only the model holds: responsibilities, collaborations' contexts,
`knows`/`does`), so with prompt caching the two cost the same within 3% (17,424 against 17,025).
Everything around it differs: 2 calls against 25, 1,449 tokens of answers against 2,642 (the
extension's own are 523 for the build, 1,529 for the derivation and 3,715 for the 25 builds; each
derived diagram keeps its id, since a derived sequence diagram is named like its collaboration
and interaction), a tier listing 781 tokens shorter, and without prompt caching, where every turn
resends the definitions, 18,641 against 64,977 tokens. Every
derived diagram reaches the profile's target and two drawn diagrams do not; the derived ones
show the model's own elements, so a change to the model is a `build_model` upsert and one
`derive_diagrams` (a second derivation of the unchanged model created, updated and deleted
nothing), where the drawn ones are 25 more calls. The extension's validation drew the same 25
diagrams by hand in 156 calls with about 55,000 result tokens (its README).
Live, the two calls took 50 s and drawing 47 s; extension #38's layouts that fit a page cost
both about twice what the phase 1h build took (23 s and 29 s).

### ThingsBoard acceptance through the `oo` tier

`scripts/acceptance-oo.mjs` runs the same domain the way a client of this server does: the built
server started with `--tools oo` over stdio, `build_model` with the spec, `derive_diagrams`, then
for every diagram `diagram_quality` (the score and extension #38's hard-limit `failures`) and
`view_diagram` with `path`, which writes the PNG to disk. It derives the class diagrams per class
view (the spec's default) and again per package (`policy: {classDiagrams: "perPackage"}`), the
two sets the extension's reviewers rated, and records every call into
`scripts/benchmark-data/oo-acceptance-7.1.1.json` (StarUML 7.1.1, extension 0.3.0 phase 1j,
0.9.1 of this server).

| Step | Calls | Call tokens | Result tokens |
|---|---|---|---|
| `build_model` + `derive_diagrams` (class views) | 2 | 14,743 | 1,436 (518 + 918) |
| per diagram `diagram_quality` + `view_diagram` to disk, 25 diagrams | 50 | | 1,763 (376 for the images) |
| `derive_diagrams` per package, then the same for 30 diagrams | 61 | | 3,203 |
| Whole run | 113 | 19,080 | 6,402 |

The images are 3.2 MB (class views) and 3.7 MB (per package) of PNG on disk and 376 and 450
tokens of answers; inline, the 25 would be about 29,200 vision tokens (section "Image size"). The
run took 85 s.

Class-view set, every diagram 80 or more, none failing a hard limit (the live suite asserts both):

| Diagram | Kind | Score | Loop's score | Failures |
|---|---|---|---|---|
| ThingsBoard packages | package | 90 | 90 | none |
| Class - Entities and DAO | class | 93 | 93 | none |
| Class - Application Services | class | 94 | 94 | none |
| Class - Rule Engine | class | 93 | 93 | none |
| Class - Transport | class | 81 | 81 | none |
| Class - Actor System | class | 98 | 98 | none |
| Class - Security | class | 89 | 89 | none |
| Seq - Telemetry ingestion over MQTT | sequence | 94 | 94 | none |
| Seq - Rule chain processing | sequence | 92 | 92 | none |
| Seq - Device provisioning | sequence | 97 | 97 | none |
| Seq - Device claiming | sequence | 92 | 92 | none |
| Seq - REST login | sequence | 94 | 94 | none |
| Use Cases - Tenant Administrator | usecase | 85 | 85 | none |
| Use Cases - Customer User | usecase | 96 | 96 | none |
| Use Cases - Device | usecase | 85 | 85 | none |
| Use Cases - System Administrator | usecase | 98 | 98 | none |
| State - Device lifecycle | statemachine | 85 | 85 | none |
| State - Alarm lifecycle | statemachine | 96 | 96 | none |
| State - Rule node lifecycle | statemachine | 92 | 92 | none |
| Activity - Rule chain execution | activity | 82 | 82 | none |
| ThingsBoard data model | erd | 94 | 94 | none |
| ThingsBoard containers | c4 | 90 | 90 | none |
| Deployment - Microservices | deployment | 83 | 83 | none |
| Deployment - Monolith | deployment | 98 | 94 | none |
| ThingsBoard Features | mindmap | 86 | 86 | none |

`Class - Rule Engine` is drawn at aspect 3.14, past the profile's 3:1, and still fails nothing: the
limit applies to a diagram larger than the page. The loop's score in the `derive_diagrams` answer
is the score `diagram_quality` reads afterwards for every diagram but `Deployment - Monolith`
(94 in the answer, 98 read back and in every later derive with nothing changed), an extension
0.3.0 quirk the live suite names.

The per-package set has the same 18 other diagrams with the same scores and these class diagrams:

| Class diagram (per package) | Score | Failures |
|---|---|---|
| Domain Model (common.data) | 98 | none |
| Messaging (common.message, common.queue) | 100 | none |
| Actor Framework (common.actor) | 99 | none |
| Persistence (dao) | 94 | none |
| Rule Engine API | 77 | none |
| Rule Node Library | 81 | none |
| Transport API (common.transport) | 98 | none |
| Protocol Transports | 94 | none |
| Actor System (application.actors) | 98 | none |
| Application Services | 82 | none |
| Security | 89 | none |

`Rule Engine API` is the one the extension's own #38 report lists short: eight rule nodes each
depend on the same three services, and every drawing of them within 3:1 scores 69 to 77. It
breaks no hard limit, so the score is not capped; `quality.failing` names it as `Rule Engine API
77`, and the live suite asserts it is the only diagram below 80.

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
