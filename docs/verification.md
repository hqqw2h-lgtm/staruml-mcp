# Verification

How staruml-mcp is checked, layer by layer: what each layer proves, where it lives and how to run
it. Every command runs from the repository root with Node 22 (`npm ci` first). The layers that
need no StarUML run in CI on every push (`.github/workflows/ci.yml`); mutation testing runs weekly
(`mutation.yml`); the layers that drive a real StarUML run on demand on a self-hosted runner
(`live.yml`).

| Layer | Proves | Where | Run | CI |
|---|---|---|---|---|
| Unit and tool-level | Every production behaviour: each tool through the MCP SDK's in-memory transport against `http.Server` stand-ins of ports 58321 and 58322, the HTTP transport and its sessions over a real socket, the CLI. 100% line, branch, function and statement coverage is a vitest threshold. | `tests/*.test.ts`, `tests/support/` | `npm test -- --coverage` | every push |
| Property | Invariants for every input, not only chosen examples: `prune` keeps every non-empty property and every array item, and is idempotent except that a second pass drops the `{}` it keeps for an object whose properties it emptied (deliberate: `{owner: {stereotype: null}}` says there is an owner); a `__proto__` key stays data; `serialize` leaves no null or empty property; `omitEcho` drops only echoed primitives; the core tier is a subset of `all` with unique names for any manifest subset, a selection selects exactly its names and every name has one group; a batch `$name` reference to the op itself or a later op is always refused, one to an earlier op with any path accepted, and a `$$`-escaped string is never read as a reference and passes through unchanged; diagram resource URIs carry any id through percent-encoding and back; `terseDescription` stays within 100 characters on one line; `isLoopback` accepts all of 127/8 and no `localhost.` suffix; no listed schema shows an alias of extension 0.3.0's old field names and every alias's canonical field is listed; renaming aliases keeps every value, is idempotent and refuses two spellings of one field; every field the manifest documents as taking an id or a path accepts any string over the path alphabet (`/ . # @ ( ) , \`, `@current`, `@project`). fast-check prints the shrunk counterexample and the seed. | `tests/properties.test.ts` | `npx vitest run tests/properties.test.ts` | every push |
| Fuzz | Random JSON as `call_endpoint` and `batch` arguments (any value, bodies over an endpoint's own parameter names, aliases included, unknown endpoints, malformed ops) never throws and never becomes a JSON-RPC error: every call resolves to a result, and every refusal carries `INVALID_ARGUMENT`, `UNKNOWN_ENDPOINT` or `ENDPOINT_NOT_FOUND`, or is the SDK's own input validation. The run also requires that some inputs got through every check to the stand-in. Random paths in every core tool field that takes an element reach the extension unchanged. | `tests/fuzz.test.ts` | `npx vitest run tests/fuzz.test.ts` | every push |
| Contract | The bundled manifest (`src/extension-manifest.json`) is contained in the manifest the running extension publishes: every bundled endpoint exists live, newer endpoints are listed and tolerated. | `tests/live/staruml.live.test.ts`, "called every listed tool and every endpoint of the bundled manifest" | `npm run test:live` | `live.yml` |
| Mutation | The tests fail when the code changes: Stryker mutates `src/` (2,791 mutants) and runs the tests covering each mutant. The run fails below 85% killed (`stryker.config.mjs`); the HTML report lands in `reports/mutation/`. | `stryker.config.mjs` | `npm run test:mutation` | weekly, `mutation.yml` |
| Live | Every tool, resource and prompt and every manifest endpoint against StarUML 7.1.1 with the extension, including the HTTP transport's loopback binding, the inline viewer in an HTTP session and `list_changed` reaching every session. The suite saves the open project to a temp file, works in a fresh one and reopens the original. | `tests/live/staruml.live.test.ts` | `npm run test:live` (StarUML running) | `live.yml` |
| Load | The HTTP transport under concurrency, stateless and in one session, for a plain call, `call_endpoint`, a four-op `batch`, `build_diagram` and `lint_diagram`: req/s, p50/p90/p99, zero errors; a body over 4 MiB is refused with 413 (`tests/http-transport.test.ts`). `--max-p99-ms` and `--min-rps` make it a budget. | `scripts/load-test.mjs` | `npm run build && npm run load-test -- [--session] [--call-endpoint\|--batch\|--build\|--lint] [--live]` | every push (stub), `live.yml` (StarUML) |
| Soak | 2,000 tool calls over stdio after 2,000 warm-up calls: RSS, live heap after a full GC and p99 of the last 200 calls within 25% of the first 200 (a p99 rise must also exceed 2 ms), no failed call. | `scripts/soak-test.mjs` | `npm run build && npm run soak-test` | `live.yml` |
| Skill-example replay | Every tool call written in the agent skill is accepted by the server and reaches StarUML as written; the Codex and Copilot copies match the source. Live, the same calls run against StarUML. | `tests/skill.test.ts`, `tests/support/skill.ts`, live suite "skill examples" | `npx vitest run tests/skill.test.ts`; live with `npm run test:live` | every push; `live.yml` |
| Static | Types (`tsc` strict, `noUncheckedIndexedAccess`) over src and tests, ESLint, Prettier, and the build. | `tsconfig*.json`, `eslint.config.mjs`, `.prettierrc` | `npm run typecheck && npm run lint && npm run format:check && npm run build` | every push; pre-commit (lint-staged) |

## Results

Recorded for 0.5.0 (#13) on the same machine, other agents' test suites sharing it (load average
10–16):

- **Unit, property, fuzz:** 1,155 tests, 100% lines, branches, functions and statements. Fuzz
  outcomes of one run (800 calls, the path run included): `INVALID_ARGUMENT` 138,
  `UNKNOWN_ENDPOINT` 113, SDK input validation 346, success 203. The alias property found that
  two aliases of one field (`/diff_diagram`'s `diagramId` and `id`) are refused like an alias
  beside its field, which is what the extension does; the property was written too narrowly.
- **Mutation:** 93.51%: of 2,791 mutants 2,518 killed, 92 timed out (counted as detected), 181
  survived, none uncovered; 20 minutes with 15 runners.
- **Live:** 88 passed against StarUML 7.1.1 and the extension's phase 1g build (69 endpoints
  bundled; the running build offered three more, which the suite tolerates).
- **Load:** see README, Performance, "Re-run for 0.5.0": one session, five paths, 0 errors.
- **Soak:** three runs with `lint_diagram` in the rotation, RSS +5.1 to +6.9%, live heap after GC
  +3.0 to +3.8%, p99 within the 2 ms floor, 0 errors.

Recorded for #14 on an Intel i9-9980HK (8 cores / 16 threads), macOS, Node 22.23.3, with other
test suites sharing the machine.

- **Unit, property, fuzz:** 1,044 tests, 100% lines, branches, functions and statements. The
  property tests found two faults, both fixed: `endpointGroup("")` threw, because the catch-all
  group's pattern `/./` needs one character (now `/^/`); and `prune` and `omitEcho` lost a
  `__proto__` key of an upstream answer, since `out[key] = value` sets the prototype instead of a
  property (now `Object.fromEntries`). Fuzz outcomes of one run (600 calls):
  `INVALID_ARGUMENT` 118, `UNKNOWN_ENDPOINT` 116, SDK input validation 363, success 3.
- **Mutation:** 92.89%: of 2,477 mutants 2,260 killed, 41 timed out (counted as detected), 176
  survived, none uncovered; 16 minutes with 15 runners. Most survivors are wording: CLI help
  text, hint and error prose the tests match only in part. Three runs over this work scored
  92.94%, 91.97% and 92.89%; the spread comes from static mutants (module-level constants, about
  29% of the total), whose covering tests Stryker attributes from one coverage run.
- **Live:** 80 passed against StarUML 7.1.1 and extension 0.3.0.
- **Load:** see README, Performance; one session serves 2–4x the requests per second of the
  stateless fallback.
- **Soak:** three runs, RSS +3.9 to +8.3%, live heap after GC +2.8 to +4.0%, p99 −14 to −18%
  between the first and last 200 of 2,000 calls after 2,000 warm-up calls, 0 errors. A cold run
  grows RSS by 51% while the heap after GC grows 5%: V8 sizing its spaces (README, Soak).
