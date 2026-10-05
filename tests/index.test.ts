import { EventEmitter } from "node:events";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEntrypoint, main, parseArgs, run } from "../src/index.js";
import packageJson from "../package.json" with { type: "json" };
import { INITIALIZE_PARAMS } from "./support/sse.js";

const ARGV0 = ["node", "staruml-mcp"];
const INDEX_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("applies defaults", () => {
    expect(parseArgs(ARGV0)).toEqual({
      transport: "stdio",
      port: 58323,
      apiPort: 58321,
      extPort: 58322,
      apiHost: "http://localhost",
    });
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
      ]),
    ).toEqual({
      transport: "http",
      port: 0,
      apiPort: 1,
      extPort: 65535,
      apiHost: "http://10.0.0.2",
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
    const server = await main([...ARGV0, "--transport", "http", "--port", "0"]);
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
    const first = await main([...ARGV0, "--transport", "http", "--port", "0"]);
    try {
      await expect(
        main([...ARGV0, "--transport", "http", "--port", String(first.port)]),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });

  it("speaks MCP over the given stdio streams", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = await main(ARGV0, { stdin, stdout });
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

    await run(ARGV0);

    expect(listen).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[staruml-mcp] fatal:", "stdin unavailable");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("closes the server and exits 0 on %s", async (signal) => {
    const exited = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => resolve(code)) as never);
    });
    const signals = new EventEmitter();

    await run([...ARGV0, "--transport", "http", "--port", "0"], signals);
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
