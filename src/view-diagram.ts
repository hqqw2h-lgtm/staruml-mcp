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
 * `diagram` is an id or, with the extension, a path.
 */
export async function viewDiagram(
  client: StarUMLClient,
  exportTool: GeneratedTool | undefined,
  diagram: string | undefined,
  inline: boolean,
): Promise<CallToolResult> {
  return inline && exportTool !== undefined
    ? svgResult(client, exportTool, diagram)
    : pngResult(client, exportTool !== undefined, diagram);
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
  diagram: string | undefined,
): Promise<CallToolResult> {
  const body = diagram === undefined ? { format: "svg" } : { diagram, format: "svg" };
  const data = (await client.callExtension(exportTool.path, body)) as SvgExport;
  if (typeof data.base64 !== "string") {
    throw new StarUMLApiError("export_diagram answered without the SVG", {
      code: ErrorCode.InvalidResponse,
      slug: exportTool.path,
      upstream: "extension",
    });
  }
  // The export names the diagram by id only; its summary carries the name.
  const element = (await client.callExtension("/get_element_by_id", { ref: data.diagram })) as {
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

async function pngResult(
  client: StarUMLClient,
  extension: boolean,
  diagram: string | undefined,
): Promise<CallToolResult> {
  let diagramId: string;
  if (diagram === undefined) diagramId = await currentDiagramId(client);
  else diagramId = extension ? await resolveId(client, diagram) : diagram;
  const image = await client.getDiagramImageById(diagramId);
  return { content: [{ type: "image", data: image, mimeType: "image/png" }] };
}

/**
 * The id of the element `ref` names, read from the extension, which resolves paths: StarUML's
 * built-in /get_diagram_image_by_id takes ids only. Without an answering extension `ref` is
 * passed on as it is, which works when it is an id.
 */
export async function resolveId(client: StarUMLClient, ref: string): Promise<string> {
  try {
    const element = (await client.callExtension("/get_element_by_id", { ref })) as { _id: string };
    return element._id;
  } catch (error) {
    if (error instanceof StarUMLApiError && error.code === ErrorCode.ExtensionUnreachable) {
      return ref;
    }
    throw error;
  }
}

export async function currentDiagramId(client: StarUMLClient): Promise<string> {
  const current = (await client.getCurrentDiagramInfo()) as { id?: string } | null;
  if (current?.id === undefined) {
    throw new ToolInputError("No diagram is open in StarUML.", {
      code: ErrorCode.InvalidArgument,
      hint: "Pass diagram; get_all_diagrams_info lists the diagrams.",
    });
  }
  return current.id;
}
