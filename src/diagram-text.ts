/**
 * Diagrams read back as text through extension 0.3.0's `/export_text` (src/handlers/export-text.ts
 * there): the diagram_as_text tool and the `staruml://diagram/{id}.mmd` and `.puml` resources.
 * A class diagram of six classes is several hundred tokens as Mermaid against thousands as an
 * element dump or a PNG billed as vision input (scripts/token-benchmark.mjs, "read and explain").
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serialize } from "./compact.js";
import { ErrorCode, EXTENSION_REPOSITORY, ToolInputError } from "./errors.js";
import type { GeneratedTool } from "./manifest.js";
import type { StarUMLClient } from "./staruml-client.js";
import { currentDiagramId } from "./view-diagram.js";

export const DIAGRAM_AS_TEXT = "diagram_as_text";

export const DIAGRAM_AS_TEXT_DESCRIPTION =
  "A diagram as Mermaid (default) or PlantUML text; build_diagram reads the Mermaid back.";

export const TEXT_FORMATS = ["mermaid", "plantuml"] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

/** File extensions of the text resources, by format. */
export const TEXT_EXTENSIONS: Record<TextFormat, string> = { mermaid: "mmd", plantuml: "puml" };

interface TextExport {
  diagram: { _id: string };
  /** The build_diagram kind; use case and activity diagrams come out as Mermaid flowcharts. */
  kind: string;
  text: string;
  warnings?: string[];
}

/**
 * `/export_text` of diagram `id`, or of the current one. `tool` is the endpoint of the current
 * catalog, undefined when the extension lacks it or is incompatible.
 */
export async function exportText(
  client: StarUMLClient,
  tool: GeneratedTool | undefined,
  id: string | undefined,
  format: TextFormat,
): Promise<TextExport> {
  if (tool === undefined) {
    throw new ToolInputError(
      "Diagrams are written as text by staruml-mcp-extension 0.3's export_text",
      {
        code: ErrorCode.ExtensionRequired,
        hint: `Install it from ${EXTENSION_REPOSITORY} (Tools > Extension Manager > Install From Url), restart StarUML and run doctor.`,
      },
    );
  }
  const diagramId = id ?? (await currentDiagramId(client));
  return (await client.callExtension(tool.path, { diagramId, format })) as TextExport;
}

/**
 * The text in a block of its own, so its newlines and quotes are not JSON-escaped (an eleven-line
 * class diagram from StarUML 7.1.1 is 45 o200k_base tokens as text, 56 as a JSON string), then the
 * diagram's id unless the caller passed it, its kind and the warnings. The text names the diagram
 * (Mermaid front matter, PlantUML `title`).
 */
export async function diagramAsText(
  client: StarUMLClient,
  tool: GeneratedTool | undefined,
  id: string | undefined,
  format: TextFormat,
): Promise<CallToolResult> {
  const out = await exportText(client, tool, id, format);
  const about = serialize(
    { id: out.diagram._id, kind: out.kind, warnings: out.warnings },
    id === undefined ? {} : { id },
  );
  return {
    content: [
      { type: "text", text: out.text },
      { type: "text", text: about },
    ],
  };
}
