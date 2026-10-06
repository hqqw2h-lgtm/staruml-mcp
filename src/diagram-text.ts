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
  "A diagram as Mermaid (default), PlantUML or spec text; build_diagram reads each back.";

/** The formats served as resources too. */
export const TEXT_FORMATS = ["mermaid", "plantuml"] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

/**
 * The tool's formats. `spec` is extension #25's text form of the sixteen diagram families that
 * neither Mermaid nor PlantUML has (composite, timing, bpmn, aws, ...): the diagram's
 * /build_diagram spec as JSON, which builds it again with the same kind.
 */
export const DIAGRAM_TEXT_FORMATS = [...TEXT_FORMATS, "spec"] as const;
export type DiagramTextFormat = (typeof DIAGRAM_TEXT_FORMATS)[number];

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
 * `/export_text` of `diagram` (an id or a path), or of the current one. `tool` is the endpoint of
 * the current catalog, undefined when the extension lacks it or is incompatible.
 */
export async function exportText(
  client: StarUMLClient,
  tool: GeneratedTool | undefined,
  diagram: string | undefined,
  format: DiagramTextFormat,
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
  const ref = diagram ?? (await currentDiagramId(client));
  return (await client.callExtension(tool.path, { diagram: ref, format })) as TextExport;
}

/**
 * The text in a block of its own, so its newlines and quotes are not JSON-escaped (an eleven-line
 * class diagram from StarUML 7.1.1 is 45 o200k_base tokens as text, 56 as a JSON string), then the
 * diagram's id unless the caller passed that id, its kind and the warnings. The text names the
 * diagram (Mermaid front matter, PlantUML `title`). A spec comes indented by two spaces and is
 * sent on one line, as every JSON answer of this server is: a three-node data flow diagram's
 * spec is 130 o200k_base tokens indented and 64 on one line.
 */
export async function diagramAsText(
  client: StarUMLClient,
  tool: GeneratedTool | undefined,
  diagram: string | undefined,
  format: DiagramTextFormat,
): Promise<CallToolResult> {
  const out = await exportText(client, tool, diagram, format);
  const text = format === "spec" ? oneLine(out.text) : out.text;
  const about = serialize(
    { id: out.diagram._id, kind: out.kind, warnings: out.warnings },
    diagram === undefined ? {} : { id: diagram },
  );
  return {
    content: [
      { type: "text", text },
      { type: "text", text: about },
    ],
  };
}

/** JSON text on one line; anything that does not parse is left as it came. */
function oneLine(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}
