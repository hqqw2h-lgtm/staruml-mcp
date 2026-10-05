import {
  ErrorCode as McpErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { serialize } from "./compact.js";
import { ErrorCode, StarUMLApiError, ToolInputError, type ErrorDetail } from "./errors.js";

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** Compact JSON of upstream `data`; `input` is the tool's arguments, whose echoes are dropped. */
export function jsonResult(data: unknown, input: Record<string, unknown> = {}): CallToolResult {
  return textResult(serialize(data, input));
}

/** The raster types the Claude Messages API accepts as images besides GIF and WebP; SVG is not one. */
const RASTER = new Set(["image/png", "image/jpeg"]);

/**
 * /export_diagram's answer with the PNG or JPEG as an image block: as text, its base64 would be
 * read as tokens (a 352×130 two-class diagram from StarUML 7.1.1, 7,412 bytes, is 6,540
 * o200k_base tokens of base64), as an image it is billed as vision input. SVG and file exports
 * stay JSON.
 */
export function exportResult(data: unknown, input: Record<string, unknown>): CallToolResult {
  const { base64, mimeType, ...rest } = (data ?? {}) as { base64?: unknown; mimeType?: unknown };
  if (typeof base64 !== "string" || typeof mimeType !== "string" || !RASTER.has(mimeType)) {
    return jsonResult(data, input);
  }
  return {
    content: [
      { type: "image", data: base64, mimeType },
      { type: "text", text: serialize(rest, input) },
    ],
  };
}

function describeError(action: string, error: unknown): { text: string; detail: ErrorDetail } {
  const detail: ErrorDetail =
    error instanceof StarUMLApiError || error instanceof ToolInputError
      ? error.toJSON()
      : {
          code: ErrorCode.Unexpected,
          message: error instanceof Error ? error.message : String(error),
        };
  const status = detail.status === undefined ? "" : `, HTTP ${detail.status}`;
  const endpoint = detail.endpoint === undefined ? "" : `, ${detail.endpoint}`;
  const lines = [`Failed to ${action}: ${detail.message} [${detail.code}${endpoint}${status}]`];
  if (detail.hint !== undefined) {
    lines.push(`Hint: ${detail.hint}`);
  }
  return { text: lines.join("\n"), detail };
}

/**
 * Tool failures are returned as results with `isError` rather than thrown, so the calling model
 * sees the cause and can correct its arguments (MCP spec 2025-06-18, "Tools > Error Handling").
 * The text block carries the same detail for clients that ignore `structuredContent`.
 */
export function toolError(action: string, error: unknown): CallToolResult {
  const { text, detail } = describeError(action, error);
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: { error: detail },
  };
}

/**
 * Resource reads have no `isError` result, so failures travel as a JSON-RPC error; the SDK copies
 * `McpError.data` into the response, which keeps the structured detail tools return.
 */
export function resourceError(action: string, error: unknown): McpError {
  const { text, detail } = describeError(action, error);
  return new McpError(McpErrorCode.InternalError, text, { error: detail });
}

export async function runTool(
  action: string,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    return toolError(action, error);
  }
}
