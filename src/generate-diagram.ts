import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OK } from "./compact.js";
import { ErrorCode, EXTENSION_REPOSITORY, StarUMLApiError, ToolInputError } from "./errors.js";
import type { GeneratedTool } from "./manifest.js";
import type { StarUMLClient } from "./staruml-client.js";
import { jsonResult, textResult } from "./tool-result.js";

/**
 * Which server renders a generate_diagram call. StarUML's built-in `/generate_diagram` names every
 * diagram "<Kind> Diagram by Mermaid", keeps `<br/>` as text, has no activity or use case output
 * and refuses front matter, a leading `%%` comment and the `graph` keyword (all checked against
 * 7.1.1). The extension's `/build_diagram` reads the same Mermaid for five diagram types and does
 * all of that, so a call that needs it goes there (upstream staruml-mcp-server issues #2, #3, #4).
 */

/** Diagram types the built-in reads, matched at the start of the trimmed source (7.1.1). */
const BUILTIN_HEADER =
  /^(classDiagram|sequenceDiagram|flowchart|erDiagram|mindmap|requirementDiagram|stateDiagram)/;

/** Headers extension 0.3.0 reads (src/build/mermaid.ts `HEADERS`). */
const EXTENSION_HEADER =
  /^(classDiagram(-v2)?|sequenceDiagram|flowchart|graph|erDiagram|stateDiagram(-v2)?)\b/;

/** `<br>`, `<br/>` and a literal `\n`, which the extension turns into line breaks in names. */
const LINE_BREAK = /<br\s*\/?>|\\n/i;

export interface GenerateRequest {
  code: string;
  name?: string;
  kind?: string;
}

export interface Route {
  /** What only the extension does for this call; empty when the built-in suffices. */
  needs: string[];
  /** The extension parses the source's diagram type. */
  extensionReads: boolean;
  builtinReads: boolean;
}

/**
 * The source as the extension reads it before looking at the header (src/build/mermaid.ts
 * `preprocess` and `takeTitle`): front matter and its title, `%%` comments, blank lines, and the
 * first `title` line, wherever it is.
 */
function outline(code: string): { header: string; title: boolean; frontMatter: boolean } {
  const raw = code.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  let title = false;
  const frontMatter = raw[0]?.trim() === "---";
  if (frontMatter) {
    const end = raw.findIndex((line, i) => i > 0 && line.trim() === "---");
    const block = end < 0 ? raw.slice(1) : raw.slice(1, end);
    title = block.some((line) => /^\s*title\s*:/.test(line));
    start = end < 0 ? raw.length : end + 1;
  }
  const lines = raw
    .slice(start)
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter((line) => line !== "");
  const titleLine = lines.findIndex((line) => /^title\s+/i.test(line));
  if (titleLine >= 0) {
    title = true;
    lines.splice(titleLine, 1);
  }
  return { header: lines[0] ?? "", title, frontMatter };
}

export function route(request: GenerateRequest): Route {
  const { header, title, frontMatter } = outline(request.code);
  const builtinReads = BUILTIN_HEADER.test(request.code.trimStart());
  const needs: string[] = [];
  if (request.name !== undefined) needs.push("name");
  if (request.kind !== undefined) needs.push(`kind ${request.kind}`);
  if (title) needs.push("title");
  if (LINE_BREAK.test(request.code)) needs.push("line breaks");
  if (!builtinReads) {
    needs.push(frontMatter ? "front matter" : `"${request.code.trim().split(/\s/)[0]}" first`);
  }
  return { needs, extensionReads: EXTENSION_HEADER.test(header), builtinReads };
}

/** The Mermaid types build_diagram reads, for messages. */
const EXTENSION_TYPES = "classDiagram, sequenceDiagram, flowchart/graph, erDiagram, stateDiagram";

/**
 * Renders `request` with the extension's build_diagram when it needs it and the extension reads
 * its type, otherwise with the built-in API. `build` is the build_diagram endpoint of the current
 * catalog, undefined when the extension lacks it or is incompatible. Without the extension, a
 * title or `<br/>` only costs the naming and line breaks, so the built-in renders the rest and the
 * answer says what was left out; an explicit `name` or `kind` cannot be honoured and is refused.
 */
export async function generateDiagram(
  client: StarUMLClient,
  build: GeneratedTool | undefined,
  request: GenerateRequest,
): Promise<CallToolResult> {
  const { needs, extensionReads, builtinReads } = route(request);
  const explicit = request.name !== undefined || request.kind !== undefined;
  if (explicit && !extensionReads) {
    throw new ToolInputError(
      `name and kind need a diagram type build_diagram reads: ${EXTENSION_TYPES}`,
      {
        code: ErrorCode.InvalidArgument,
        hint: "build_diagram({kind, spec, name}) builds the other kinds, mind maps included, from a spec.",
      },
    );
  }
  if (needs.length === 0 || !extensionReads) return builtin(client, request.code);
  if (build !== undefined) {
    try {
      const { code, ...rest } = request;
      // The node ids by name, which the extension answers by default before 0.3.0's terse
      // results (result: terse|ids|full, extension #35) and which an extension without the
      // option ignores; an answer without them would leave the model looking them up.
      const body = { mermaid: code, ...rest, result: "ids" };
      return jsonResult(await client.callExtension(build.path, body), body);
    } catch (error) {
      const unreachable =
        error instanceof StarUMLApiError && error.code === ErrorCode.ExtensionUnreachable;
      if (!unreachable || explicit || !builtinReads) throw error;
      return builtin(client, request.code, needs, "staruml-mcp-extension did not answer");
    }
  }
  if (explicit) {
    throw new ToolInputError(`${needs.join(", ")} need staruml-mcp-extension 0.3's build_diagram`, {
      code: ErrorCode.ExtensionRequired,
      hint: `Install it from ${EXTENSION_REPOSITORY} (Tools > Extension Manager > Install From Url), restart StarUML and run doctor.`,
    });
  }
  return builtin(client, request.code, needs, "staruml-mcp-extension is not available");
}

async function builtin(
  client: StarUMLClient,
  code: string,
  skipped: string[] = [],
  why = "",
): Promise<CallToolResult> {
  await client.generateDiagram(code);
  return textResult(
    skipped.length === 0 ? OK : `${OK}; built-in API without ${skipped.join(", ")}: ${why}`,
  );
}
