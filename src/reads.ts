/**
 * Listings and result shapes of extension 0.3.0's read endpoints `/search_types`,
 * `/describe_diagram` (src/handlers/search.ts and describe.ts there) and `/validate_model`. Their
 * manifest descriptions explain the ranking, the text format and which rules.js files are read;
 * the listings say what a caller chooses, and bodies are still checked against the whole
 * request schema before they are sent.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";
import { jsonResult, textResult } from "./tool-result.js";

export const SEARCH_TYPES = "search_types";
export const DESCRIBE_DIAGRAM = "describe_diagram";
export const VALIDATE_MODEL = "validate_model";

export const SEARCH_TYPES_DESCRIPTION =
  "Find a type, palette item, relationship or command id; each hit has an example call.";

export const DESCRIBE_DIAGRAM_DESCRIPTION =
  "A diagram in brief: nodes with members, edges as tail -[Type]-> head.";

export const VALIDATE_MODEL_DESCRIPTION = "Check the model against StarUML's validation rules.";

export function searchTypesInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    {
      query: "Words or part of an id.",
      limit: "Default 10.",
      categories: "Any of diagram, palette, relationship, model, enum, command.",
    },
    // The enum repeats the description and the bounds say little; the request schema checks both.
    new Set(["limit", "categories"]),
  );
}

/** Integer bounds the request schema checks; listed, they cost 10 tokens a parameter. */
const BOUNDS = new Set(["maxChars", "limit"]);

export function describeDiagramInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, { diagramId: "Diagram _id.", maxChars: "Default 4000." }, BOUNDS);
}

export function validateModelInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    { scope: "Element _id: only it and what it owns.", limit: "Default 200." },
    BOUNDS,
  );
}

interface SearchAnswer {
  results?: Record<string, unknown>[];
}

/**
 * The hits without their `score`: the extension sorts by it, and the number tells a model
 * nothing the order does not (about 4 tokens a hit). The echoed query is dropped as usual.
 */
export function searchResult(data: unknown, input: Record<string, unknown>): CallToolResult {
  const { results } = (data ?? {}) as SearchAnswer;
  if (!Array.isArray(results)) return jsonResult(data, input);
  return jsonResult(
    { ...(data as object), results: results.map(({ score: _score, ...hit }) => hit) },
    input,
  );
}

/**
 * The summary text alone. Its first line names the diagram's type, name and owner and counts
 * the nodes and edges, and a cut text ends in "... N more lines", so the rest of the answer
 * repeats it; as a JSON string every quote in it would also be escaped. For a two-class diagram
 * from StarUML 7.1.1 that is 68 o200k_base tokens against 120 for the whole answer.
 */
export function describeResult(data: unknown, input: Record<string, unknown>): CallToolResult {
  const summary = (data ?? {}) as { text?: unknown };
  return typeof summary.text === "string" ? textResult(summary.text) : jsonResult(data, input);
}
