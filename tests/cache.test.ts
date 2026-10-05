import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LruCache, memo } from "../src/cache.js";
import { bundledCatalog, CatalogState } from "../src/extension-tools.js";
import { BUNDLED_MANIFEST, compileManifest, COMPILED_TOOLS } from "../src/manifest.js";
import { METAMODEL_URI } from "../src/server.js";
import { parseToolSelection } from "../src/tiers.js";
import { UpstreamFixture } from "./support/fixture.js";
import { connect, text } from "./support/mcp.js";

describe("LruCache", () => {
  it("counts hits and misses and evicts the least recently used entry", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);

    cache.set("c", 3);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect([cache.hits, cache.misses, cache.size]).toEqual([3, 1, 2]);
  });

  it("replaces an entry without evicting another", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 3);

    expect([cache.get("a"), cache.get("b")]).toEqual([3, 2]);
  });

  it("deletes an entry only while it holds the given value", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.deleteIf("a", 2);
    expect(cache.get("a")).toBe(1);
    cache.deleteIf("a", 1);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("memo", () => {
  it("shares one pending load between callers", async () => {
    const cache = new LruCache<Promise<unknown>>(4);
    let loads = 0;
    const load = async () => ++loads;

    const [a, b] = await Promise.all([memo(cache, "k", load), memo(cache, "k", load)]);

    expect([a, b, loads]).toEqual([1, 1, 1]);
  });

  it("passes a rejection on and loads again next time", async () => {
    const cache = new LruCache<Promise<unknown>>(4);
    await expect(memo(cache, "k", () => Promise.reject(new Error("down")))).rejects.toThrow("down");

    expect(await memo(cache, "k", async () => "up")).toBe("up");
  });

  it("keeps a newer entry when an older load for the key fails", async () => {
    const cache = new LruCache<Promise<unknown>>(4);
    let fail!: (error: Error) => void;
    const older = memo(cache, "k", () => new Promise((_, reject) => (fail = reject)));
    cache.clear();
    const newer = memo(cache, "k", async () => "newer");

    fail(new Error("late"));
    await expect(older).rejects.toThrow("late");

    expect(await memo(cache, "k", async () => "third")).toBe("newer");
    await newer;
  });
});

describe("manifest compilation", () => {
  it("reuses the tools of unchanged entries and compiles changed ones", () => {
    const first = compileManifest(BUNDLED_MANIFEST);
    const hits = COMPILED_TOOLS.hits;

    const again = compileManifest(BUNDLED_MANIFEST);
    const [changed, ...rest] = BUNDLED_MANIFEST.endpoints;
    const edited = compileManifest({
      ...BUNDLED_MANIFEST,
      endpoints: [{ ...changed!, description: "Changed upstream." }, ...rest],
    });

    expect(again.tools).toHaveLength(first.tools.length);
    again.tools.forEach((tool, i) => expect(tool).toBe(first.tools[i]));
    expect(edited.tools[0]).not.toBe(first.tools[0]);
    expect(edited.tools[0]!.description).toBe("Changed upstream.");
    edited.tools.slice(1).forEach((tool, i) => expect(tool).toBe(first.tools[i + 1]));
    expect(COMPILED_TOOLS.hits - hits).toBe(2 * first.tools.length - 1);
  });

  it("serves the bundled catalog from the cache", () => {
    expect(bundledCatalog().compiled.tools[0]).toBe(bundledCatalog().compiled.tools[0]);
  });
});

describe("catalogue reads", () => {
  const HOST = "http://127.0.0.1";
  const builtin = new UpstreamFixture();
  const extension = new UpstreamFixture();
  const VERSIONS = {
    staruml: { version: "7.1.1", apiVersion: "7.1.1" },
    extension: { name: "staruml-mcp-extension", version: "0.3.0" },
  };

  beforeAll(async () => {
    await Promise.all([builtin.start(), extension.start()]);
  });

  afterEach(() => {
    builtin.reset();
    extension.reset();
  });

  afterAll(async () => {
    await Promise.all([builtin.stop(), extension.stop()]);
  });

  const config = (catalog: CatalogState) => ({
    apiHost: HOST,
    apiPort: builtin.port,
    extPort: extension.port,
    catalog,
  });
  const introspects = () => extension.requests.filter((r) => r.path === "/introspect");
  /** The core tier left introspect out in 0.6.0; these tests read through its summary tool. */
  const withIntrospect = () => new CatalogState(undefined, parseToolSelection("core,introspect"));

  /** The extension's manifest, so doctor reads the same catalog it started with. */
  function serveManifest(): void {
    extension.banner = { name: "staruml-mcp-extension", version: "0.3.0", endpoints: [] };
    extension.reply("/introspect", { body: { success: true, data: BUNDLED_MANIFEST } });
  }

  it("answers repeated introspect calls from the cache until doctor reloads", async () => {
    const catalog = withIntrospect();
    const mcp = await connect(config(catalog));
    try {
      extension.reply("/introspect", { body: { success: true, data: VERSIONS } });
      const first = text(await mcp.call("introspect"));
      expect(text(await mcp.call("introspect"))).toBe(first);
      expect(text(await mcp.call("introspect", { include: ["toolbox"] }))).toBe(first);
      expect(introspects().map((r) => r.body)).toEqual([{ include: [] }, { include: ["toolbox"] }]);

      serveManifest();
      await mcp.call("doctor");
      extension.requests.length = 0;
      extension.reply("/introspect", { body: { success: true, data: VERSIONS } });
      await mcp.call("introspect");

      expect(introspects()).toHaveLength(1);
    } finally {
      await mcp.close();
    }
  });

  it("does not keep a failed read", async () => {
    const catalog = withIntrospect();
    const mcp = await connect(config(catalog));
    try {
      extension.reply(
        "/introspect",
        { status: 500, body: { success: false, code: "INTERNAL", error: "boom" } },
        { body: { success: true, data: VERSIONS } },
      );

      expect((await mcp.call("introspect")).isError).toBe(true);
      expect((await mcp.call("introspect")).isError).toBeFalsy();
      expect((await mcp.call("introspect")).isError).toBeFalsy();

      expect(introspects()).toHaveLength(2);
    } finally {
      await mcp.close();
    }
  });

  it("shares the metamodel between the resource and the tool, across servers", async () => {
    const catalog = withIntrospect();
    const [a, b] = await Promise.all([connect(config(catalog)), connect(config(catalog))]);
    try {
      extension.reply("/introspect", { body: { success: true, data: VERSIONS } });

      await a.client.readResource({ uri: METAMODEL_URI });
      await b.client.readResource({ uri: METAMODEL_URI });
      await b.call("introspect", { include: ["metamodel"] });

      expect(introspects()).toHaveLength(1);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("caches describe_endpoints until the selection or manifest changes", async () => {
    const catalog = new CatalogState();
    const mcp = await connect(config(catalog));
    try {
      const index = text(await mcp.call("describe_endpoints"));
      const hits = catalog.reads.hits;
      expect(text(await mcp.call("describe_endpoints"))).toBe(index);
      expect(catalog.reads.hits).toBe(hits + 1);
      expect(index).toContain('"create_diagram"');

      catalog.update(catalog.current, parseToolSelection("core,create_diagram"));

      expect(catalog.reads.size).toBe(0);
      expect(text(await mcp.call("describe_endpoints"))).not.toContain('"create_diagram"');

      const fewer = { ...BUNDLED_MANIFEST, endpoints: BUNDLED_MANIFEST.endpoints.slice(0, 20) };
      catalog.update({ ...bundledCatalog(), compiled: compileManifest(fewer) });
      expect(text(await mcp.call("describe_endpoints"))).not.toBe(index);
    } finally {
      await mcp.close();
    }
  });

  it("does not cache a describe_endpoints refusal", async () => {
    const catalog = new CatalogState();
    const mcp = await connect(config(catalog));
    try {
      const result = await mcp.call("describe_endpoints", { names: ["nope"] });
      expect(result.isError).toBe(true);
      expect(catalog.reads.size).toBe(0);
    } finally {
      await mcp.close();
    }
  });
});
