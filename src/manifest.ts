/**
 * The endpoint manifest staruml-mcp-extension 0.3.0+ publishes from `POST /introspect`, and its
 * translation into MCP tool definitions. A copy taken with `npm run sync:manifest` is bundled so
 * `tools/list` works while StarUML is closed.
 */
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import snapshot from "./extension-manifest.json" with { type: "json" };

type JsonSchema = Record<string, unknown>;

const ManifestEntrySchema = z.object({
  path: z.string().regex(/^\/[a-z0-9_]+$/),
  description: z.string(),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  request: z.record(z.string(), z.unknown()),
  response: z.record(z.string(), z.unknown()),
});

const ManifestSchema = z.object({
  staruml: z.object({ version: z.string(), apiVersion: z.string().nullable() }),
  extension: z.object({ name: z.string(), version: z.string() }),
  endpoints: z.array(ManifestEntrySchema),
});

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

/** Throws when `value` is not the `/introspect` shape of extension 0.3.x; the message is one line. */
export function parseManifest(value: unknown): Manifest {
  const parsed = ManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new Error(`invalid manifest: ${issues.join("; ")}`);
}

export const BUNDLED_MANIFEST: Manifest = parseManifest(snapshot);

/** A tool generated from one manifest entry; built once per manifest, reused by every server. */
export interface GeneratedTool {
  name: string;
  path: string;
  description: string;
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Identifies the manifest entry, so an unchanged tool is not re-registered. */
  fingerprint: string;
}

export interface CompiledManifest {
  manifest: Manifest;
  tools: GeneratedTool[];
  /** Entries left out, with the reason; reported by the doctor tool. */
  skipped: { path: string; reason: string }[];
}

export const MAX_DESCRIPTION_LENGTH = 100;

/**
 * The projection every element-returning endpoint takes (extension src/serialize.ts `Projection`),
 * documented in full on each of them. Read-only tools list it with a reminder; tools that write
 * accept it without listing it, which saves ~1,150 tools/list tokens, since their summary result
 * is usually all a caller needs. The server instructions explain it once.
 */
const PROJECTION: Record<string, string> = {
  summary: "Default true: {_id,_type,name,_parent} only.",
  fields: "Attributes to return.",
  depth: "Owned-element levels to expand.",
};

/** Parameter descriptions the manifest repeats verbatim on many endpoints, shortened once. */
const SHARED_DESCRIPTIONS: Record<string, string> = {
  properties: "Initial attribute values by name; references as an id or {$ref: id}.",
};

export const PROJECTION_INSTRUCTIONS =
  "Element results are summaries {_id,_type,name,_parent}. Every tool returning elements also " +
  "accepts fields (attribute names), summary:false (all saved attributes) and depth (expand owned " +
  "elements), listed or not. find_elements pages with limit/cursor (nextCursor).";

const SENTENCE_END = /(?<!\be\.g|\bi\.e)\.\s+/;

/**
 * `text` on one line, cut to the whole sentences that fit in {@link MAX_DESCRIPTION_LENGTH}
 * characters. Tool descriptions are resent with every model turn, so the manifest's prose is cut to
 * its lead; when even the first sentence is too long it is cut at a clause or word and ends in an
 * ellipsis. "e.g." and "i.e." do not end a sentence.
 */
export function terseDescription(text: string): string {
  const max = MAX_DESCRIPTION_LENGTH;
  const sentences = text.replace(/\s+/g, " ").trim().split(SENTENCE_END);
  let out = "";
  for (const [i, sentence] of sentences.entries()) {
    const next = `${out}${out === "" ? "" : " "}${sentence}${i < sentences.length - 1 ? "." : ""}`;
    if (next.length > max) break;
    out = next;
  }
  if (out !== "") return out;
  const head = sentences[0]!.slice(0, max - 1);
  const clause = Math.max(head.lastIndexOf(":"), head.lastIndexOf(";"), head.lastIndexOf(","));
  const cut = clause > max / 2 ? clause : head.lastIndexOf(" ");
  return `${head.slice(0, cut > 0 ? cut : head.length).trimEnd()}…`;
}

export interface ListedSchema {
  schema: JsonSchema;
  /** Parameters were left out, so unlisted arguments must still reach the extension. */
  passthrough: boolean;
}

/**
 * The request schema as tools/list shows it: `$schema` dropped (the SDK sets its own), the
 * projection shortened or left out (see {@link PROJECTION}) and shared descriptions shortened.
 * Other parameter descriptions stay verbatim: they carry the semantics (update_element's ops,
 * create_relationship's ends); cutting them to 100 characters would save ~600 tools/list tokens
 * (o200k_base, extension 0.3.0) while dropping exactly that.
 */
export function listedRequestSchema(entry: ManifestEntry): ListedSchema {
  const { $schema: _ignored, ...rest } = entry.request;
  const properties = rest.properties as Record<string, JsonSchema> | undefined;
  if (properties === undefined) return { schema: rest, passthrough: false };
  const listed: Record<string, JsonSchema> = {};
  let passthrough = false;
  for (const [name, property] of Object.entries(properties)) {
    const reminder = PROJECTION[name];
    if (reminder !== undefined && !entry.readOnly) {
      passthrough = true;
      continue;
    }
    const short = reminder ?? SHARED_DESCRIPTIONS[name];
    listed[name] = short === undefined ? property : { ...property, description: short };
  }
  return { schema: { ...rest, properties: listed }, passthrough };
}

/**
 * zod's `fromJSONSchema` (zod 4.2+) turns an object without `additionalProperties` into a loose
 * object, which lists `additionalProperties: {}`. The extension strips unknown keys either way, so
 * the root is rebuilt from its shape: strict as the manifest lists it, or loose when parameters
 * were left out of the listing and must still pass.
 */
export function inputSchema({ schema, passthrough }: ListedSchema): z.ZodObject {
  const converted = z.fromJSONSchema(schema);
  if (!(converted instanceof z.ZodObject)) {
    throw new Error("request schema is not an object schema");
  }
  return passthrough ? z.looseObject(converted.shape) : z.object(converted.shape);
}

export function annotationsOf(entry: ManifestEntry): ToolAnnotations {
  // MCP defaults destructiveHint to true, so it is stated for every tool that writes.
  return entry.readOnly
    ? { readOnlyHint: true, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: entry.destructive, openWorldHint: false };
}

export function toolName(path: string): string {
  return path.slice(1);
}

/** `reserved` are names of hand-written tools, which take precedence over a manifest entry. */
export function compileManifest(
  manifest: Manifest,
  reserved: ReadonlySet<string> = new Set(),
): CompiledManifest {
  const tools: GeneratedTool[] = [];
  const skipped: CompiledManifest["skipped"] = [];
  for (const entry of manifest.endpoints) {
    const name = toolName(entry.path);
    if (reserved.has(name)) {
      skipped.push({ path: entry.path, reason: "name taken by a built-in tool" });
      continue;
    }
    try {
      tools.push({
        name,
        path: entry.path,
        description: terseDescription(entry.description),
        inputSchema: inputSchema(listedRequestSchema(entry)),
        annotations: annotationsOf(entry),
        fingerprint: JSON.stringify(entry),
      });
    } catch (error) {
      skipped.push({
        path: entry.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { manifest, tools, skipped };
}
