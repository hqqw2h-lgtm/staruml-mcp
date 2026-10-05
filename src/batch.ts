/**
 * Client side of extension 0.3.0's `/batch` (src/handlers/batch.ts there): the listed input
 * schema, a check of every op before anything is sent, and a compact result.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { serialize } from "./compact.js";
import { ErrorCode, ToolInputError } from "./errors.js";
import { unstamped, type GeneratedTool } from "./manifest.js";
import { textResult } from "./tool-result.js";

export const BATCH = "batch";

/** One line for tools/list; the extension's description is 290 characters. */
export const BATCH_DESCRIPTION =
  'Run endpoint calls in order as one undo step; "$a", "$a.view", "$a.model" are op a\'s result ids.';

/** The extension's patterns for a path and an `as` name. */
const OP_NAME = /^[A-Za-z_][\w-]*$/;
/** "$name" or "$name.path"; "$$" escapes a literal "$" (batch.ts `REFERENCE`). */
const REFERENCE = /^\$([A-Za-z_][\w-]*)((?:\.[A-Za-z_$][\w$]*)*)$/;

/**
 * Shorter than the manifest's request schema, which repeats the refused paths and the limit
 * preference in parameter descriptions. The manifest schema still decides: a batch is checked
 * against it before it is sent.
 */
export const BatchInput = unstamped(
  z.object({
    ops: z
      .array(
        z.object({
          path: z.string().regex(/^\//).describe("Endpoint path, e.g. /create_element."),
          body: z.record(z.string(), z.unknown()).optional().describe("Its request body."),
          as: z.string().regex(OP_NAME).optional().describe("Name later ops refer to as $name."),
        }),
      )
      .min(1)
      .describe("Calls in order; the extension takes 500 by default."),
    atomic: z
      .boolean()
      .optional()
      .describe("Default true: undo every op when one fails. False runs and reports each."),
  }),
);

interface Op {
  path: string;
  body?: Record<string, unknown>;
  as?: string;
}

/**
 * Throws {@link ToolInputError} for the first op whose path the manifest lacks, whose body its
 * schema rejects or that refers to a name no earlier op defines. An atomic batch that failed in
 * the extension is rolled back, so catching these first saves the work of the ops before it.
 * A reference stands for a value only known once the batch runs, so schema issues on a reference
 * string are ignored; the extension checks the resolved value.
 */
export function checkBatch(tools: readonly GeneratedTool[], ops: readonly Op[]): void {
  const named = new Set<string>();
  ops.forEach((op, i) => {
    const tool = tools.find((t) => t.path === op.path);
    if (tool === undefined) {
      throw new ToolInputError(`ops.${i}.path: no endpoint ${op.path}`, {
        code: ErrorCode.InvalidArgument,
        endpoint: `/${BATCH}`,
        hint: "describe_endpoints() lists the endpoints.",
      });
    }
    const body = op.body ?? {};
    const fail = (message: string): never => {
      throw new ToolInputError(`ops.${i}.${message}`, {
        code: ErrorCode.InvalidArgument,
        endpoint: `/${BATCH}`,
        hint: `describe_endpoints({names: ["${tool.name}"]}) shows its schema.`,
      });
    };
    const dangling = references(body).find((r) => !named.has(r.name));
    if (dangling !== undefined) {
      fail(`body.${dangling.at}: ${dangling.text} names no earlier op`);
    }
    const parsed = tool.requestSchema.safeParse(body);
    const issues = parsed.success
      ? []
      : parsed.error.issues.filter((issue) => !isReference(valueAt(body, issue.path)));
    if (issues.length > 0) {
      fail(
        issues.map((issue) => `${["body", ...issue.path].join(".")}: ${issue.message}`).join("; "),
      );
    }
    if (op.as !== undefined) named.add(op.as);
  });
}

function isReference(value: unknown): boolean {
  return typeof value === "string" && REFERENCE.test(value);
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const key of path) current = (current as Record<PropertyKey, unknown> | undefined)?.[key];
  return current;
}

/** Every reference string in `value`, with its location. */
function references(
  value: unknown,
  at: string[] = [],
): { name: string; text: string; at: string }[] {
  if (typeof value === "string") {
    const match = REFERENCE.exec(value);
    return match === null ? [] : [{ name: match[1]!, text: value, at: at.join(".") }];
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => references(item, [...at, key]));
}

interface OpResult {
  path?: string;
  success?: boolean;
  [key: string]: unknown;
}

/**
 * Each result without the op's path, which the caller sent in the same position, and without
 * `success: true`; a failed op keeps `success: false` beside its code.
 */
export function batchResult(data: unknown, input: Record<string, unknown>): CallToolResult {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return textResult(serialize(data, input));
  const compact = results.map((result: OpResult) => {
    const { path: _path, success, ...rest } = result;
    return success === true ? rest : { success, ...rest };
  });
  return textResult(serialize({ ...(data as object), results: compact }, input));
}
