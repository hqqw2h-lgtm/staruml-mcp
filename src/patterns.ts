/**
 * Client side of extension #30's design patterns (src/handlers/patterns.ts there): patterns are
 * JSON data with roles, members, relationship ends and the properties each gets, and
 * `/apply_pattern` sets every one of them. `apply_pattern` is listed in the core tier with a
 * short schema; `list_patterns`, `describe_pattern`, `detect_patterns` and `apply_preset` are
 * reached through call_endpoint and the `staruml://patterns` resources.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";
import { countedPlan } from "./model.js";
import { jsonResult } from "./tool-result.js";

export const APPLY_PATTERN = "apply_pattern";
export const LIST_PATTERNS = "list_patterns";
export const DESCRIBE_PATTERN = "describe_pattern";
export const DETECT_PATTERNS = "detect_patterns";
export const APPLY_PRESET = "apply_preset";

/** One line for tools/list; the extension's description is 430 characters. */
export const APPLY_PATTERN_DESCRIPTION =
  "Apply a design pattern, setting every property it prescribes.";

const LISTED: Record<string, string> = {
  pattern: "e.g. Strategy; staruml://patterns lists them.",
  bindings: "Role: element path, new name, or a list of those.",
  diagram: "Class diagram to show it on, or a new one's name.",
  dryRun: "Change nothing; answer what would be set.",
};

/**
 * bindings lists as a record of two nested unions, about 120 tokens the description says in 20;
 * the whole request schema still checks it. `variant`, `parent`, `sequence` and `upsert` pass
 * unlisted, and describe_endpoints shows them.
 */
const UNTYPED = new Set(["bindings", "dryRun"]);

export function applyPatternInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, LISTED, UNTYPED);
}

/** Listed in the `oo` tier, where a model's patterns are checked rather than drawn. */
export const DETECT_PATTERNS_DESCRIPTION =
  "Find design patterns in the model by structure, with a confidence and what is missing.";

export function detectPatternsInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    { scope: "Model or package; default the project.", patterns: "Only these pattern names." },
    // minConfidence (default 0.6) and limit pass unlisted.
    new Set(["patterns"]),
  );
}

type Json = Record<string, unknown>;

interface RoleElement {
  _id?: unknown;
  path?: unknown;
  created?: unknown;
}

/** A role's element as its path, a reference already, the id when it has none. */
function rolePath(element: RoleElement): unknown {
  return typeof element.path === "string" ? element.path : element._id;
}

/** Each role's elements as paths; `created` ones are named in `changes` too. */
function rolePaths(roles: unknown): unknown {
  if (typeof roles !== "object" || roles === null) return roles;
  return Object.fromEntries(
    Object.entries(roles).map(([role, list]) => [
      role,
      Array.isArray(list) ? list.map((e) => rolePath(e as RoleElement)) : list,
    ]),
  );
}

interface Property {
  path: string;
  field: string;
  value: unknown;
}

const isProperty = (p: unknown): p is Property =>
  typeof (p as Property | null)?.path === "string" && typeof (p as Property).field === "string";

/**
 * Every property set, grouped by element path: `{"Order -> Policy.end2": {name: "strategy",
 * navigable: "navigable", multiplicity: "1"}}` instead of one `{path, field, value}` object per
 * value, which repeats the path and the three keys (a Strategy over three classes sets eight).
 */
function propertiesByPath(properties: unknown): unknown {
  if (!Array.isArray(properties) || !properties.every(isProperty)) return properties;
  const grouped = new Map<string, Json>();
  for (const { path, field, value } of properties) {
    grouped.set(path, { ...grouped.get(path), [field]: value });
  }
  return Object.fromEntries(grouped);
}

interface Change {
  path?: unknown;
  type?: unknown;
  fields?: unknown;
}

/** `[{path, type}]` as `{path: type}`, and an update as `{path: fields}`. */
function changesByPath(list: unknown): unknown {
  if (!Array.isArray(list) || !list.every((c) => typeof (c as Change)?.path === "string")) {
    return list;
  }
  return Object.fromEntries(
    (list as Change[]).map((c) => [c.path as string, Array.isArray(c.fields) ? c.fields : c.type]),
  );
}

/**
 * An /apply_pattern or /apply_preset answer for the model: roles and the element as paths,
 * created and updated elements and the properties set keyed by path, and a dry run's `/batch` ops
 * counted (`changes` names each step). For the Strategy applied to three existing classes this is
 * about half the extension's answer (scripts/token-benchmark.mjs).
 */
export function patternResult(data: unknown, input: Json): CallToolResult {
  const answer = countedPlan(data);
  if (typeof answer !== "object" || answer === null) return jsonResult(answer, input);
  const { roles, element, properties, changes, ...rest } = answer as Json;
  const { created, updated } = (changes ?? {}) as { created?: unknown; updated?: unknown };
  return jsonResult(
    {
      ...rest,
      ...(roles === undefined ? {} : { roles: rolePaths(roles) }),
      ...(element === undefined ? {} : { element: rolePath(element as RoleElement) }),
      ...(changes === undefined
        ? {}
        : { changes: { created: changesByPath(created), updated: changesByPath(updated) } }),
      ...(properties === undefined ? {} : { properties: propertiesByPath(properties) }),
    },
    input,
  );
}

/**
 * A /detect_patterns answer with each role's elements as paths; the count and the confidence,
 * the missing parts and the order are the extension's.
 */
export function detectResult(data: unknown, input: Json): CallToolResult {
  const detections = (data as { detections?: unknown } | null)?.detections;
  if (!Array.isArray(detections)) return jsonResult(data, input);
  return jsonResult(
    {
      ...(data as Json),
      detections: detections.map((d: unknown) =>
        typeof d === "object" && d !== null && "roles" in d
          ? { ...d, roles: rolePaths((d as Json).roles) }
          : d,
      ),
    },
    input,
  );
}
