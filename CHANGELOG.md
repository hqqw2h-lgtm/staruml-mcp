# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Bundled manifest synced from the extension's phase 1h build with 88 endpoints: `/derive_diagrams`, `/explain_model`, `/model_lint` (model first, extension #33), `/get_style_profile`, `/set_style_profile`, `/apply_style_profile`, `/explain_style_violation` (the style profile, #31), `/diagram_quality` and `/improve_diagram` (the quality loop, #32); `override` on the endpoints a strict profile locks and on saving and exporting; `capabilities` on `/introspect`. `/build_model`'s spec is strict: a key outside the object vocabulary, geometry or colour included, is `INVALID_ARGUMENT` before the extension sees it (#4).
- `describe_endpoints` groups the style profile endpoints under `style`, `diagram_quality`, `improve_diagram` and `model_lint` under `quality`, and `derive_diagrams` and `explain_model` under `model` (#8).
- Authoring answers carry the extension's `style` and `quality` reports compacted wherever they appear: renames as `{from: to}`, the loop's outcome as `{score, target, iterations, findings}` with the findings left counted by rule name; 25 tokens instead of 62 for a report with one finding (#16).
- `STYLE_LOCKED` (403) and `SAVE_BLOCKED` (409) come with hints: a strict profile's remedies (`improve_diagram`, `apply_style_profile`, a rebuild, `override: true` only for a change the user asked for, turning strict off), and the first lint errors that block saving with `uml_lint`, `model_lint` and `override` (#16, #17).

## [0.6.0] - 2026-10-06

Built against staruml-mcp-extension 0.3.0 with 79 endpoints (extension phase 1g: model first,
design patterns as data, annotated exports, themes). In short, by phase:

- **2i** (#4, #8, #10, #13): `build_model` and `apply_pattern` in the core tier, the pattern
  library as resources, the `apply-pattern` prompt and the skill's "Model first" and "Design
  patterns with correct properties"; `annotate` on `export_diagram` and `view_diagram`; the
  `package`, `component` and `deployment` kinds in `build_diagram`'s listing. `introspect`,
  `describe_diagram`, `validate_model` and `search_types` move to `call_endpoint` to keep the core
  tier under 2,000 tokens.

The core tier lists 19 tools in 1,973 tokens (o200k_base). Applying Strategy to an existing
three-class model costs 780 tokens with `apply_pattern`, 1,093 with a dry run first, and 2,076
writing the same nine changes as one `batch`; all three reach `detect_patterns` confidence 1.

### Added
- Bundled manifest synced from the extension's phase 1g build with 79 endpoints: `/build_model`, `/sync_operations`, `/check_messages`, `/list_patterns`, `/describe_pattern`, `/apply_pattern`, `/detect_patterns`, `/apply_preset`, `/describe_type`, `/apply_theme`, and `annotate` on `/export_diagram` (#4).
- `build_diagram`'s listed grammar names the `package`, `component` and `deployment` spec shapes; its description no longer promises ids, which the extension answers with `result: "ids"` only (#4, #8).
- `export_diagram` lists `annotate` (`paths` or `ids`: each view labelled on the image, never on the model) and answers the labels without the extension's `ref`, since each label's text is already a reference. `view_diagram` takes `annotate` too: in the viewer the SVG carries the labels, and without MCP Apps the labelled PNG comes from `export_diagram`; without the extension it is refused with `EXTENSION_REQUIRED` rather than showing an unlabelled picture (#4, #10).
- `build_model` in the core tier (#13): a model without diagrams from an object-level spec, listed as `spec` (one line naming the sections and the relationship verbs `owns`, `has`, `uses`, `isA`, `implements`, `knows`), `upsert` and `dryRun` in 125 tokens against the manifest's 488; `parent` and `result` pass unlisted, and the body is checked against the whole request schema before it is sent. A dry run answers its changes by path with the `/batch` ops counted and the "$m0" placeholder ids left out.
- `apply_pattern` in the core tier (#13): `pattern`, `bindings` (by role: a path, a new name, `{new: {name}}` or a list), `diagram` and `dryRun` in 112 tokens against 454; `variant`, `parent`, `sequence` and `upsert` pass unlisted. A bad binding is `INVALID_ARGUMENT` before StarUML sees it. The answer names elements by path: each role's elements, created and updated elements as `{path: type}` and `{path: fields}`, every property set grouped as `{path: {field: value}}`; `apply_preset` answers the same way and `detect_patterns` names each role's elements by path.
- `describe_endpoints` groups `patterns` (`list_patterns`, `describe_pattern`, `detect_patterns`, `apply_preset`), `model` (`sync_operations`, `check_messages`) and `style` (`apply_theme`, `set_view_style`); `describe_type` joins `meta`. Dry runs of `sync_operations` and `apply_theme` count their ops (#8, #13).
- Resources `staruml://patterns` (the library: category, intent, roles, variants) and `staruml://pattern/{name}` (one pattern's roles, members, relationship ends and properties), cached until `doctor` reloads the catalog (#13).
- Prompt `apply-pattern` (`pattern`, `scope`, `diagram`): the pattern list when none is named, `describe_pattern`, bindings by path, `apply_pattern` dry run and apply into `scope`, `view_diagram` with path labels, and `detect_patterns` to confirm confidence 1 (#13).
- The skill's sections 5, "Model first" (`build_model` with the relationship verbs as a table, responsibilities as documentation, dry run then build, diagrams of the model after), and 6, "Design patterns with correct properties" (the library, bindings by path, dry run, apply with a diagram, `detect_patterns`, `apply_preset`, `describe_type`), each with examples the tests run offline and live (#13, #12).
- Property and fuzz tests for the bindings and the model spec: every valid binding is accepted and every bad one refused, any object is a spec and nothing else, random JSON in either resolves to a result and a refusal never reaches the extension; dry-run and property-grouping invariants (#14).
- `scripts/load-test.mjs --model` and `--pattern` drive dry runs of `build_model` and `apply_pattern`, in CI in one session; the soak rotation includes both (#14).
- `npm run benchmark:tokens` adds "apply Strategy to an existing class model" from a recording of StarUML 7.1.1 (`scripts/capture-pattern.mjs`) (#13, #5).

### Changed
- `describe_diagram`, `validate_model` and `search_types` leave the core tier with `introspect` to keep it under 2,000 tokens with `build_model` and `apply_pattern`: `diagram_as_text`, always listed, reads a diagram in as many tokens as `describe_diagram`; `validate_model` is a final check that now sits with `uml_lint` in the `quality` group; the spec tools take names, not metamodel ids. Their short listings and answer shapes stay, through `call_endpoint` and when named in `--tools`. The prompts and the skill name them through `call_endpoint`; the core tier lists 19 tools in 1,973 tokens (#8, #13).
- `update_element`, `batch` and `export_diagram` list shorter parameter descriptions (186, 144 and 138 tokens) (#8).
- `introspect` leaves the core tier to make room under the 2,000-token budget: `doctor` reports both versions and `search_types` and `staruml://introspect/metamodel` answer type questions. `call_endpoint({name: "introspect"})` now applies the summary tool's defaults (versions only, the metamodel with `types`); the extension's own default, every section, is 522 KB. `--tools core,introspect` lists the summary tool as before (#8).

### Fixed
- The live suite reopened the original project through `open_project` as a tool, which the core tier the suite runs does not list, so StarUML stayed on the suite's last project; it goes through `call_endpoint` and reports a failure (#14).

## [0.5.0] - 2026-10-05

Built against staruml-mcp-extension 0.3.0 with 69 endpoints (extension phases 1e to 1g: path
references, canonical field names, lints, dry runs, diffs and snapshots). In short, by phase:

- **2h-a** (#14): stateful HTTP sessions with an idle timeout and a cap; caches for compiled
  manifest entries and catalogue reads; property, fuzz, mutation and soak verification layers.
- **2g** (#4, #8, #13, #14): the 69-endpoint manifest with canonical names and paths wherever an
  element is taken; `lint_diagram` in the core tier, `build_diagram` dry runs, `uml_lint`,
  `diff_diagram` and snapshots in their own groups, hints for the reference error codes; the
  `improve-diagram` prompt and the skill's build loop and UML playbook; a 4 MiB cap on HTTP
  request bodies.

The core tier lists 21 tools in 1,992 tokens (o200k_base). Fixing a recorded messy diagram costs
2,325 tokens with the lint loop and leaves no finding, against 1,846 tokens and five findings by
eye.

### Added
- Bundled manifest re-synced from the extension's phase 1g build, still 69 endpoints: `build_diagram` kinds `package`, `component` and `deployment` and `showNamespace`, and `result: terse|ids|full` on `/batch` and `/build_diagram`, whose answers are now terse by default (counts and the diagram, or each op's success and id). `batch` passes `result` through unlisted; `generate_diagram` asks `build_diagram` for `ids`, so its answer still names every node's ids (#4, #7).
- `scripts/load-test.mjs --lint` drives `lint_diagram`, also in CI in one session; the soak rotation includes it (#13, #14).
- Stateful HTTP sessions: `initialize` over `--transport http` opens a session (`Mcp-Session-Id`, SDK `sessionIdGenerator`) whose requests all reach one McpServer, so `view_diagram` shows the inline viewer to HTTP clients that render MCP Apps or read the viewer, and `notifications/tools/list_changed` reaches every live session when `doctor` reloads the manifest or switches the tier. `--session-timeout` (default `30m`) closes a session with no request in flight, `--max-sessions` (default 64) closes the least recently used beyond the cap and `0` turns sessions off. A request without a session id is still served statelessly; the loopback `Host`/`Origin` check runs before both. `scripts/load-test.mjs --session` drives one session (#14).
- Caches: tools compiled from manifest entries are kept by the entry's JSON (bundled manifest 37 ms cold, 1 ms cached), and `/introspect` answers (the `introspect` tool, `staruml://introspect/metamodel`) and `describe_endpoints` answers are kept until `doctor` reloads the catalog or switches the tier. Failed reads are not cached (#14).
- Verification layers, listed with how to run each in `docs/verification.md`: property-based tests with fast-check (`tests/properties.test.ts`: compaction, tiers, batch references and escapes, resource URIs, descriptions, loopback names), fuzz tests of `call_endpoint` and `batch` with random JSON (`tests/fuzz.test.ts`), Stryker mutation testing of `src/` with an 85% break threshold (`npm run test:mutation`, weekly in `.github/workflows/mutation.yml`; 92.89% of 2,477 mutants killed or timed out), and `npm run soak-test` (2,000 calls over stdio, RSS, live heap and p99 within 25%), run with the live suite and live load tests by `.github/workflows/live.yml` on a self-hosted StarUML runner (#14).

- Bundled manifest synced from extension 0.3.0 with 69 endpoints: `/lint_diagram`, `/uml_lint`, `/diff_diagram`, `/snapshot`, `/diff_since`, `/restore_snapshot`, `/create_view_of`, `/divide_fragment`, path references wherever an id is taken (`Model/Shop/Order`, `Order.total`, `Order#pay()`, a diagram name, `Order@Main`, `@current`, `@project`), canonical field names (`ref`, `refs`, `diagram`, `diagrams`, `tail`, `head`, `parent`, `container`, `views`, `models`) with the old names kept as `x-alias-of` aliases, and `build_diagram` `dryRun`, `prune`, `reuse`, `text`/`format` (PlantUML, SQL DDL, JSON Schema) and the `requirement` and `c4` kinds. Listings and `describe_endpoints` show canonical names only; `call_endpoint`, `batch` and the short-listed tools rename an alias before checking the body, as the extension does, and refuse both spellings of one field with `INVALID_ARGUMENT`; an issue names the field as the caller wrote it (#4, #8).
- `view_diagram` and `diagram_as_text` take `diagram`, an id or a path; `id` still passes unlisted. Without the viewer, `view_diagram` resolves a path through the extension to the id StarUML's built-in PNG export needs (#4).
- Property tests: no listing shows an alias and every alias's field is listed; renaming keeps every value, is idempotent and refuses two spellings of one field; every field documented as taking an id or a path accepts any path string. A fuzz test sends random paths through every core tool field that takes one and requires them to reach the extension unchanged (#14).

### Changed
- `update_element` lists `ref` and `parent`, `describe_diagram` and `export_diagram` `diagram`, `validate_model` `scope`, each an id or a path; the `review-diagram` prompt takes `diagram` (default `@current`) instead of `diagramId`, and `model-codebase` describes the diagram by name. The skill's examples use paths where an element exists already (`Billing/Invoice`, `@project`, a diagram name) and `$name` references for what a batch creates, and its new "Ids and paths" section lists the forms (#4, #12).
- `get_element_by_id` and `delete_element` list a whole one-line description and `ref`; the manifest's descriptions ran past 100 characters and were cut. The instructions list the path forms once. `batch` no longer lists its patterns and minimum, `export_diagram` its scale bounds, `introspect` and `describe_endpoints` their array item types, all still checked; with `lint_diagram` and `build_diagram`'s two flags the core tier lists 21 tools in 1,992 tokens (#8, #13).
- Summaries carry the extension's `path`; the instructions say so. Hand-written listings no longer show `minLength: 1` on strings or the `describe_endpoints` group enum (the index names the groups); both are still checked. The core tier listed 20 tools in 1,973 tokens before `lint_diagram` (#8).

### Security
- The HTTP transport reads every POST body itself, session or not, and refuses one over 4 MiB (the MCP SDK's `MAXIMUM_MESSAGE_SIZE`) with `413` and `Connection: close` without reading the rest. The stateless path read bodies without a limit, and the SDK's Streamable HTTP transport reads a session's without one (#14).

- `lint_diagram` joins the core tier (#13): a one-line listing of `diagram` and `rules`, findings answered with the diagram as its path and without the ids their paths name; each `autofix` is a `{path, body}` request, a `batch` op as it stands. `uml_lint`, `diff_diagram`, `snapshot`, `diff_since` and `restore_snapshot` are reached through `call_endpoint` in the new `describe_endpoints` groups `quality` (with `validate_model`, `lint_diagram`) and `history` (with `undo`, `redo`); `uml_lint` and `diff_diagram` answers are shaped like `lint_diagram`'s (#13, #8).
- `build_diagram` lists `prune` and `dryRun`; a dry run answers the plan's creates, updates and deletes with the `/batch` ops counted, and without the "$name" placeholder ids (#13).
- Hints for the extension's reference codes (#13): `AMBIGUOUS_REF` names up to five candidates by path, or by id where paths collide; `DUPLICATE_NAME` names the existing sibling and suggests referring to it, `build_diagram`'s `reuse`, a rename or `allowDuplicateNames: true`; `SNAPSHOT_STALE` asks for a new snapshot; `UNSUPPORTED_SYNTAX` points at the named construct and at building from a spec.
- Prompt `improve-diagram` (#13): snapshot, `lint_diagram` and `uml_lint`, every autofix in one `batch` and the `uml_lint` fixes by hand, repeated until no error or warning is left (at most three rounds), then `view_diagram`, `diff_since`, and `restore_snapshot` if the result reads worse.
- The skill's section 4, "The build loop and drawing good UML": dry run, build, lint and autofix, look; snapshots; and what a readable diagram needs (one concern per diagram and when to split, naming, direction and layering, grouping by package, multiplicities and navigability, composition against aggregation, per kind for sequence, use case, state machine and ER diagrams, with the `uml_lint` rule each maps to). Its examples run a dry run, `lint_diagram` and `uml_lint` (#13, #12).
- `npm run benchmark:tokens` adds "fix a messy diagram" from a recording of StarUML 7.1.1 (`scripts/capture-messy-diagram.mjs`): by eye (PNG, layout, PNG) 1,846 tokens leaving 5 findings, the lint loop 2,325 leaving none (#13, #5).

### Fixed
- `describe_endpoints` grouping no longer throws for an empty name: the catch-all group matched only names of one character or more. Found by the property tests (#14).
- Compact results keep a `__proto__` key of an upstream answer as data; assigning it made it the result object's prototype, so it vanished from the JSON. Found by the property tests (#14).

## [0.4.0] - 2026-10-05

First release of the [hqqw2h-lgtm fork](https://github.com/hqqw2h-lgtm/staruml-mcp), built
against the [hqqw2h-lgtm fork of staruml-mcp-extension](https://github.com/hqqw2h-lgtm/staruml-mcp-extension)
0.3.x. In short, by phase:

- **2a** (#4, #5, #6): extension tools generated from the manifest the extension publishes at
  `POST /introspect`, with a bundled copy for offline listing; terse descriptions and compact
  results; MCP resources; the `doctor` tool and startup check with version gating; an offline
  token benchmark.
- **2b** (#8): a core tier of tools, every other endpoint through `describe_endpoints` and
  `call_endpoint`, `--tools` / `STARUML_MCP_TOOLS`.
- **2c** (#4, #5, #6, #8): `batch` with `$name` references checked before sending,
  `export_diagram` as image blocks, the extension's access token and its refusals explained.
- **2d** (#4, #7, #8): `build_diagram` in the core tier, `generate_diagram` routed to it for
  names, kinds, titles and line breaks the built-in importer cannot do.
- **2e** (#10, #12): `view_diagram` with an MCP Apps SVG viewer, the `staruml` agent skill and
  plugins for Claude Code, Codex and Copilot, a comparison with drawio-mcp.
- **2f** (#11, #4, #8): diagrams read back as Mermaid or PlantUML (`diagram_as_text`, `.mmd` and
  `.puml` resources), `search_types`, `describe_diagram` and `validate_model` in the core tier,
  the `model-codebase` and `review-diagram` prompts, the 61-endpoint manifest with layout
  presets; the HTTP transport bound to loopback; ownership moved to the hqqw2h-lgtm forks.

The core tier lists 20 tools in 1,992 tokens (o200k_base); reading a six-class diagram as
Mermaid costs 267 tokens against an estimated 1,629 as a PNG.

### Security
- `--transport http` binds `127.0.0.1` by default instead of every interface, and refuses requests whose `Host` is not a loopback name or whose `Origin` is not a loopback origin with `403` (DNS rebinding protection). `--host <address>` binds elsewhere, with a startup warning that the endpoint has no authentication; the `Host`/`Origin` check is then off.
- The README explains that StarUML 7.1.1's built-in API listens on every interface without authentication and how to block port 58321 at the macOS, Linux and Windows firewalls.
- The README lists the HTTP transport's limits: no inline viewer and no `list_changed` notifications, since every request gets a fresh server.

### Added
- 100% line/branch/function/statement coverage enforced through vitest thresholds, with tool-level tests over the MCP in-memory transport, HTTP transport e2e tests, a `STARUML_LIVE=1` suite and `scripts/load-test.mjs` (#1).
- Pre-commit hook running lint-staged (#2).
- MCP resources `staruml://diagrams`, `staruml://project` and `staruml://diagram/{id}.png`, so clients with resource support fetch diagram PNGs without inlining base64 into tool results (#5).
- `npm run benchmark:tokens`: token cost of three modelling scenarios against the pre-#5 baseline (#5).
- Extension tools are generated from the manifest staruml-mcp-extension 0.3.0 publishes at `POST /introspect`: one tool per endpoint, its input schema converted from the endpoint's JSON Schema with zod's `fromJSONSchema`, `readOnlyHint`/`destructiveHint` from the manifest flags, and a one-line description of at most 100 characters. The manifest is read on start and by `doctor`; a bundled snapshot (`src/extension-manifest.json`) keeps `tools/list` complete when the extension is unreachable. 29 tools with extension 0.3.0, among them `create_relationship`, `add_attribute`, `add_operation`, `add_parameter`, `add_enumeration_literal`, `add_template_parameter`, `add_slot`, `add_tag`, `set_stereotype`, `set_documentation`, `introspect` and `debug` (#4).
- `npm run sync:manifest` refreshes the bundled manifest from a running extension or a recorded `/introspect` response (#4).
- Resource `staruml://project/tree`: the ownership tree of model elements and diagrams, built from paged `find_elements` summaries (#4).
- Bundled manifest synced from extension 0.3.0 with 50 endpoints (views, layout, style, selection, editor state, export, undo/redo, `/batch`). `batch` and `export_diagram` join the core tier. `batch` lists a short hand-written schema and description, checks every op against its endpoint's manifest schema and its `$name` references against earlier ops before sending, and returns results without the echoed op path; `export_diagram` returns PNG/JPEG as an image block. `describe_endpoints` gains an `editor` group (#4, #8).
- `--ext-token <token>` and `STARUML_EXT_TOKEN`: the extension's access token, sent as `Authorization: Bearer` with every extension request, the startup and `doctor` probes included, never to the built-in API. A 401 on `GET /` fails the `extension` check with how to set or clear the token in StarUML (Server Info, Generate Access Token...). The extension's `UNAUTHORIZED`, `FORBIDDEN_ORIGIN`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `RATE_LIMITED` (with `Retry-After`) and `TIMEOUT` refusals carry a hint naming the preference involved (#4, #6).
- `npm run benchmark:tokens` adds a native class diagram scenario and replays both native-diagram scenarios with one `batch` call and `export_diagram` on servers that list them; `scripts/load-test.mjs --batch` drives a four-op batch, also run in CI (#5).
- Bundled manifest synced from extension 0.3.0 with 56 endpoints: `/build_diagram`, `/describe_commands`, `/list_code_generators`, `/generate_code`, `/reverse_code`, `/export_diagrams`. `build_diagram` joins the core tier with a one-line description and six listed parameters (`kind`, `spec`, `mermaid`, `name`, `upsert`, `direction`); its body, unlisted `parentId` and `autoLayout` included, is checked against the manifest's whole request schema before it is sent. `describe_endpoints` gains a `code` group for the code generation endpoints; `describe_commands` joins `command` (#4, #8).
- `DIALOG_REQUIRED` (422) refusals carry a hint: `describe_commands` for `execute_command`, `list_code_generators` for `generate_code`/`reverse_code`. An extension error's `details` is passed through as `structuredContent.error.details` (an atomic batch's `{index, results}` with compacted results) and shown as a `Details:` line, without a rolled-back batch's results (#4).
- `batch` references accept numeric path segments (`"$frag.model.operands.0"`), as the extension does (#4).
- `generate_diagram` takes `name` and `kind` (`activity`, `usecase`) and routes to the extension's `build_diagram` when the call needs it: a name or kind, a front matter or `title` line title, `<br/>` or `\n` in the source, or a start StarUML's built-in API refuses (`graph`, front matter, a leading comment). Plain Mermaid keeps the built-in path. Without the extension a title or line break falls back to the built-in with a note of what was left out; an explicit name or kind fails with `EXTENSION_REQUIRED`. Live tests cover upstream staruml-mcp-server #2 (names), #3 (`<br/>` stored as a newline; StarUML 7.1.1 draws it on one line) and #4 (activity and use case diagrams from a spec and from Mermaid), each exported to PNG with its views counted (#7).
- `npm run benchmark:tokens` replays the two native-diagram scenarios as one `build_diagram` call on a server that lists it, keeps the `batch` plan as "now batch", and reports two accountings side by side: definitions once per scenario, and definitions once per session (prompt caching) plus results and the calls' own tokens, with the issue #5 and #8 targets under each. `scripts/load-test.mjs --build` drives an upserting `build_diagram`, also run in CI (#5, #8).
- `doctor` tool and `--doctor` flag: Node version, both StarUML ports, extension and StarUML versions from `/introspect`, and the number of extension tools, with a fix for every failing check (install URL, enable `apiServer`, restart StarUML). The same report is written to stderr on start (#6).
- `view_diagram` tool and resource `ui://staruml/viewer.html`: a client that renders MCP Apps (declares `io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`, or has read the viewer) gets the diagram as SVG from the extension's `export_diagram` in an interactive viewer with pan, zoom, fit, the diagram's name and a dark mode; the SVG travels in `structuredContent` and the model gets a one-line summary. Every other client gets the PNG `get_diagram_image_by_id` returns. Implements the MCP Apps convention of protocol 2026-01-26 (ext-apps 1.7.4) on MCP SDK 1.29.0, which has no UI helpers (#10).
- Agent skill `plugins/claude-code/skills/staruml/SKILL.md` (doctor first, the `build_diagram` spec of every kind with an example, Mermaid routing, `batch` and `$name`, `describe_endpoints` / `call_endpoint`, view and export, token tips, the access token), with Codex and Copilot copies written by `npm run sync:skills`; `.claude-plugin/marketplace.json` and a Claude Code plugin that also registers the MCP server, plus Codex and Copilot plugin manifests and marketplaces. `tests/skill.test.ts` runs every tool call in the skill through the in-memory transport and fails on stale copies; the live suite runs them against StarUML (#12).
- `docs/comparison-drawio.md`: a feature-by-feature comparison with jgraph/drawio-mcp (#12).
- Bundled manifest synced from extension 0.3.0 with 61 endpoints: `/route_edges`, `/search_types`, `/describe_diagram`, `/validate_model`, `/export_text`, and `layout_diagram` presets, separations and `fit`. `build_diagram` lists `layout` (a preset name, checked against the manifest's enum before sending). `describe_endpoints` places `search_types` in `meta`, `validate_model` in `project` and `route_edges` in `diagram` (#4, #8).
- `diagram_as_text` tool (Mermaid by default, PlantUML with `format`) and resources `staruml://diagram/{id}.mmd` and `.puml`, through the extension's `/export_text`; the text comes in a block of its own, the kind and warnings after it (in `_meta` for the resources). `search_types`, `describe_diagram` and `validate_model` join the core tier with hand-written listings; `search_types` drops the ranking score from its hits and `describe_diagram` answers its text alone. MCP prompts `model-codebase` (reverse_code or one build_diagram, then describe and validate) and `review-diagram` (describe_diagram, validate_model, diagram_as_text, then a review), naming `call_endpoint` for endpoints the tier does not list (#11).
- `npm run benchmark:tokens` adds "read and explain a diagram": a six-classifier diagram recorded from StarUML 7.1.1 by `scripts/capture-read-diagram.mjs` read as a PNG (1,629 tokens with the estimated image), an element dump (4,452), `describe_diagram` (286), Mermaid (267) and PlantUML (283) (#11).
- The skill reads diagrams as text, searches types and validates models, with tested examples of each (#11, #12).

### Changed
- `package.json` (`repository`, `bugs`, `homepage`, `mcpName` `io.github.hqqw2h-lgtm/staruml-mcp`), `server.json`, the plugin manifests and marketplaces, the README and the extension install URL in `doctor` and error hints point at the hqqw2h-lgtm forks (`https://github.com/hqqw2h-lgtm/staruml-mcp-extension`). The npm package name is unchanged.
- The startup line names the bound address: `http transport ready on http://127.0.0.1:58323/mcp`.
- The core tier lists 20 tools in 1,992 tokens with the four new reads. To make room, `find_elements` and `update_element` list hand-written descriptions (95 and 202 tokens instead of 130 and 274), short listings leave string lengths and integer bounds to the check against the whole request schema and keep `required`, no listing carries `additionalProperties: {}` or `propertyNames: {type: "string"}`, and `get_all_diagrams_info` / `get_diagram_image_by_id` no longer name their resources. `--tools all` lists 68 tools in 9,136 tokens (#8, #11).
- No tool lists the projection parameters (`summary`, `fields`, `depth`) any more, read-only ones included; every tool still accepts and forwards them and the instructions name them once. `get_element_by_id` and `find_elements` list 126 tokens less, which pays for `build_diagram`'s `layout` and keeps the core tier at 1,884 tokens (#8).
- Token benchmark re-run with `view_diagram` listed: the core tier is 16 tools and 1,992 definition tokens, `--tools all` 62 tools and 9,322; README numbers updated (#10, #12).
- `export_diagram` lists a hand-written description and shorter parameter descriptions, 147 tools/list tokens instead of 208, which keeps the core tier with `view_diagram` within 2,000 tokens; bodies are still checked against the manifest's whole request schema before they are sent (#10).
- The unreachable hints name the `doctor` tool, which the server instructions no longer repeat with every turn (#7).
- Targets staruml-mcp-extension 0.3.x. Element results are its summaries `{_id, _type, name, _parent}`; `fields`, `summary`, `depth`, `limit` and `cursor` are passed through (read-only tools list the projection, writing tools accept it unlisted); `/create_*_with_view` return `{view, model}`; wrong-typed arguments are rejected by the tool's schema before any request; the extension's error codes (`INVALID_ARGUMENT`, `NOT_FOUND`, `NO_PROJECT`, `STARUML_ERROR`, …) and HTTP statuses 400/404/409/422 are passed through, and `UNKNOWN_ENDPOINT` gets the upgrade hint (#4).
- With an incompatible extension (another major version, or another minor while 0.x, e.g. 0.2.2) no extension tools are listed and the report names the version to install (#6).
- The hand-written client methods for extension endpoints are replaced by `callExtension(path, body)`; `pingExtension` is replaced by `extensionBanner()`, and probes time out after 2 s (#4, #6).
- zod 4 (`^4.6.5`), the version the extension's schemas are written with (#4).
- `npm run benchmark:tokens` compares three servers on 0.3.0-shaped data: pre-#5, #5 and the current one (#5).
- `src/index.ts` exports `main(argv)`; the CLI starts only when the module is the process entrypoint (#1).
- Port flags reject non-integer values such as `8080abc` instead of truncating them (#1).
- Tool descriptions are one line and each parameter is described once in its schema; the repeated extension install note is gone, since EXTENSION_UNREACHABLE carries it (#5).
- Tool results are minified JSON without `null`/empty properties, echoed arguments or prose prefixes; acknowledgements are `ok` and `get_current_diagram_info` returns `null` when no diagram is active (#5).
- Tool failures carry the `error` (and `code`) from the JSON body of non-2xx responses instead of `HTTP 400 Bad Request`, plus `structuredContent.error` with a stable `code` and a hint for connectivity and version-mismatch failures (#3).

## [0.3.2] - 2026-04-20

### Fixed
- HTTP transport: non-`/mcp` paths now return **JSON 404** instead of plaintext `Not Found`. Previously, MCP clients probing OAuth discovery endpoints (`/.well-known/oauth-authorization-server`, etc. per RFC 8414/9728) received a plaintext body and crashed their JSON parser with `SyntaxError: Unexpected identifier "Not"` — manifesting as `SDK auth failed: HTTP 404: Invalid OAuth error response` in Claude Code. Discovered while connecting Claude Code v1.x to the `/mcp` endpoint.
- Added explicit handling for `/` (returns JSON server banner) and `/.well-known/*` (returns JSON 404 advertising `auth_required: false`) so MCP clients know the server is unauthenticated without needing to parse malformed responses.
- `500 Internal Server Error` responses also now JSON-formatted with the actual error message.

## [0.3.1] - 2026-04-20

### Changed
- **Default HTTP `--port` changed from `3000` → `58323`** to eliminate conflicts with Next.js/Vite/React dev servers (which claim `3000` by default) and to align with the StarUML ecosystem (`58321` built-in API, `58322` extension, `58323` MCP HTTP).
- README now matches the CLI default: install snippets no longer require `--port 3333`. Use `npx -y staruml-mcp --transport http` and point Claude Code at `http://localhost:58323/mcp`.

### Migration
- Existing users with `claude mcp add --transport http staruml http://localhost:<old>/mcp` should update the URL to `:58323`, or continue overriding via `--port <old>`.
- The `--port` flag is retained, so power users with port conflicts can still pick their own.

## [0.3.0] - 2026-04-20

### Added
- **`create_element_with_view`** tool — creates a model element AND its visual View on a target diagram in one call. Required to populate native typed diagrams (UMLUseCaseDiagram, UMLActivityDiagram, UMLClassDiagram, etc.); `create_element` alone only adds to the model tree without putting shapes on the canvas. Returns both `view._id` (for subsequent edge connections) and `model._id`.
- **`create_edge_with_view`** tool — connects two existing Views on a diagram with a typed edge (`UMLAssociation`, `UMLControlFlow`, `UMLMessage`, `UMLGeneralization`, `UMLDependency`). Pair with `create_element_with_view` to build full diagrams programmatically.

### Changed
- `create_element` description clarified: it creates MODEL only. Use `create_element_with_view` for native typed diagrams.

### Requires
- `staruml-mcp-extension` **v0.2.0+** (for `/create_element_with_view` and `/create_edge_with_view` endpoints, and for the fixed cascade `delete_element`). Install or upgrade via StarUML → Extension Manager → Install From URL: `https://github.com/ezrabrilliant/staruml-mcp-extension`.

## [0.2.2] - 2026-04-20

### Fixed
- HTTP transport: create fresh `McpServer` + `StreamableHTTPServerTransport` **per request** instead of sharing a singleton. The previous singleton pattern rejected any request after the first `initialize` with HTTP 500, breaking MCP clients that reconnect. This is the canonical stateless pattern from MCP SDK docs.

## [0.2.1] - 2026-04-20

### Fixed
- HTTP transport: switched to **stateless mode** (`sessionIdGenerator: undefined`) to fix "Server already initialized" error when Claude Code's MCP client reconnects. Previously used stateful sessions with a singleton transport, which only accepted one initialize call across its lifetime.

## [0.2.0] - 2026-04-20

### Added
- **15 new tools** that call `staruml-mcp-extension` (port 58322) for operations not exposed by StarUML's built-in HTTP API:
  - Commands: `get_all_commands`, `execute_command` (unlocks all 138+ built-in StarUML commands)
  - Project lifecycle: `get_project_info`, `save_project`, `save_project_as`, `new_project`, `open_project`
  - Element CRUD: `get_element_by_id`, `find_elements`, `create_element`, `update_element`, `delete_element`
  - Diagram management: `create_diagram` (typed UML: UMLClassDiagram, UMLUseCaseDiagram, UMLSequenceDiagram, UMLActivityDiagram, ERDDiagram, etc.), `switch_diagram`, `close_diagram`
- New CLI flag `--ext-port <number>` (default `58322`) to configure extension port.
- `StarUMLClient.pingExtension()` helper to detect if the extension is installed.

### Requirements for new tools
The 15 extension tools require `staruml-mcp-extension` installed in StarUML.
Install via StarUML → Tools → Extension Manager → Install From URL:
`https://github.com/ezrabrilliant/staruml-mcp-extension`.

The original 4 Mermaid/diagram tools continue to work without the extension.

## [0.1.0] - 2026-04-20

### Added
- Initial release of `staruml-mcp`.
- StarUML HTTP API client (`StarUMLClient`) with zod-validated responses, structured `StarUMLApiError`, configurable host/port, and `ping()` health check.
- MCP server exposing four tools that mirror StarUML's HTTP API surface:
  - `generate_diagram` — generate UML diagrams from Mermaid code (supports `classDiagram`, `sequenceDiagram`, `flowchart`, `erDiagram`, `mindmap`, `requirementDiagram`, `stateDiagram`).
  - `get_all_diagrams_info` — list all diagrams in the open project.
  - `get_current_diagram_info` — inspect the currently active diagram.
  - `get_diagram_image_by_id` — export a diagram as PNG.
- Dual transport support: `stdio` (default) and Streamable HTTP (stateful session mode with UUID session IDs).
- CLI (`commander`-based) with flags: `--transport`, `--port`, `--api-port`, `--api-host`.
- Build pipeline with `tsup` producing a single ESM bundle targeting Node 20+.
- Strict TypeScript configuration (`strict: true`, `noUncheckedIndexedAccess`).
- MIT license and MCP Registry metadata (`mcpName: io.github.ezrabrilliant/staruml-mcp`).

### Acknowledgments
- Inspired by [`staruml/staruml-mcp-server`](https://github.com/staruml/staruml-mcp-server) by Minkyu Lee (StarUML creator).
- Reimplemented with multi-transport support to work around stdio MCP registration issues in some clients (e.g., [Claude Code #36914](https://github.com/anthropics/claude-code/issues/36914)).

[Unreleased]: https://github.com/hqqw2h-lgtm/staruml-mcp/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/hqqw2h-lgtm/staruml-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/hqqw2h-lgtm/staruml-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hqqw2h-lgtm/staruml-mcp/compare/v0.3.2...v0.4.0
[0.1.0]: https://github.com/ezrabrilliant/staruml-mcp/releases/tag/v0.1.0
