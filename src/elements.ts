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

export const FIND_ELEMENTS_DESCRIPTION =
  "Find elements by metamodel type (subtypes too) and/or exact name, a page at a time.";

export const UPDATE_ELEMENT_DESCRIPTION =
  "Change an element: set a field, add or remove references, reorder a list, or move it.";

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
      id: "Element _id.",
      op:
        "set (default): field = value. add/remove: value is element ids for the reference list " +
        "field. reorder: move list item value to index. relocate: move to owner parentId.",
      field: "Attribute name; not for relocate.",
      value:
        "set: the value; an id or {$ref: id} for references, null clears. add/remove: ids. " +
        "reorder: the item.",
      index: "reorder: position after the item is taken out.",
      parentId: "relocate: the new owner.",
    },
    new Set(["index"]),
  );
}
