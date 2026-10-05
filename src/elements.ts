/**
 * Shorter listings of extension 0.3.0's `/find_elements` and `/update_element` (src/handlers/
 * elements.ts there), the two largest generated tools of the core tier. update_element's
 * parameter descriptions carry its semantics and are kept, compressed rather than cut; the
 * integer bounds are left to the check against the whole request schema these tools run before
 * sending, as for build_diagram.
 */
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";

export const FIND_ELEMENTS = "find_elements";
export const UPDATE_ELEMENT = "update_element";
export const GET_ELEMENT_BY_ID = "get_element_by_id";
export const DELETE_ELEMENT = "delete_element";

export const FIND_ELEMENTS_DESCRIPTION =
  "Find elements by metamodel type (subtypes too) and/or exact name, a page at a time.";

export const UPDATE_ELEMENT_DESCRIPTION =
  "Change an element: set a field, add or remove references, reorder a list, or move it.";

/**
 * The manifest's own descriptions of these two run past 100 characters, the first into the path
 * forms the instructions already list, and are cut mid-sentence; these say it whole.
 */
export const GET_ELEMENT_BY_ID_DESCRIPTION = "Read one element by id or path.";

export const DELETE_ELEMENT_DESCRIPTION =
  "Delete an element with everything it owns, its views and the edges attached to them.";

/** `ref` alone, required: get_element_by_id and delete_element. */
export function refInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, { ref: "Id or path." });
}

export function findElementsInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    {
      type: "e.g. UMLClass.",
      name: "Exact name.",
      limit: "Page size; default 100.",
      cursor: "nextCursor of the previous page.",
    },
    new Set(["limit"]),
  );
}

export function updateElementInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    {
      ref: "Id or path.",
      op:
        "set (default) field to value; add/remove value's ids in a reference list; " +
        "reorder item value to index; relocate to parent.",
      field: "Attribute name; not for relocate.",
      value: "set: the value; an id or {$ref: id} for references, null clears. add/remove: ids.",
      index: "reorder: position after the item is taken out.",
      parent: "relocate: the new owner.",
    },
    // The op enum repeats the five ops op's description names (12 tokens); the request schema
    // checks it.
    new Set(["index", "op"]),
  );
}
