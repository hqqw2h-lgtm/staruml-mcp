import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, StarUMLApiError, type ErrorDetail } from "./errors.js";

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Tool failures are returned as results with `isError` rather than thrown, so the calling model
 * sees the cause and can correct its arguments (MCP spec 2025-06-18, "Tools > Error Handling").
 * The text block carries the same detail for clients that ignore `structuredContent`.
 */
export function toolError(action: string, error: unknown): CallToolResult {
  const detail: ErrorDetail =
    error instanceof StarUMLApiError
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
  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { error: detail },
  };
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
