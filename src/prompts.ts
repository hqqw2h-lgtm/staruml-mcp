/**
 * MCP prompts: workflows a user starts by name (`/model-codebase`, `/review-diagram` in clients
 * that surface prompts as commands). They spell out the tool calls, so they name an endpoint's
 * call_endpoint form when the current tier does not list it.
 */
import type { McpServer, RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  McpError,
  type GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { listedTools, type CatalogState } from "./extension-tools.js";

export const MODEL_CODEBASE = "model-codebase";
export const REVIEW_DIAGRAM = "review-diagram";

/**
 * How the model calls endpoint `name` with `args` (a JSON-like object literal): the tool when it
 * is listed, otherwise call_endpoint. Hand-written tools are always listed and are named directly.
 */
export function invocation(state: CatalogState, name: string, args: string): string {
  const listed = listedTools(state).some((t) => t.name === name);
  return listed ? `${name}(${args})` : `call_endpoint({name: "${name}", body: ${args}})`;
}

function message(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

export interface ModelCodebaseArgs {
  path?: string;
  language?: string;
  description?: string;
  name?: string;
}

/**
 * Reverse engineering when there is a source directory and StarUML has a generator for its
 * language; otherwise one build_diagram from what the model reads or is told. StarUML's Java
 * reverse adds a type hierarchy and package overview diagrams by default (staruml-java
 * preferences `java.rev.typeHierarchy`, `java.rev.packageOverview`, both true).
 */
export function modelCodebase(state: CatalogState, args: ModelCodebaseArgs): GetPromptResult {
  const name = args.name ?? "Overview";
  const language = args.language ?? "<language>";
  const call = (endpoint: string, body: string) => invocation(state, endpoint, body);
  const steps = [
    "1. Run doctor. If the extension check fails, stop and report its fix line.",
    ...(args.path === undefined
      ? []
      : [
          `2. ${call("list_code_generators", "{}")}. If a generator for ${language} is installed, ` +
            `${call("reverse_code", `{language: "${language}", path: "${args.path}"}`)} reads the ` +
            "source into the model and adds overview diagrams; get_all_diagrams_info lists them. " +
            "If none is installed, read the source yourself and continue with step 3.",
        ]),
    `${args.path === undefined ? 2 : 3}. Unless reverse engineering drew what is needed, make one ` +
      `${call("build_diagram", `{kind: "class", name: "${name}", spec: {classes, relations}}`)} with the ` +
      "central classes (about 5 to 15), their key attributes and operations, and their relations " +
      "(generalization, realization, composition, aggregation, association, dependency). Split a " +
      "larger system into one diagram per package, and extend a diagram with upsert: true.",
    `${args.path === undefined ? 3 : 4}. Check the result: ` +
      `${call("describe_diagram", `{diagram: "${name}"}`)} and ` +
      `${call("validate_model", "{scope: <the diagram's _parent>}")}; fix what they show with ` +
      "build_diagram upsert or update_element, then summarise the model in a few sentences.",
  ];
  const subject =
    args.path === undefined ? "the codebase described below" : `the source code in ${args.path}`;
  return message(
    [
      `Model ${subject} as UML in StarUML.`,
      ...(args.description === undefined ? [] : [`About it: ${args.description}`]),
      "",
      ...steps,
    ].join("\n"),
  );
}

/**
 * Read the diagram three cheap ways, then review it without changing anything. `diagram` is an
 * id or a path; `@current` names the diagram open in StarUML wherever a diagram is taken.
 */
export function reviewDiagram(state: CatalogState, diagram: string | undefined): GetPromptResult {
  const which = diagram === undefined ? "the diagram open in StarUML" : `diagram ${diagram}`;
  const ref = diagram ?? "@current";
  return message(
    [
      `Review ${which}.`,
      "",
      `1. ${invocation(state, "describe_diagram", `{diagram: "${ref}"}`)} for its nodes, members and edges.`,
      `2. ${invocation(state, "validate_model", "{scope: <the diagram's _parent>}")} for StarUML's rule violations; get_element_by_id gives the _parent.`,
      `3. diagram_as_text({diagram: "${ref}"}) when the exact notation matters.`,
      "",
      "Report modelling problems (each validation finding with its element, missing types or " +
        "multiplicities, misused relationship kinds, naming), what a reader would find unclear, " +
        "and a concrete fix for each as a build_diagram upsert or update_element call. Change " +
        "nothing until asked.",
    ].join("\n"),
  );
}

const ModelCodebaseArgs = {
  path: z.string().optional().describe("Absolute source directory to reverse-engineer."),
  language: z.string().optional().describe("java, cpp, csharp or python, for reverse_code."),
  description: z.string().optional().describe("What the codebase does, or what to focus on."),
  name: z.string().optional().describe("Name of the class diagram; default Overview."),
};

const ReviewDiagramArgs = {
  diagram: z.string().optional().describe("Diagram id or path; default the current diagram."),
};

/** A registered prompt's callback; every argument of these prompts is an optional string. */
type Render = (args: Record<string, string>, extra: unknown) => GetPromptResult;

export function registerPrompts(server: McpServer, state: CatalogState): void {
  const registered: Record<string, RegisteredPrompt> = {
    [MODEL_CODEBASE]: server.registerPrompt(
      MODEL_CODEBASE,
      {
        title: "Model a codebase",
        description:
          "Reverse-engineer a source directory or build class diagrams from a described codebase.",
        argsSchema: ModelCodebaseArgs,
      },
      (args) => modelCodebase(state, args),
    ),
    [REVIEW_DIAGRAM]: server.registerPrompt(
      REVIEW_DIAGRAM,
      {
        title: "Review a diagram",
        description: "Describe, validate and read a diagram as text, then review it.",
        argsSchema: ReviewDiagramArgs,
      },
      ({ diagram }) => reviewDiagram(state, diagram),
    ),
  };
  // GetPromptRequest's arguments are optional (MCP 2025-06-18, schema.ts), but McpServer 1.29
  // parses an absent one against the argument object and answers -32602. Every argument here is
  // an optional string, which the request schema has checked, so the SDK's handler is replaced
  // by one that reads an absent one as {}.
  server.server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    const prompt = registered[request.params.name];
    if (prompt === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
    }
    return (prompt.callback as Render)(request.params.arguments ?? {}, extra);
  });
}
