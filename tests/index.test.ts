import { EventEmitter } from "node:events";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXT_TOKEN_ENV, isEntrypoint, main, parseArgs, run, TOOLS_ENV } from "../src/index.js";
import { CORE_ENDPOINTS, parseToolSelection } from "../src/tiers.js";
import packageJson from "../package.json" with { type: "json" };
import { BUNDLED_MANIFEST } from "../src/manifest.js";
import { closedPort, UpstreamFixture } from "./support/fixture.js";
import { INITIALIZE_PARAMS, rpc } from "./support/sse.js";

const ARGV0 = ["node", "staruml-mcp"];
/** Default ports would reach a StarUML running on the developer's machine. */
let OFFLINE: string[];

beforeAll(async () => {
  const refused = String(await closedPort());
  OFFLINE = [...ARGV0, "--api-port", refused, "--ext-port", refused];
});
const INDEX_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("applies defaults", () => {
    expect(parseArgs(ARGV0, {})).toEqual({
      transport: "stdio",
      port: 58323,
      apiPort: 58321,
      extPort: 58322,
      apiHost: "http://localhost",
      doctor: false,
      tools: { all: false, names: new Set(CORE_ENDPOINTS), label: "core" },
      extToken: undefined,
    });
  });

  it.each([
    ["no token when neither is set", undefined, undefined, undefined],
    ["no token when the variable is empty", undefined, "", undefined],
    [EXT_TOKEN_ENV, undefined, "from-env", "from-env"],
    ["--ext-token over the environment", "from-flag", "from-env", "from-flag"],
    ["no token for an empty --ext-token", "", "from-env", undefined],
  ])("reads %s", (_, flag, env, token) => {
    const argv = flag === undefined ? ARGV0 : [...ARGV0, "--ext-token", flag];
    expect(parseArgs(argv, { [EXT_TOKEN_ENV]: env }).extToken).toBe(token);
  });

  it("reads the process environment by default", () => {
    vi.stubEnv(TOOLS_ENV, "all");
    try {
      expect(parseArgs(ARGV0).tools.all).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["the core tier when neither is set", undefined, undefined, "core"],
    ["the core tier when the variable is empty", undefined, "", "core"],
    [`${TOOLS_ENV}`, undefined, "all", "all"],
    ["--tools over the environment", "core,save_project", "all", "core,save_project"],
  ])("selects %s", (_, flag, env, label) => {
    const argv = flag === undefined ? ARGV0 : [...ARGV0, "--tools", flag];
    expect(parseArgs(argv, { [TOOLS_ENV]: env }).tools).toEqual(parseToolSelection(label));
  });

  it("names the environment variable when its value is malformed", () => {
    expect(() => parseArgs(ARGV0, { [TOOLS_ENV]: "core;all" })).toThrow(
      `Invalid ${TOOLS_ENV}: "core;all".`,
    );
  });

  it("rejects a malformed --tools", () => {
    expect(() => parseArgs([...ARGV0, "--tools", ","], {})).toThrow('Invalid --tools: ",".');
  });

  it("reads every option", () => {
    expect(
      parseArgs([
        ...ARGV0,
        "-t",
        "http",
        "-p",
        "0",
        "--api-port",
        "1",
        "--ext-port",
        "65535",
        "--api-host",
        "http://10.0.0.2",
        "--doctor",
        "--tools",
        "all",
        "--ext-token",
        "s3cret",
      ]),
    ).toEqual({
      transport: "http",
      port: 0,
      apiPort: 1,
      extPort: 65535,
      apiHost: "http://10.0.0.2",
      doctor: true,
      tools: parseToolSelection("all"),
      extToken: "s3cret",
    });
  });

  it("rejects an unknown transport", () => {
    expect(() => parseArgs([...ARGV0, "--transport", "sse"])).toThrow(
      'Invalid --transport: "sse". Must be one of: stdio, http',
    );
  });

  it.each([
    ["--port", "65536", "0"],
    ["--port", "-1", "0"],
    ["--port", "80.5", "0"],
    ["--port", "abc", "0"],
    ["--api-port", "0", "1"],
    ["--ext-port", "", "1"],
  ])("rejects %s %j", (flag, value, min) => {
    expect(() => parseArgs([...ARGV0, flag, value])).toThrow(
      `Invalid ${flag}: "${value}". Must be an integer ${min}–65535.`,
    );
  });
});

describe("main", () => {
  it("serves the HTTP transport on the requested port", async () => {
    const server = await main([...OFFLINE, "--transport", "http", "--port", "0"]);
    try {
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await res.json()).toMatchObject({
        name: packageJson.name,
        version: packageJson.version,
      });
      expect(console.error).toHaveBeenCalledWith(
        `[staruml-mcp] http transport ready on http://localhost:${server.port}/mcp`,
      );
    } finally {
      await server.close();
    }
  });

  it("fails when the HTTP port is taken", async () => {
    const first = await main([...OFFLINE, "--transport", "http", "--port", "0"]);
    try {
      await expect(
        main([...OFFLINE, "--transport", "http", "--port", String(first.port)]),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });

  it("speaks MCP over the given stdio streams", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = await main(OFFLINE, { stdin, stdout });
    try {
      expect(server.port).toBeUndefined();
      const line = new Promise<string>((resolve) =>
        stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))),
      );
      stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE_PARAMS })}\n`,
      );
      expect(JSON.parse(await line)).toMatchObject({
        id: 1,
        result: { serverInfo: { name: packageJson.name, version: packageJson.version } },
      });
    } finally {
      await server.close();
    }
  });
});

describe("startup check", () => {
  const builtin = new UpstreamFixture();
  const extension = new UpstreamFixture();
  let upstream: string[];

  beforeAll(async () => {
    await Promise.all([builtin.start(), extension.start()]);
    upstream = [
      ...ARGV0,
      "--api-host",
      "http://127.0.0.1",
      "--api-port",
      String(builtin.port),
      "--ext-port",
      String(extension.port),
    ];
  });

  afterEach(() => {
    builtin.reset();
    extension.reset();
    process.exitCode = undefined;
  });

  afterAll(async () => {
    await Promise.all([builtin.stop(), extension.stop()]);
  });

  function serveManifest(endpoints: typeof BUNDLED_MANIFEST.endpoints): void {
    extension.banner = { name: "staruml-mcp-extension", version: "0.3.0" };
    extension.reply("/introspect", {
      body: { success: true, data: { ...BUNDLED_MANIFEST, endpoints } },
    });
  }

  it("offers the tools of the live manifest and logs the report to stderr", async () => {
    serveManifest(BUNDLED_MANIFEST.endpoints.filter((e) => e.path === "/get_element_by_id"));
    const server = await main([...upstream, "--transport", "http", "--port", "0"]);
    try {
      const { message } = await rpc(`http://127.0.0.1:${server.port}`, 1, "tools/list");
      const names = (message.result!.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain("get_element_by_id");
      expect(names).not.toContain("find_elements");
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[staruml-mcp\] startup check\n.*manifest +ok +1 endpoints from the live manifest/s,
        ),
      );
    } finally {
      await server.close();
    }
  });

  it("lists the tier --tools asks for and reports it", async () => {
    serveManifest(BUNDLED_MANIFEST.endpoints);
    const server = await main([
      ...upstream,
      "--tools",
      "all",
      "--transport",
      "http",
      "--port",
      "0",
    ]);
    try {
      const { message } = await rpc(`http://127.0.0.1:${server.port}`, 1, "tools/list");
      const names = (message.result!.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain("create_diagram");
      expect(names).not.toContain("call_endpoint");
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/\ntier +ok +all: 61 extension tools listed, 0 endpoints through/),
      );
    } finally {
      await server.close();
    }
  });

  it("--doctor prints the report to stdout and leaves the exit code 0 when healthy", async () => {
    serveManifest(BUNDLED_MANIFEST.endpoints);
    const stdout = new PassThrough();
    let printed = "";
    stdout.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));

    const server = await main([...upstream, "--doctor"], { stdin: new PassThrough(), stdout });
    await server.close();

    expect(server.port).toBeUndefined();
    expect(printed).toMatch(/^node +ok/);
    expect(printed).toContain("extension    ok    0.3.0 at http://127.0.0.1:");
    expect(process.exitCode).toBeUndefined();
  });

  it("--doctor sends --ext-token to the extension and reports a missing one", async () => {
    serveManifest(BUNDLED_MANIFEST.endpoints);
    extension.token = "s3cret";
    const run = async (...extra: string[]) => {
      const stdout = new PassThrough();
      let printed = "";
      stdout.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));
      await main([...upstream, "--doctor", ...extra], { stdin: new PassThrough(), stdout });
      return printed;
    };

    expect(await run("--ext-token", "s3cret")).toContain("(access token sent)");
    expect(new Set(extension.authorizations)).toEqual(new Set(["Bearer s3cret"]));
    expect(process.exitCode).toBeUndefined();

    const refused = await run();
    expect(refused).toMatch(/extension +fail +http:\/\/127\.0\.0\.1:\d+ refused the request/);
    expect(refused).toContain("Generate Access Token...");
    expect(process.exitCode).toBe(1);
  });

  it("--doctor sets exit code 1 when a check fails", async () => {
    const stdout = new PassThrough();
    let printed = "";
    stdout.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));

    await main([...OFFLINE, "--doctor"], { stdin: new PassThrough(), stdout });

    expect(printed).toContain("staruml api  fail");
    expect(process.exitCode).toBe(1);
  });
});

describe("isEntrypoint", () => {
  const moduleUrl = pathToFileURL(INDEX_PATH).href;

  it("is false without a script path", () => {
    expect(isEntrypoint(moduleUrl, undefined)).toBe(false);
  });

  it("is false for a path that does not exist", () => {
    expect(isEntrypoint(moduleUrl, "/does/not/exist.js")).toBe(false);
  });

  it("is false for a different script", () => {
    expect(isEntrypoint(moduleUrl, fileURLToPath(import.meta.url))).toBe(false);
  });

  it("follows the symlink npm creates for bin entries", () => {
    const link = join(mkdtempSync(join(tmpdir(), "staruml-mcp-")), "staruml-mcp");
    symlinkSync(INDEX_PATH, link);
    expect(isEntrypoint(moduleUrl, link)).toBe(true);
  });
});

describe("run", () => {
  it("exits 1 with the message on a fatal error", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await run([...ARGV0, "--transport", "sse"]);

    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      "[staruml-mcp] fatal:",
      'Invalid --transport: "sse". Must be one of: stdio, http',
    );
  });

  it("logs non-Error failures as-is", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const listen = vi.spyOn(process.stdin, "on").mockImplementation(() => {
      throw "stdin unavailable";
    });

    await run(OFFLINE);

    expect(listen).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[staruml-mcp] fatal:", "stdin unavailable");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("closes the server and exits 0 on %s", async (signal) => {
    const exited = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => resolve(code)) as never);
    });
    const signals = new EventEmitter();

    await run([...OFFLINE, "--transport", "http", "--port", "0"], signals);
    signals.emit(signal);

    await expect(exited).resolves.toBe(0);
    expect(console.error).toHaveBeenCalledWith("[staruml-mcp] shutting down…");
  });
});

describe("module entrypoint", () => {
  it("runs the CLI when executed directly", async () => {
    const exited = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => resolve(code)) as never);
    });
    const argv = process.argv;
    process.argv = ["node", INDEX_PATH, "--transport", "bogus"];
    try {
      vi.resetModules();
      await import("../src/index.js");
      await expect(exited).resolves.toBe(1);
    } finally {
      process.argv = argv;
    }
  });
});
