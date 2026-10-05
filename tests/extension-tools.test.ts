import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bundledCatalog,
  CatalogState,
  syncExtensionTools,
  type ExtensionCatalog,
  type RegisteredExtensionTools,
} from "../src/extension-tools.js";
import { BUNDLED_MANIFEST, compileManifest, type ManifestEntry } from "../src/manifest.js";
import { StarUMLClient } from "../src/staruml-client.js";
import { parseToolSelection } from "../src/tiers.js";
import { UpstreamFixture } from "./support/fixture.js";

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

const ALL = parseToolSelection("all");
const state = (catalog: ExtensionCatalog, selection = ALL) => new CatalogState(catalog, selection);

describe("syncExtensionTools", () => {
  let server: McpServer;
  let client: Client;
  let registered: RegisteredExtensionTools;
  let changes: number;
  /** The endpoints of the last catalog synced. */
  let latest: ManifestEntry[] = [];
  const upstream = new StarUMLClient({ host: HOST, extPort: 1 });

  async function names(): Promise<string[]> {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  }

  beforeAll(async () => {
    server = new McpServer({ name: "t", version: "0" });
    registered = new Map();
    syncExtensionTools(server, upstream, state(bundledCatalog()), registered);
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
      { ...first!, path: "/build_diagram" },
    ];
    latest = next;

    syncExtensionTools(server, upstream, state(live(next)), registered);

    expect(await names()).toContain("build_diagram");
    expect(await names()).not.toContain("debug");
    const changed = (await client.listTools()).tools.find((t) => t.name === first!.path.slice(1));
    expect(changed!.description).toBe("Changed upstream.");
    await vi.waitFor(() => expect(changes).toBeGreaterThan(0));
  });

  it("leaves unchanged tools alone", async () => {
    const before = new Map(registered);

    syncExtensionTools(server, upstream, state(live([...latest])), registered);

    for (const [name, entry] of registered) expect(entry.tool).toBe(before.get(name)!.tool);
  });

  it("swaps tools for describe_endpoints and call_endpoint when the selection narrows", async () => {
    changes = 0;

    syncExtensionTools(
      server,
      upstream,
      state(bundledCatalog(), parseToolSelection("find_elements")),
      registered,
    );

    expect(await names()).toEqual(["call_endpoint", "describe_endpoints", "find_elements"]);
    await vi.waitFor(() => expect(changes).toBeGreaterThan(0));
  });

  it("lists no extension tools for a disabled catalog", async () => {
    syncExtensionTools(
      server,
      upstream,
      state({ ...bundledCatalog(), enabled: false }),
      registered,
    );

    expect(await names()).toEqual([]);
    expect(registered.size).toBe(0);
  });
});
