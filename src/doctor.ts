/**
 * Setup diagnosis, run once at startup and by the `doctor` tool: are both StarUML ports up, which
 * extension and StarUML versions answer, and which extension tools can be offered.
 */
import { EXTENSION_REPOSITORY, StarUMLApiError } from "./errors.js";
import { bundledCatalog, HAND_WRITTEN_TOOLS, type ExtensionCatalog } from "./extension-tools.js";
import {
  BUNDLED_MANIFEST,
  compatibleRange,
  compileManifest,
  isCompatibleVersion,
  parseManifest,
} from "./manifest.js";
import type { StarUMLClient } from "./staruml-client.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  remedy?: string;
}

export interface Diagnosis {
  checks: Check[];
  catalog: ExtensionCatalog;
}

export interface DiagnoseOptions {
  /** `process.versions.node` unless a test substitutes it. */
  nodeVersion?: string;
}

/** package.json `engines.node`. */
const MIN_NODE_MAJOR = 20;
/** StarUML's built-in API server (`/generate_diagram` and friends) first shipped in 7.0.0. */
const MIN_STARUML_MAJOR = 7;
const SUPPORTED_EXTENSION = BUNDLED_MANIFEST.extension.version;

const RESTART = "then restart StarUML";

export async function diagnose(
  client: StarUMLClient,
  options: DiagnoseOptions = {},
): Promise<Diagnosis> {
  const checks: Check[] = [nodeCheck(options.nodeVersion ?? process.versions.node)];
  const [builtinUp, banner] = await Promise.all([client.ping(), client.extensionBanner()]);
  const extensionUp = banner !== undefined;

  checks.push(
    builtinUp
      ? { name: "staruml api", status: "ok", detail: client.builtinUrl }
      : {
          name: "staruml api",
          status: "fail",
          detail: `no answer at ${client.builtinUrl}`,
          // An answering extension proves StarUML runs, so only its API server is switched off.
          remedy: extensionUp
            ? `Enable StarUML's API server ("apiServer": true in settings.json, port "apiServerPort"), ${RESTART}.`
            : `Start StarUML ${MIN_STARUML_MAJOR}.0.0+ with its API server enabled ("apiServer": true in settings.json), or pass --api-host/--api-port.`,
        },
  );

  if (!extensionUp) {
    checks.push({
      name: "extension",
      status: "fail",
      detail: `no answer at ${client.extensionUrl}`,
      remedy: builtinUp
        ? `Install staruml-mcp-extension ${compatibleRange(SUPPORTED_EXTENSION)} (Tools > Extension Manager > Install From Url: ${EXTENSION_REPOSITORY}), ${RESTART}; or pass --ext-port.`
        : "Start StarUML; the extension listens while StarUML runs.",
    });
    return finish(checks, bundledCatalog());
  }

  const { catalog, extensionCheck, staruml } = await readManifest(client, banner);
  checks.push(extensionCheck);
  if (staruml !== undefined) checks.push(starumlCheck(staruml));
  return finish(checks, catalog);
}

async function readManifest(
  client: StarUMLClient,
  banner: unknown,
): Promise<{ catalog: ExtensionCatalog; extensionCheck: Check; staruml?: string }> {
  const at = client.extensionUrl;
  const upgrade = `Install staruml-mcp-extension ${compatibleRange(SUPPORTED_EXTENSION)} from ${EXTENSION_REPOSITORY} (Tools > Extension Manager > Install From Url), ${RESTART}.`;
  let manifest;
  try {
    manifest = parseManifest(await client.introspectManifest());
  } catch (error) {
    const version = bannerVersion(banner);
    const compatible = isCompatibleVersion(version, SUPPORTED_EXTENSION);
    const missing =
      error instanceof StarUMLApiError &&
      (error.code === "UNKNOWN_ENDPOINT" || error.code === "ENDPOINT_NOT_FOUND");
    if (missing || !compatible) {
      return {
        catalog: { ...bundledCatalog(), enabled: false },
        extensionCheck: incompatible(version, at, upgrade),
      };
    }
    return {
      catalog: bundledCatalog(),
      extensionCheck: {
        name: "extension",
        status: "warn",
        detail: `${version} at ${at}; /introspect failed (${messageOf(error)}), using the bundled manifest`,
        remedy: `Restart StarUML; if it persists, report it at ${EXTENSION_REPOSITORY}/issues.`,
      },
    };
  }

  const version = manifest.extension.version;
  if (!isCompatibleVersion(version, SUPPORTED_EXTENSION)) {
    return {
      catalog: { ...bundledCatalog(), enabled: false },
      extensionCheck: incompatible(version, at, upgrade),
      staruml: manifest.staruml.version,
    };
  }
  return {
    catalog: {
      compiled: compileManifest(manifest, HAND_WRITTEN_TOOLS),
      source: "live",
      enabled: true,
    },
    extensionCheck: { name: "extension", status: "ok", detail: `${version} at ${at}` },
    staruml: manifest.staruml.version,
  };
}

function incompatible(version: string, at: string, upgrade: string): Check {
  return {
    name: "extension",
    status: "fail",
    detail: `${version} at ${at} is incompatible; this server needs ${compatibleRange(SUPPORTED_EXTENSION)}, so extension tools are not offered`,
    remedy: upgrade,
  };
}

function nodeCheck(version: string): Check {
  const major = Number(version.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", status: "ok", detail: version }
    : {
        name: "node",
        status: "fail",
        detail: `${version} is older than ${MIN_NODE_MAJOR}`,
        remedy: `Install Node.js ${MIN_NODE_MAJOR}+ (https://nodejs.org).`,
      };
}

function starumlCheck(version: string): Check {
  const major = Number(version.split(".")[0]);
  return major >= MIN_STARUML_MAJOR
    ? { name: "staruml", status: "ok", detail: version }
    : {
        name: "staruml",
        status: "fail",
        detail: `${version} has no API server`,
        remedy: `Upgrade to StarUML ${MIN_STARUML_MAJOR}.0.0+ (https://staruml.io/download).`,
      };
}

function finish(checks: Check[], catalog: ExtensionCatalog): Diagnosis {
  const { tools, skipped } = catalog.compiled;
  const count = catalog.enabled ? tools.length : 0;
  const detail = `${count} endpoints from the ${catalog.source} manifest`;
  checks.push(
    skipped.length === 0
      ? { name: "manifest", status: "ok", detail }
      : {
          name: "manifest",
          status: "warn",
          detail: `${detail}; skipped ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`,
        },
  );
  return { checks, catalog };
}

function bannerVersion(banner: unknown): string {
  const version = (banner as { version?: unknown } | null)?.version;
  return typeof version === "string" ? version : "unknown version";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A fixed-width table; non-ok rows are followed by their remedy. */
export function formatReport(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${check.name.padEnd(width)}  ${check.status.padEnd(4)}  ${check.detail}`);
    if (check.remedy !== undefined) lines.push(`${" ".repeat(width)}  fix   ${check.remedy}`);
  }
  return lines.join("\n");
}

export function healthy(checks: readonly Check[]): boolean {
  return checks.every((c) => c.status !== "fail");
}
