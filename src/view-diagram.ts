import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serialize } from "./compact.js";
import { ErrorCode, StarUMLApiError, ToolInputError } from "./errors.js";
import type { GeneratedTool } from "./manifest.js";
import type { StarUMLClient } from "./staruml-client.js";
import {
  checkAbsolute,
  exportRaster,
  formatOf,
  imageMaxWidth,
  unreachable,
  writePng,
  type ExportedImage,
} from "./images.js";
import { VIEWER_URI, type ViewerData } from "./viewer.js";

export const VIEW_DIAGRAM = "view_diagram";

export const VIEW_DIAGRAM_DESCRIPTION = "Show a diagram: SVG viewer under MCP Apps, else PNG.";

export interface ViewOptions {
  annotate?: Annotate;
  /** An absolute file to write the image to; the answer is its path and size. */
  path?: string;
  /**
   * The inline PNG's width cap in pixels, 0 for none: the call's `maxWidth`, else
   * `--image-max-width`; undefined reads the style profile's page width (images.ts).
   */
  maxWidth?: number;
}

/**
 * The SVG for the viewer when the client renders it and the extension can export SVG, otherwise
 * a PNG. The SVG travels in `structuredContent`, which MCP Apps hands to the view and hosts keep
 * out of the model's context; the model gets a one-line summary. The PNG comes from the
 * extension's /export_diagram, no wider than the cap (issue #19), and from StarUML's built-in
 * /get_diagram_image_by_id, at its own size, when no extension answers. With `path` the image is
 * written to that file instead and the answer is its path and size. `diagram` is an id or, with
 * the extension, a path.
 */
export async function viewDiagram(
  client: StarUMLClient,
  exportTool: GeneratedTool | undefined,
  diagram: string | undefined,
  inline: boolean,
  options: ViewOptions = {},
): Promise<CallToolResult> {
  const annotate = options.annotate ?? "none";
  if (options.path !== undefined) checkAbsolute(options.path);
  if (exportTool === undefined) {
    if (annotate !== "none") {
      throw new ToolInputError("annotate needs staruml-mcp-extension's export_diagram", {
        code: ErrorCode.ExtensionRequired,
        hint: "Run doctor; without the extension view_diagram shows the built-in PNG only.",
      });
    }
    return options.path === undefined
      ? pngResult(client, diagram)
      : builtinFile(client, diagram, options.path);
  }
  if (options.path !== undefined) {
    return fileResult(client, exportTool, diagram, annotate, options.path, options.maxWidth);
  }
  if (inline) return svgResult(client, exportTool, diagram, annotate);
  try {
    return await rasterResult(client, exportTool, diagram, annotate, options.maxWidth);
  } catch (error) {
    // The manifest lists /export_diagram but nothing answers: StarUML's own PNG still does.
    if (annotate === "none" && unreachable(error)) return pngResult(client, diagram);
    throw error;
  }
}

/** Extension #24's label modes; `none` draws nothing. */
export const ANNOTATE = ["none", "ids", "paths"] as const;
export type Annotate = (typeof ANNOTATE)[number];

function exportBody(format: string, annotate: Annotate): Record<string, unknown> {
  return { format, ...(annotate === "none" ? {} : { annotate }) };
}

/**
 * /export_diagram of `diagram`. A derived sequence diagram is named like its collaboration and
 * interaction (extension #33), so an AMBIGUOUS_REF with one diagram among its candidates is
 * exported again by that diagram's id.
 */
async function exportOf(
  client: StarUMLClient,
  exportTool: GeneratedTool,
  diagram: string | undefined,
  body: Record<string, unknown>,
  maxWidth?: number,
): Promise<ExportedImage> {
  const run = (ref: string | undefined) => {
    const sent = { ...(ref === undefined ? {} : { diagram: ref }), ...body };
    return maxWidth === undefined
      ? (client.callExtension(exportTool.path, sent) as Promise<ExportedImage>)
      : exportRaster(client, exportTool.path, sent, maxWidth);
  };
  try {
    return await run(diagram);
  } catch (error) {
    const refused = error as StarUMLApiError;
    const sole = refused.code === "AMBIGUOUS_REF" ? soleDiagram(refused.details) : undefined;
    if (sole === undefined) throw error;
    return run(sole);
  }
}

/**
 * The PNG /export_diagram draws, labelled when asked: each label names its element as a
 * reference the next call takes, so the picture is the whole answer; the label boxes stay out
 * of the text. One narrowed to the cap says how wide it was.
 */
async function rasterResult(
  client: StarUMLClient,
  exportTool: GeneratedTool,
  diagram: string | undefined,
  annotate: Annotate,
  maxWidth: number | undefined,
): Promise<CallToolResult> {
  const cap = await imageMaxWidth(client, maxWidth);
  const data = await exportOf(client, exportTool, diagram, exportBody("png", annotate), cap);
  const image = { type: "image" as const, data: exported(data, exportTool), mimeType: "image/png" };
  if (data.fullWidth === undefined) return { content: [image] };
  const size = { width: data.width, height: data.height, fullWidth: data.fullWidth };
  return { content: [image, { type: "text", text: serialize(size) }] };
}

/** The image written by the extension to `file`, in the format its name asks for. */
async function fileResult(
  client: StarUMLClient,
  exportTool: GeneratedTool,
  diagram: string | undefined,
  annotate: Annotate,
  file: string,
  maxWidth: number | undefined,
): Promise<CallToolResult> {
  const format = formatOf(file);
  const body = { ...exportBody(format, annotate), path: file };
  // A file is written at full size unless the call caps it; SVG has no pixel width to cap.
  const cap = format === "svg" ? undefined : maxWidth;
  const data = await exportOf(client, exportTool, diagram, body, cap);
  return written(data, { diagram, path: file });
}

/** StarUML's built-in PNG written to `file`, when no extension answers. */
async function builtinFile(
  client: StarUMLClient,
  diagram: string | undefined,
  file: string,
): Promise<CallToolResult> {
  if (formatOf(file) !== "png") {
    throw new ToolInputError(`${file}: only PNG is written without the extension`, {
      code: ErrorCode.ExtensionRequired,
      hint: "Name a .png file, or run doctor to set up staruml-mcp-extension for SVG and JPEG.",
    });
  }
  const diagramId = diagram ?? (await currentDiagramId(client));
  const image = await client.getDiagramImageById(diagramId);
  return written({ diagram: diagramId, ...(await writePng(file, image)) }, { diagram, path: file });
}

/**
 * What a written image is: its pixel size and bytes, and no image; the diagram's id and the file
 * only where they differ from what the call named (a temp-dir path is about 40 tokens).
 */
function written(data: ExportedImage, input: Record<string, unknown>): CallToolResult {
  const { diagram, path, width, height, bytes, fullWidth } = data;
  const shown = { diagram, path, width, height, bytes, fullWidth };
  return { content: [{ type: "text", text: serialize(shown, input) }] };
}

/** The export's base64, or the error a missing one is. */
function exported(data: ExportedImage, exportTool: GeneratedTool): string {
  if (typeof data.base64 !== "string") {
    throw new StarUMLApiError("export_diagram answered without the image", {
      code: ErrorCode.InvalidResponse,
      slug: exportTool.path,
      upstream: "extension",
    });
  }
  return data.base64;
}

async function svgResult(
  client: StarUMLClient,
  exportTool: GeneratedTool,
  diagram: string | undefined,
  annotate: Annotate,
): Promise<CallToolResult> {
  const data = await exportOf(client, exportTool, diagram, exportBody("svg", annotate));
  const svg = exported(data, exportTool);
  // The export names the diagram by id only; its summary carries the name.
  const element = (await client.callExtension("/get_element_by_id", { ref: data.diagram })) as {
    name?: string | null;
  };
  const shown = {
    diagram: data.diagram as string,
    name: element.name ?? "",
    width: data.width as number,
    height: data.height as number,
  };
  const structured: ViewerData = { ...shown, svg: Buffer.from(svg, "base64").toString() };
  return {
    content: [{ type: "text", text: serialize({ ...shown, viewer: VIEWER_URI }) }],
    structuredContent: { ...structured },
  };
}

/** StarUML's built-in PNG, at its own size: without the extension nothing can scale it. */
async function pngResult(
  client: StarUMLClient,
  diagram: string | undefined,
): Promise<CallToolResult> {
  const diagramId = diagram ?? (await currentDiagramId(client));
  const image = await client.getDiagramImageById(diagramId);
  return { content: [{ type: "image", data: image, mimeType: "image/png" }] };
}

/**
 * The one diagram among an AMBIGUOUS_REF's candidates: the reference is a diagram's, so a
 * collaboration and an interaction of the same name, which every sequence diagram derived from a
 * model has (extension #33), do not make it ambiguous here.
 */
function soleDiagram(details: unknown): string | undefined {
  const candidates = (details as { candidates?: unknown } | undefined)?.candidates;
  if (!Array.isArray(candidates)) return undefined;
  const diagrams = (candidates as { _id?: unknown; _type?: unknown }[]).filter(
    (c) => typeof c._type === "string" && c._type.endsWith("Diagram") && typeof c._id === "string",
  );
  return diagrams.length === 1 ? (diagrams[0]!._id as string) : undefined;
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
