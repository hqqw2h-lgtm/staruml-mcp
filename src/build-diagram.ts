/**
 * Client side of extension 0.3.0's `/build_diagram` (src/handlers/build.ts there): a short listed
 * schema built from the manifest entry. The body is still checked against the entry's whole
 * request schema before it is sent.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";
import { jsonResult } from "./tool-result.js";

export const BUILD_DIAGRAM = "build_diagram";

/**
 * One line for tools/list; the extension's description is 470 characters. The answer is terse
 * since extension #35 (counts and the diagram), so the line no longer promises ids.
 */
export const BUILD_DIAGRAM_DESCRIPTION =
  "Build a whole diagram in one undo step from a per-kind spec or Mermaid.";

/**
 * The spec shape in brief, for the kinds whose spec has sections of its own. The manifest's
 * description of `spec` is 6,929 characters (1,805 o200k_base tokens) and would be resent
 * with every turn; this names the fields a model needs to write one, and describe_endpoints
 * serves the rest.
 */
const SHAPES =
  "class{classes[{name,attributes,operations}],relations[{from,to,type}]} " +
  "sequence{participants,messages[{from,to,text}]} usecase{actors,useCases,relations} " +
  "activity{nodes[{id,name,type}],flows} statemachine{states,transitions} " +
  "erd{entities[{name,columns}],relationships} flowchart{nodes,flows} mindmap{root{name,children}} " +
  "package{packages[{name,parent}],dependencies} " +
  "component{components[{name,provides,requires,ports}],interfaces,connectors} " +
  "deployment{nodes[{name,deploys}],artifacts,paths}";

/**
 * Every other kind but requirement and c4 is one of extension #25's diagram families
 * (src/build/families.ts there): nodes with a family-specific `type`, nested by `in`, and typed
 * edges. One shape covers the sixteen of 0.3.0 and any family a later build adds to the enum.
 */
const FAMILIES =
  "other kinds{nodes[{name,type,in}],edges[{from,to,type,name}]}, ibd|parametric also block; " +
  "types and requirement|c4: describe_endpoints";

/** Listed parameters with their shorter descriptions. */
const LISTED: Record<string, string> = {
  kind: "Required with spec; activity|usecase read a Mermaid flowchart so.",
  spec: `${SHAPES} ${FAMILIES}`,
  mermaid: "Instead of spec; its title is the default name.",
  name: "Diagram name; \\n or <br/> breaks lines.",
  upsert: "Add only what the same-named diagram lacks.",
  prune: "With upsert, also delete what the spec lacks.",
  dryRun: "Change nothing; answer the plan.",
  direction: "Layout direction.",
  layout: "Preset flow-|hierarchy- + down|up|right|left; default by kind.",
};

/**
 * kind is listed with the manifest's enum, so the kinds a model may name follow the running
 * extension. spec's record type lists as {type, propertyNames, properties,
 * additionalProperties} and layout's enum spells out eight presets the description composes
 * from two lists. The flags' descriptions say they are flags, so `type: "boolean"` adds 5 tokens
 * each. The whole request schema still checks them all.
 */
const UNTYPED = new Set(["spec", "layout", "upsert", "prune", "dryRun"]);

/**
 * The listed input schema: {@link LISTED} out of the entry's properties, loose so `parentId` and
 * `autoLayout`, which describe_endpoints shows, still pass to the check against the whole
 * request schema.
 */
export function buildDiagramInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, LISTED, UNTYPED);
}

/**
 * A dry run's answer without what only a real build makes useful: `ids` and `edges` hold "$name"
 * placeholders for elements that do not exist yet, and `plan.ops`, the exact /batch ops, is the
 * largest part (a ten-class spec's ops run to several thousand tokens) while `plan.creates`,
 * `updates` and `deletes` say the same per step. The ops are counted instead; the build itself
 * runs them. A real build's answer passes as compact JSON.
 */
export function buildResult(data: unknown, input: Record<string, unknown>): CallToolResult {
  const answer = (data ?? {}) as { dryRun?: unknown; plan?: { ops?: unknown } };
  if (answer.dryRun !== true || !Array.isArray(answer.plan?.ops)) return jsonResult(data, input);
  const {
    ids: _ids,
    edges: _edges,
    plan,
    ...rest
  } = answer as Record<string, unknown> & {
    plan: { ops: unknown[] };
  };
  return jsonResult({ ...rest, plan: { ...plan, ops: plan.ops.length } }, input);
}
