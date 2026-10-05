/**
 * The listing of extension 0.3.0's `/export_diagram` (src/handlers/export.ts there). Its manifest
 * descriptions explain File > Export's pixel ratio and the colour pattern, 208 tools/list tokens
 * for a core tool; these say what a caller chooses between in about half. Bodies are still
 * checked against the whole request schema, the colour pattern included.
 */
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";

export const EXPORT_DIAGRAM = "export_diagram";

/**
 * Extension #24's labels, drawn on the image and never on the model. A path label is itself a
 * reference the next call can take, which is why the model is told about paths first.
 */
export const ANNOTATE_DESCRIPTION = "paths|ids: label each view, on the image only.";

export const EXPORT_DIAGRAM_DESCRIPTION =
  "Export a diagram as PNG, JPEG or SVG, inline or to a file.";

const LISTED: Record<string, string> = {
  diagram: "Diagram id or path; default the current one.",
  format: "Default png.",
  scale: "PNG/JPEG pixels per unit, up to 4.",
  background: "CSS colour; default transparent.",
  path: "Absolute file to write it to.",
  annotate: ANNOTATE_DESCRIPTION,
};

export function exportDiagramInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, LISTED, new Set(["background", "scale", "annotate"]));
}
