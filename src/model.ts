/**
 * Client side of extension #23's `/build_model` (src/handlers/model.ts there): a model made or
 * updated from an object-level spec, without diagrams. Listed in the core tier with a short
 * schema; the body is still checked against the entry's whole request schema before it is sent.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";
import { jsonResult } from "./tool-result.js";

export const BUILD_MODEL = "build_model";
export const SYNC_OPERATIONS = "sync_operations";
export const APPLY_THEME = "apply_theme";

/** One line for tools/list; the extension's description is 520 characters. */
export const BUILD_MODEL_DESCRIPTION = "Make or update a model, no diagrams, from an object spec.";

/**
 * The spec in brief: the manifest's description of `spec` is about 1,100 characters, most of it
 * the direction of each relationship verb, which the skill's "Model first" section and
 * describe_endpoints carry.
 */
const SPEC =
  "contexts,classes[{name,context,kind,responsibility,attributes,operations}]," +
  "relationships[{from,to,type:owns|has|uses|isA|implements|knows,fromMult,toMult}]," +
  "actors,useCases,collaborations,lifecycles";

const LISTED: Record<string, string> = {
  spec: SPEC,
  upsert: "Update the same-named model; removes nothing.",
  dryRun: "Change nothing; answer the changes.",
};

/** The flags say they are flags, and spec's record type lists as four keywords. */
const UNTYPED = new Set(["spec", "upsert", "dryRun"]);

export function buildModelInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, LISTED, UNTYPED);
}

type Json = Record<string, unknown>;

/**
 * A dry run's answer with its `/batch` ops counted ({@link countedPlan}): `changes` names every
 * element the run would make or change by path, and the ops spell the same out at several times
 * the size. A placeholder id ("$m0") for a model that does not exist yet is dropped; its path
 * names it. A real build's answer, counts by type, passes as compact JSON.
 */
export function modelResult(data: unknown, input: Json): CallToolResult {
  return jsonResult(countedPlan(data), input);
}

/**
 * `data` with a dry run's `plan.ops` replaced by their number and placeholder ids dropped. Where
 * the answer has `changes`, which name every element made or changed by path, the plan's step
 * lists (`creates`, `updates`, `deletes`) say the same again by "$name" and are dropped too: for
 * Strategy over three classes that is 460 tokens down to 265.
 */
export function countedPlan(data: unknown): unknown {
  const answer = data as { dryRun?: unknown; plan?: { ops?: unknown } } | null;
  if (answer?.dryRun !== true || !Array.isArray(answer.plan?.ops)) return data;
  const { plan, ...rest } = answer as Json & { plan: Json & { ops: unknown[] } };
  const ops = plan.ops.length;
  return withoutPlaceholders({ ...rest, plan: "changes" in rest ? { ops } : { ...plan, ops } });
}

/** `{_id: "$m0", ...}` objects without the `_id`, recursively; ids of existing elements stay. */
function withoutPlaceholders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPlaceholders);
  if (typeof value !== "object" || value === null) return value;
  // fromEntries keeps a "__proto__" key as data (compact.ts prune).
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => !(key === "_id" && typeof item === "string" && item.startsWith("$")))
      .map(([key, item]) => [key, withoutPlaceholders(item)]),
  );
}
