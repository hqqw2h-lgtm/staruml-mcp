/**
 * Client side of extension 0.3.0's `/build_diagram` (src/handlers/build.ts there): a short listed
 * schema built from the manifest entry. The body is still checked against the entry's whole
 * request schema before it is sent.
 */
import { shortInput, type ManifestEntry } from "./manifest.js";
import type { z } from "zod";

export const BUILD_DIAGRAM = "build_diagram";

/** One line for tools/list; the extension's description is 470 characters. */
export const BUILD_DIAGRAM_DESCRIPTION =
  "Build a whole diagram in one undo step from a per-kind spec or Mermaid; answers ids by node name.";

/**
 * The spec shape in brief. The manifest's description of `spec` is ~1,400 characters (about 400
 * o200k_base tokens) and would be resent with every turn; this names the fields a model needs to
 * write one, and describe_endpoints serves the rest.
 */
const SPEC =
  "class{classes[{name,attributes,operations}],relations[{from,to,type}]} " +
  "sequence{participants,messages[{from,to,text}]} usecase{actors,useCases,relations} " +
  "activity{nodes[{id,name,type}],flows} statemachine{states,transitions} " +
  "erd{entities[{name,columns}],relationships} flowchart{nodes,flows} mindmap{root{name,children}}; " +
  "details: describe_endpoints";

/** Listed parameters with their shorter descriptions. */
const LISTED: Record<string, string> = {
  kind: "Required with spec. activity|usecase reads a Mermaid flowchart so.",
  spec: SPEC,
  mermaid: "Instead of spec; its title names the diagram unless name is given.",
  name: "Diagram name; \\n or <br/> breaks lines.",
  upsert: "Add only what the same-named diagram lacks.",
  direction: "Layout direction.",
  layout: "Preset flow-|hierarchy- + down|up|right|left; default by kind.",
};

/**
 * spec's record type lists as {type, propertyNames, properties, additionalProperties}, kind's
 * enum repeats the kinds spec's description names and layout's enum spells out eight presets the
 * description composes from two lists: 75 tokens together. The whole request schema still checks
 * all three.
 */
const UNTYPED = new Set(["spec", "kind", "layout"]);

/**
 * The listed input schema: {@link LISTED} out of the entry's properties, loose so `parentId` and
 * `autoLayout`, which describe_endpoints shows, still pass to the check against the whole
 * request schema.
 */
export function buildDiagramInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, LISTED, UNTYPED);
}
