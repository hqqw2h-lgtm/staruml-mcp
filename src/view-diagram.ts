import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serialize } from "./compact.js";
import { ErrorCode, StarUMLApiError, ToolInputError } from "./errors.js";
import type { GeneratedTool } from "./manifest.js";
import type { StarUMLClient } from "./staruml-client.js";
import { VIEWER_URI, type ViewerData } from "./viewer.js";

export const VIEW_DIAGRAM = "view_diagram";

export const VIEW_DIAGRAM_DESCRIPTION =
  "Show a diagram: pan/zoom SVG viewer in clients that render MCP Apps, else a PNG.";

/**
 * The SVG for the viewer when the client renders it and the extension can export SVG, otherwise
 * the PNG get_diagram_image_by_id returns. The SVG travels in `structuredContent`, which MCP Apps
 * hands to the view and hosts keep out of the model's context; the model gets a one-line summary.
 */
export async function viewDiagram(
  client: StarUMLClient,
  exportTool: GeneratedTool | undefined,
  id: string | undefined,
  inline: boolean,
): Promise<CallToolResult> {
  return inline && exportTool !== undefined
    ? svgResult(client, exportTool, id)
    : pngResult(client, id);
}

interface SvgExport {
  diagram: string;
  width: number;
  height: number;
  base64?: unknown;
}

async function svgResult(
  client: StarUMLClient,
  exportTool: GeneratedTool,
  id: string | undefined,
): Promise<CallToolResult> {
  const body = id === undefined ? { format: "svg" } : { id, format: "svg" };
  const data = (await client.callExtension(exportTool.path, body)) as SvgExport;
  if (typeof data.base64 !== "string") {
    throw new StarUMLApiError("export_diagram answered without the SVG", {
      code: ErrorCode.InvalidResponse,
      slug: exportTool.path,
      upstream: "extension",
    });
  }
  // The export names the diagram by id only; its summary carries the name.
  const element = (await client.callExtension("/get_element_by_id", { id: data.diagram })) as {
    name?: string | null;
  };
  const shown = {
    diagram: data.diagram,
    name: element.name ?? "",
    width: data.width,
    height: data.height,
  };
  const structured: ViewerData = { ...shown, svg: Buffer.from(data.base64, "base64").toString() };
  return {
    content: [{ type: "text", text: serialize({ ...shown, viewer: VIEWER_URI }) }],
    structuredContent: { ...structured },
  };
}

async function pngResult(client: StarUMLClient, id: string | undefined): Promise<CallToolResult> {
  const diagramId = id ?? (await currentDiagramId(client));
  const image = await client.getDiagramImageById(diagramId);
  return { content: [{ type: "image", data: image, mimeType: "image/png" }] };
}

async function currentDiagramId(client: StarUMLClient): Promise<string> {
  const current = (await client.getCurrentDiagramInfo()) as { id?: string } | null;
  if (current?.id === undefined) {
    throw new ToolInputError("No diagram is open in StarUML.", {
      code: ErrorCode.InvalidArgument,
      hint: "Pass id; get_all_diagrams_info lists the diagrams.",
    });
  }
  return current.id;
}
