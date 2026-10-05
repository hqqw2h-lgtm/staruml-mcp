import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bundledCatalog,
  loadCatalog,
  syncExtensionTools,
  type ExtensionCatalog,
  type RegisteredExtensionTools,
} from "../src/extension-tools.js";
import { BUNDLED_MANIFEST, compileManifest, type ManifestEntry } from "../src/manifest.js";
import { StarUMLClient } from "../src/staruml-client.js";
import { closedPort, UpstreamFixture } from "./support/fixture.js";

const HOST = "http://127.0.0.1";
const extension = new UpstreamFixture();

beforeAll(async () => {
  await extension.start();
});

afterEach(() => {
  extension.reset();
});

afterAll(async () => {
  await extension.stop();
});

const live = (endpoints: ManifestEntry[]): ExtensionCatalog => ({
  compiled: compileManifest({ ...BUNDLED_MANIFEST, endpoints }),
  source: "live",
  enabled: true,
});

describe("loadCatalog", () => {
  it("compiles the running extension's manifest", async () => {
    const [first] = BUNDLED_MANIFEST.endpoints;
    extension.reply("/introspect", {
      body: { success: true, data: { ...BUNDLED_MANIFEST, endpoints: [first] } },
    });

    const catalog = await loadCatalog(new StarUMLClient({ host: HOST, extPort: extension.port }));

    expect(catalog.source).toBe("live");
    expect(catalog.compiled.tools.map((t) => t.path)).toEqual([first!.path]);
    expect(extension.requests[0]!.body).toEqual({ include: ["endpoints"] });
  });

  it("falls back to the bundled manifest when the extension is unreachable", async () => {
    const refused = await closedPort();

    const catalog = await loadCatalog(
      new StarUMLClient({ host: HOST, port: refused, extPort: refused }),
    );

    expect(catalog).toMatchObject({ source: "bundled", enabled: true });
    expect(catalog.compiled.tools).toHaveLength(BUNDLED_MANIFEST.endpoints.length);
  });

  it("falls back to the bundled manifest when the answer is not a manifest", async () => {
    extension.reply("/introspect", { body: { success: true, data: { endpoints: 1 } } });

    const catalog = await loadCatalog(new StarUMLClient({ host: HOST, extPort: extension.port }));

    expect(catalog.source).toBe("bundled");
  });
});

describe("syncExtensionTools", () => {
  let server: McpServer;
  let client: Client;
  let registered: RegisteredExtensionTools;
  let changes: number;
  const upstream = new StarUMLClient({ host: HOST, extPort: 1 });

  async function names(): Promise<string[]> {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  }

  beforeAll(async () => {
    server = new McpServer({ name: "t", version: "0" });
    registered = new Map();
    syncExtensionTools(server, upstream, bundledCatalog(), registered);
    client = new Client({ name: "t", version: "0" });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changes++;
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("starts with one tool per bundled endpoint", async () => {
    expect(await names()).toHaveLength(BUNDLED_MANIFEST.endpoints.length);
  });

  it("adds, removes and replaces tools to match a new catalog, and notifies the client", async () => {
    changes = 0;
    const [first, ...rest] = BUNDLED_MANIFEST.endpoints;
    const next = [
      { ...first!, description: "Changed upstream." },
      ...rest.filter((e) => e.path !== "/debug"),
      { ...first!, path: "/batch" },
    ];

    syncExtensionTools(server, upstream, live(next), registered);

    expect(await names()).toContain("batch");
    expect(await names()).not.toContain("debug");
    const changed = (await client.listTools()).tools.find((t) => t.name === first!.path.slice(1));
    expect(changed!.description).toBe("Changed upstream.");
    await vi.waitFor(() => expect(changes).toBeGreaterThan(0));
  });

  it("leaves unchanged tools alone", async () => {
    const before = new Map(registered);
    const same = [...registered.values()].map((r) => r.fingerprint);

    syncExtensionTools(
      server,
      upstream,
      live(same.map((f) => JSON.parse(f) as ManifestEntry)),
      registered,
    );

    for (const [name, entry] of registered) expect(entry.tool).toBe(before.get(name)!.tool);
  });

  it("lists no extension tools for a disabled catalog", async () => {
    syncExtensionTools(server, upstream, { ...bundledCatalog(), enabled: false }, registered);

    expect(await names()).toEqual([]);
    expect(registered.size).toBe(0);
  });
});
