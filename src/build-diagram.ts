/**
 * Client side of extension 0.3.0's `/build_diagram` (src/handlers/build.ts there): a short listed
 * schema built from the manifest entry. The body is still checked against the entry's whole
 * request schema before it is sent.
 */
import { inputSchema, type ManifestEntry } from "./manifest.js";
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
  kind: "One of spec's kinds; required with spec. activity|usecase reads a Mermaid flowchart so.",
  spec: SPEC,
  mermaid: "Mermaid instead of spec; named by name, else its title.",
  name: "Diagram name; \\n or <br/> breaks lines.",
  upsert: "Add only what the same-named diagram lacks.",
  direction: "Layout direction.",
};

const UNTYPED = new Set(["spec", "kind"]);

/**
 * The listed input schema: {@link LISTED} out of the entry's properties, loose so `parentId` and
 * `autoLayout`, which describe_endpoints shows, still pass to the check against the whole
 * request schema. Properties the entry
 * lacks are left out, so an extension that renames one does not break the listing.
 */
export function buildDiagramInput(entry: ManifestEntry): z.ZodObject {
  const properties = (entry.request.properties ?? {}) as Record<string, Record<string, unknown>>;
  const listed: Record<string, Record<string, unknown>> = {};
  for (const [name, description] of Object.entries(LISTED)) {
    const property = properties[name];
    if (property === undefined) continue;
    // spec's record type lists as {type, propertyNames, properties, additionalProperties} and
    // kind's enum repeats the kinds spec's description names: 46 tokens together. The whole
    // request schema still checks both.
    listed[name] = UNTYPED.has(name) ? { description } : { ...property, description };
  }
  return inputSchema({ schema: { type: "object", properties: listed }, passthrough: true });
}
