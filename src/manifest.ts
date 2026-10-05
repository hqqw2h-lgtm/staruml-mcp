/**
 * The endpoint manifest staruml-mcp-extension 0.3.0+ publishes from `POST /introspect`, and its
 * translation into MCP tool definitions. A copy taken with `npm run sync:manifest` is bundled so
 * `tools/list` works while StarUML is closed.
 */
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { LruCache } from "./cache.js";
import { ErrorCode, ToolInputError } from "./errors.js";
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
  /** What the tool lists and validates: {@link listedRequestSchema}. */
  inputSchema: z.ZodObject;
  /**
   * The whole request schema without the aliases, unknown keys rejected; what call_endpoint
   * validates a body against once {@link canonicalBody} has renamed its aliases.
   */
  requestSchema: z.ZodObject;
  /** Older field names by alias, each mapped to its canonical field ({@link aliasesOf}). */
  aliases: Readonly<Record<string, string>>;
  entry: ManifestEntry;
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
 * documented in full on each of them. No tool lists it; every tool accepts it, and the server
 * instructions explain it once. Listing it on writing tools cost ~1,150 tools/list tokens, and on
 * get_element_by_id and find_elements another 126 (o200k_base, extension 0.3.0, 61 endpoints),
 * which the core tier needed for the diagram reads.
 */
const PROJECTION: ReadonlySet<string> = new Set(["summary", "fields", "depth"]);

/** Parameter descriptions the manifest repeats verbatim on many endpoints, shortened once. */
const SHARED_DESCRIPTIONS: Record<string, string> = {
  properties: "Initial attribute values by name; references as an id or {$ref: id}.",
};

export const PROJECTION_INSTRUCTIONS =
  "Element results are summaries {_id,_type,name,_parent,path}. Every tool returning elements also " +
  "accepts fields (attribute names), summary:false (all saved attributes) and depth (expand owned " +
  "elements).";

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

/** Where the manifest marks an older field name with the canonical field it stands for. */
export const ALIAS_OF = "x-alias-of";

/**
 * The entry's aliases, each mapped to its canonical field. Extension 0.3.0 renamed its id fields
 * (`id` to `ref`, `diagramId` to `diagram`, `tailId` to `tail`, ...; issue #36 there) when they
 * began to take paths, and keeps the old names as aliases marked `x-alias-of` and `deprecated`.
 */
export function aliasesOf(entry: ManifestEntry): Record<string, string> {
  const properties = (entry.request.properties ?? {}) as Record<string, JsonSchema>;
  const aliases: Record<string, string> = {};
  for (const [name, property] of Object.entries(properties)) {
    const canonical = property[ALIAS_OF];
    if (typeof canonical === "string") aliases[name] = canonical;
  }
  return aliases;
}

/**
 * `body` with each alias renamed to its canonical field, as the extension's `renameAliases`
 * (src/endpoint.ts there) does before it validates. Both spellings of one field are refused
 * rather than one silently winning. `used` maps a canonical field back to the alias the caller
 * wrote, so a schema issue can name the field as written.
 */
export function canonicalBody(
  tool: Pick<GeneratedTool, "aliases" | "path" | "name">,
  body: Record<string, unknown>,
): { body: Record<string, unknown>; used: Map<string, string> } {
  const used = new Map<string, string>();
  const out = { ...body };
  for (const [alias, canonical] of Object.entries(tool.aliases)) {
    if (!Object.hasOwn(out, alias)) continue;
    if (Object.hasOwn(out, canonical)) {
      throw new ToolInputError(
        `${alias}: an alias of ${canonical}, which is given too; pass ${canonical} only`,
        {
          code: ErrorCode.InvalidArgument,
          endpoint: tool.path,
          hint: `describe_endpoints({names: ["${tool.name}"]}) shows its schema.`,
        },
      );
    }
    out[canonical] = out[alias];
    delete out[alias];
    used.set(canonical, alias);
  }
  return { body: out, used };
}

/** A schema issue's location with its first segment as the caller wrote it, alias or canonical. */
export function issuePath(
  path: readonly PropertyKey[],
  used: ReadonlyMap<string, string>,
): string[] {
  return path.map((segment, i) => {
    const name = String(segment);
    return i === 0 ? (used.get(name) ?? name) : name;
  });
}

/**
 * The request schema as tools/list shows it: `$schema` dropped (the SDK sets its own), the
 * projection left out (see {@link PROJECTION}), aliases left out (the canonical field is listed
 * and takes an id or a path) and shared descriptions shortened.
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
    if (typeof property[ALIAS_OF] === "string") continue;
    if (PROJECTION.has(name)) {
      passthrough = true;
      continue;
    }
    const short = SHARED_DESCRIPTIONS[name];
    listed[name] = short === undefined ? property : { ...property, description: short };
  }
  return { schema: { ...rest, properties: listed }, passthrough };
}

/**
 * `schema` without keywords that hold for every JSON value they apply to: `propertyNames:
 * {type: "string"}` (object keys are strings) and `additionalProperties: {}` (the default; JSON
 * Schema 2020-12, 10.3.2.3). zod writes both for every record, and they are a third of the tokens
 * of a record parameter in describe_endpoints.
 */
export function withoutTrivialKeywords(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutTrivialKeywords);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    const json = JSON.stringify(value);
    if (key === "propertyNames" && json === '{"type":"string"}') continue;
    if (key === "additionalProperties" && json === "{}") continue;
    out[key] = withoutTrivialKeywords(value);
  }
  return out;
}

/**
 * A shorter listing for an endpoint whose manifest descriptions cost more than they tell: the
 * properties named in `descriptions`, with those descriptions, and `bare` ones with nothing but
 * the description; listed ones the entry requires stay required. The root is loose, so parameters
 * left out still reach the check against the
 * whole request schema that such tools run before sending. Names the entry lacks are skipped, so
 * an extension that renames one does not break the listing.
 */
export function shortInput(
  entry: ManifestEntry,
  descriptions: Readonly<Record<string, string>>,
  bare: ReadonlySet<string> = new Set(),
): z.ZodObject {
  const properties = (entry.request.properties ?? {}) as Record<string, JsonSchema>;
  const listed: Record<string, JsonSchema> = {};
  for (const [name, description] of Object.entries(descriptions)) {
    const property = properties[name];
    if (property === undefined) continue;
    // minLength: 1 on every id (6 tokens each) is left to the whole request schema too.
    const { minLength: _minLength, ...typed } = property;
    listed[name] = bare.has(name) ? { description } : { ...typed, description };
  }
  const required = ((entry.request.required ?? []) as string[]).filter((n) => n in listed);
  const schema = { type: "object", properties: listed, ...(required.length > 0 && { required }) };
  return inputSchema({ schema, passthrough: true });
}

/**
 * zod's `fromJSONSchema` (zod 4.2+) turns an object without `additionalProperties` into a loose
 * object, which lists `additionalProperties: {}`. The extension strips unknown keys either way, so
 * the root is rebuilt from its shape: strict as the manifest lists it, or loose when parameters
 * were left out of the listing and must still pass.
 */
export function inputSchema({ schema, passthrough }: ListedSchema): z.ZodObject {
  const { shape } = objectSchema(schema);
  return unstamped(passthrough ? untrivial(z.looseObject(shape)) : z.object(shape));
}

/**
 * A loose object or a record listed without `additionalProperties: {}` and `propertyNames: {type:
 * "string"}`, which hold for every object (JSON Schema 2020-12, 10.3.2.3; JSON object keys are
 * strings) and which zod 4 writes for each: 5 tools/list tokens on a loose root, 12 on a record.
 * Validation is unchanged; only the listing loses them.
 */
export function untrivial<T extends z.ZodType>(schema: T): T {
  return schema.meta({ additionalProperties: undefined, propertyNames: undefined });
}

/**
 * The manifest's request schema with unknown keys rejected and without the aliases, which
 * {@link canonicalBody} renames first. The extension would drop unknown keys silently, so a
 * misspelt parameter sent through call_endpoint would otherwise do nothing visible.
 */
export function strictRequestSchema(entry: ManifestEntry): z.ZodObject {
  const { $schema: _ignored, ...request } = entry.request;
  const properties = request.properties as Record<string, JsonSchema> | undefined;
  const canonical =
    properties === undefined
      ? request
      : {
          ...request,
          properties: Object.fromEntries(
            Object.entries(properties).filter(([, p]) => typeof p[ALIAS_OF] !== "string"),
          ),
        };
  return z.strictObject(objectSchema(canonical).shape);
}

function objectSchema(schema: JsonSchema): z.ZodObject {
  const converted = z.fromJSONSchema(schema);
  if (!(converted instanceof z.ZodObject)) {
    throw new Error("request schema is not an object schema");
  }
  return converted;
}

/**
 * `schema` checked as written but listed without `keywords`: a string's minLength, an array's
 * minItems or an enum the description or another call already names, about 5 tools/list tokens
 * each. zod copies a schema's metadata over its JSON Schema, and JSON drops the undefined values.
 */
export function unlisted<T extends z.ZodType>(schema: T, ...keywords: string[]): T {
  return schema.meta(Object.fromEntries(keywords.map((k) => [k, undefined])));
}

/** A string that may not be empty, listed as a plain string. */
export function nonEmpty(): z.ZodString {
  return unlisted(z.string().min(1), "minLength");
}

/**
 * Keeps the MCP SDK from stamping `$schema` on the listed input schema. McpServer (1.29) lists
 * a zod 4 object through `toJSONSchema(schema, {target: "draft-7"})`, which writes the draft-07
 * URL first and then copies the root schema's metadata over it; an undefined `$schema` there is
 * dropped by JSON serialization. The URL costs 13 tokens per tool, and the MCP spec (2025-06-18,
 * Tool.inputSchema) does not ask for it.
 */
export function unstamped<T extends z.ZodObject>(schema: T): T {
  return schema.meta({ $schema: undefined });
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

/**
 * Tools by their entry's JSON, the fingerprint. Converting the 61 request schemas of extension
 * 0.3.0 to zod twice (listed and strict) is what `doctor`, every bundled-catalog fallback and the
 * startup check repeat; an unchanged entry now costs a map lookup and keeps its tool object, and
 * an entry the extension changed misses by construction. 512 holds several manifest versions.
 * Entries that fail to convert are not kept: they are rare and their error is cheap to repeat.
 */
export const COMPILED_TOOLS = new LruCache<GeneratedTool>(512);

/** The entry's tool, or why zod could not convert its request schema. */
function compileEntry(entry: ManifestEntry): GeneratedTool | string {
  try {
    const fingerprint = JSON.stringify(entry);
    let tool = COMPILED_TOOLS.get(fingerprint);
    if (tool === undefined) {
      tool = {
        name: toolName(entry.path),
        path: entry.path,
        description: terseDescription(entry.description),
        inputSchema: inputSchema(listedRequestSchema(entry)),
        requestSchema: strictRequestSchema(entry),
        aliases: aliasesOf(entry),
        entry,
        annotations: annotationsOf(entry),
        fingerprint,
      };
      COMPILED_TOOLS.set(fingerprint, tool);
    }
    return tool;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** `reserved` are names of hand-written tools, which take precedence over a manifest entry. */
export function compileManifest(
  manifest: Manifest,
  reserved: ReadonlySet<string> = new Set(),
): CompiledManifest {
  const tools: GeneratedTool[] = [];
  const skipped: CompiledManifest["skipped"] = [];
  for (const entry of manifest.endpoints) {
    if (reserved.has(toolName(entry.path))) {
      skipped.push({ path: entry.path, reason: "name taken by a built-in tool" });
      continue;
    }
    const compiled = compileEntry(entry);
    if (typeof compiled === "string") skipped.push({ path: entry.path, reason: compiled });
    else tools.push(compiled);
  }
  return { manifest, tools, skipped };
}

/**
 * Semver compatibility with the extension version this server was built against: same major, and
 * for 0.x the same minor too, since semver lets a 0.x minor release break the API (semver 2.0.0
 * item 4). Pre-release and build suffixes are ignored.
 */
export function isCompatibleVersion(actual: string, expected: string): boolean {
  const a = parseVersion(actual);
  const e = parseVersion(expected);
  if (a === undefined || e === undefined) return false;
  return a[0] === e[0] && (e[0] !== 0 || a[1] === e[1]);
}

/** `0.3.x`, `1.x`: the range {@link isCompatibleVersion} accepts, for messages. */
export function compatibleRange(expected: string): string {
  const parsed = parseVersion(expected);
  if (parsed === undefined) return expected;
  const [major, minor] = parsed;
  return major === 0 ? `0.${minor}.x` : `${major}.x`;
}

function parseVersion(version: string): [number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.\d+/.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}
