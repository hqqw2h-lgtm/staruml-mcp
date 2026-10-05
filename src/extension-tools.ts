import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BUNDLED_MANIFEST,
  compileManifest,
  parseManifest,
  type CompiledManifest,
} from "./manifest.js";
import type { StarUMLClient } from "./staruml-client.js";
import { jsonResult, runTool } from "./tool-result.js";

/**
 * Tools written by hand: the four endpoints of StarUML's built-in API, which has no manifest, and
 * composites that call several endpoints. A manifest entry with one of these names is ignored.
 */
export const HAND_WRITTEN_TOOLS: ReadonlySet<string> = new Set([
  "generate_diagram",
  "get_all_diagrams_info",
  "get_current_diagram_info",
  "get_diagram_image_by_id",
]);

/** The extension tools a server offers, and where their definitions came from. */
export interface ExtensionCatalog {
  compiled: CompiledManifest;
  source: "live" | "bundled";
  /** False lists no extension tools. */
  enabled: boolean;
}

export function bundledCatalog(): ExtensionCatalog {
  return {
    compiled: compileManifest(BUNDLED_MANIFEST, HAND_WRITTEN_TOOLS),
    source: "bundled",
    enabled: true,
  };
}

/**
 * The running extension's manifest, or the bundled one when the extension cannot be reached or
 * answers with something that is not a manifest.
 */
export async function loadCatalog(client: StarUMLClient): Promise<ExtensionCatalog> {
  try {
    const manifest = parseManifest(await client.introspectManifest());
    return {
      compiled: compileManifest(manifest, HAND_WRITTEN_TOOLS),
      source: "live",
      enabled: true,
    };
  } catch {
    return bundledCatalog();
  }
}

/** Shared by every McpServer of a process; the HTTP transport builds one per request. */
export class CatalogState {
  constructor(public current: ExtensionCatalog = bundledCatalog()) {}
}

export type RegisteredExtensionTools = Map<string, { tool: RegisteredTool; fingerprint: string }>;

/**
 * Makes `registered` match the catalog: tools for new or changed endpoints are (re)registered and
 * tools for vanished ones removed. The SDK sends `notifications/tools/list_changed` for each
 * change once a client is connected, so unchanged tools are left alone.
 */
export function syncExtensionTools(
  server: McpServer,
  client: StarUMLClient,
  catalog: ExtensionCatalog,
  registered: RegisteredExtensionTools,
): void {
  const wanted = catalog.enabled ? catalog.compiled.tools : [];
  const names = new Set(wanted.map((t) => t.name));
  for (const [name, entry] of registered) {
    if (!names.has(name)) {
      entry.tool.remove();
      registered.delete(name);
    }
  }
  for (const tool of wanted) {
    const existing = registered.get(tool.name);
    if (existing?.fingerprint === tool.fingerprint) continue;
    existing?.tool.remove();
    const action = tool.name.replaceAll("_", " ");
    const registeredTool = server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) =>
        runTool(action, async () =>
          jsonResult(await client.callExtension(tool.path, input), input),
        ),
    );
    registered.set(tool.name, { tool: registeredTool, fingerprint: tool.fingerprint });
  }
}
