/**
 * Image size for what reaches the model inline (issue #19). The oo re-validation viewed 25
 * ThingsBoard diagrams: 8.7 MB of base64 PNG, up to 5,800 px wide, which a vision model scales
 * down again anyway (the Claude API resizes images past 1,568 px on the long edge). An inline
 * PNG or JPEG is therefore exported no wider than a cap, and an image wanted at full size goes
 * to a file (`path`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import { ErrorCode, ToolInputError, type StarUMLApiError } from "./errors.js";
import type { StarUMLClient } from "./staruml-client.js";

/**
 * The cap when neither `--image-max-width` nor the style profile names one: the page width of
 * extension 0.3.0's `uml-standard` profile (`layout.page.width`, src/style/profiles.json), also
 * `minimal`'s and `presentation`'s; `print` has 1,123.
 */
export const DEFAULT_IMAGE_MAX_WIDTH = 1600;

/**
 * `configured` (a call's `maxWidth`, else `--image-max-width`), else the width of the page the
 * project's style profile lays diagrams out for, else {@link DEFAULT_IMAGE_MAX_WIDTH}. 0 means
 * no cap.
 */
export async function imageMaxWidth(
  client: StarUMLClient,
  configured: number | undefined,
): Promise<number> {
  if (configured !== undefined) return configured;
  try {
    const data = (await client.callExtension("/get_style_profile", {})) as {
      profile?: { layout?: { page?: { width?: unknown } } };
    } | null;
    const width = data?.profile?.layout?.page?.width;
    return typeof width === "number" && width > 0 ? width : DEFAULT_IMAGE_MAX_WIDTH;
  } catch {
    // A size cap is no reason to fail the picture; the export reports a dead extension itself.
    return DEFAULT_IMAGE_MAX_WIDTH;
  }
}

/** The fields of a /export_diagram answer this server reads. */
export interface ExportedImage {
  diagram?: unknown;
  width?: unknown;
  height?: unknown;
  bytes?: unknown;
  path?: unknown;
  base64?: unknown;
  /** Set when the image was exported again, narrower: the width at scale 1. */
  fullWidth?: number;
  [field: string]: unknown;
}

/**
 * The smallest scale asked for. The extension takes any scale above 0 (`exclusiveMinimum`), but
 * below 1/100 a diagram is a smudge, and a ratio rounded down to 0 would be refused.
 */
const MIN_SCALE = 0.01;

/**
 * `/export_diagram` of `body` (PNG or JPEG, no `scale`), exported again at the scale that makes
 * it `maxWidth` pixels wide when it came out wider. The width at scale 1 is only known from an
 * export: StarUML has no endpoint for a diagram's extent, so a wide diagram is rendered twice and
 * the first image dropped; one narrower than the cap, the usual case, is rendered once.
 */
export async function exportRaster(
  client: StarUMLClient,
  path: string,
  body: Record<string, unknown>,
  maxWidth: number,
): Promise<ExportedImage> {
  const first = (await client.callExtension(path, body)) as ExportedImage;
  const width = first.width;
  if (maxWidth <= 0 || typeof width !== "number" || width <= maxWidth) return first;
  // Rounded down to three places, so rounding never takes the result past the cap.
  const scale = Math.max(MIN_SCALE, Math.floor((maxWidth / width) * 1000) / 1000);
  const second = (await client.callExtension(path, { ...body, scale })) as ExportedImage;
  return { ...second, fullWidth: width };
}

/** Whether a /export_diagram body asks for an inline raster at the default scale. */
export function inlineRaster(body: Record<string, unknown>): boolean {
  return body.path === undefined && body.scale === undefined && body.format !== "svg";
}

export const IMAGE_FORMATS = ["png", "jpeg", "svg", "drawio"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/**
 * The format a file name asks for: `.svg`, `.jpg` or `.jpeg`, `.drawio` (extension #41's
 * uncompressed draw.io file), anything else PNG.
 */
export function formatOf(file: string): ImageFormat {
  const extension = extname(file).toLowerCase();
  if (extension === ".svg") return "svg";
  if (extension === ".drawio") return "drawio";
  return extension === ".jpg" || extension === ".jpeg" ? "jpeg" : "png";
}

/**
 * Refuses a draw.io export that would answer its XML inline: a .drawio file is the diagram's
 * every view with its bounds and style, thousands of tokens of XML a model has no use for and a
 * person opens in draw.io. It is only ever written to a file.
 */
export function checkDrawioFile(format: unknown, path: unknown, slug?: string): void {
  if (format !== "drawio" || path !== undefined) return;
  throw new ToolInputError("format drawio is written to a file, never answered inline", {
    code: ErrorCode.InvalidArgument,
    ...(slug === undefined ? {} : { endpoint: slug }),
    hint:
      slug === "/export_text"
        ? 'export_diagram({format: "drawio", path}) writes it to an absolute .drawio file.'
        : "Pass path, an absolute .drawio file; the answer is its path and size.",
  });
}

/** Refuses a relative file before anything is exported; the extension refuses one too. */
export function checkAbsolute(file: string): void {
  if (!isAbsolute(file)) {
    throw new ToolInputError(`path: must be an absolute path, got "${file}"`, {
      code: ErrorCode.InvalidArgument,
      hint: "Pass an absolute file such as /tmp/diagram.png; the extension writes it.",
    });
  }
}

/**
 * Writes StarUML's built-in PNG to `file`, parents created, as the extension's /export_diagram
 * does with a path; used when no extension answers.
 */
export async function writePng(file: string, base64: string): Promise<ExportedImage> {
  const data = Buffer.from(base64, "base64");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  return { path: file, ...pngSize(data), bytes: data.length };
}

/** A PNG's pixel size from its IHDR chunk (PNG spec, 11.2.2), or nothing for other bytes. */
export function pngSize(data: Buffer): { width?: number; height?: number } {
  const signature = "89504e470d0a1a0a";
  if (data.length < 24 || data.subarray(0, 8).toString("hex") !== signature) return {};
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Whether `error`, which callExtension threw, says the extension did not answer at all. */
export function unreachable(error: unknown): boolean {
  return (error as StarUMLApiError).code === ErrorCode.ExtensionUnreachable;
}
