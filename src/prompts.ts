/**
 * MCP prompts: workflows a user starts by name (`/model-codebase`, `/review-diagram`,
 * `/improve-diagram`, `/apply-pattern`, `/model-first` in clients that surface prompts as
 * commands). They spell out the tool calls, so they name an endpoint's call_endpoint form when
 * the current tier does not list it, and a prompt whose endpoints the tier cannot reach at all
 * (model-codebase under `oo`, which draws with build_diagram) is not listed.
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
import { reaches } from "./tiers.js";

export const MODEL_CODEBASE = "model-codebase";
export const REVIEW_DIAGRAM = "review-diagram";
export const IMPROVE_DIAGRAM = "improve-diagram";
export const APPLY_PATTERN_PROMPT = "apply-pattern";
export const MODEL_FIRST = "model-first";

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
      `3. diagram_as_text({diagram: "${ref}"}) when the exact notation matters; ` +
        'format: "spec" for the kinds neither Mermaid nor PlantUML has (composite, timing, SysML, BPMN, DFD, ' +
        "wireframe, cloud and the other build_diagram families).",
      "",
      "Report modelling problems (each validation finding with its element, missing types or " +
        "multiplicities, misused relationship kinds, naming), what a reader would find unclear, " +
        "and a concrete fix for each as a build_diagram upsert or update_element call. Change " +
        "nothing until asked.",
    ].join("\n"),
  );
}

/**
 * The quality loop of extension #32: look, score, let /improve_diagram lay the diagram out by
 * the style profile and apply the lint autofixes (each step kept only when it raises the score,
 * all in one undo step), look again. Placing views by hand is what a strict profile refuses and
 * what the loop replaces, so the prompt offers the remedies the loop cannot apply itself: another
 * preset, splitting a diagram past the profile's element limit, and the model's own problems.
 */
export function improveDiagram(state: CatalogState, diagram: string | undefined): GetPromptResult {
  const which = diagram === undefined ? "the diagram open in StarUML" : `diagram ${diagram}`;
  const ref = diagram ?? "@current";
  const call = (endpoint: string, body: string) => invocation(state, endpoint, body);
  return message(
    [
      `Improve ${which} until its layout scores its target and its model is sound.`,
      "",
      `1. view_diagram({diagram: "${ref}"}) to see it.`,
      `2. ${call("diagram_quality", `{ref: "${ref}"}`)}: the score against the target (80 in ` +
        "every built-in profile), the penalties that cost points and the lint findings by rule.",
      `3. ${call("improve_diagram", `{ref: "${ref}"}`)} lays it out by the style profile and ` +
        "applies the lint autofixes in one undo step, keeping each step only when it raises the " +
        "score; its quality says the score reached. Do not move or resize views by hand.",
      `4. view_diagram({diagram: "${ref}"}) to look at the result.`,
      "5. Below target still: a diagram with more elements than the profile's maxElements (30) " +
        "reads better split by package or concern into several diagrams; " +
        `${call("improve_diagram", `{ref: "${ref}", preset: "hierarchy-right"}`)} tries another ` +
        `preset. ${call("uml_lint", "{scope: <the diagram's _parent>}")} finds modelling ` +
        "problems the score does not measure; get_element_by_id gives the _parent. undo reverts " +
        "an improve_diagram in one step.",
      "",
      "Report the score before and after and what still needs a decision from a person.",
    ].join("\n"),
  );
}

export interface ApplyPatternArgs {
  pattern?: string;
  scope?: string;
  diagram?: string;
}

/**
 * A pattern applied the way extension #30 makes it reliable: read what the pattern prescribes,
 * bind its roles to the existing classes by path (an unbound role gets a new element named after
 * the role, rarely the domain's word), check a dry run, apply, look, and detect it back, which
 * scores the result against the same pattern data (confidence 1: everything it prescribes).
 */
export function applyPattern(state: CatalogState, args: ApplyPatternArgs): GetPromptResult {
  const pattern = args.pattern ?? "<pattern>";
  const diagram = args.diagram ?? `${args.pattern ?? "Design"} pattern`;
  const call = (endpoint: string, body: string) => invocation(state, endpoint, body);
  const scope = args.scope === undefined ? "" : ` in ${args.scope}`;
  // New elements go to the diagram's owner or the project's first model unless parent says.
  const parent = args.scope === undefined ? "" : `, parent: "${args.scope}"`;
  const bindings = `{pattern: "${pattern}", bindings${parent}, diagram: "${diagram}"`;
  return message(
    [
      `Apply the ${args.pattern ?? "design"} pattern to the existing model${scope}.`,
      "",
      ...(args.pattern === undefined
        ? [
            `0. Read staruml://patterns, or ${call("list_patterns", "{}")}, and pick the pattern ` +
              "whose intent fits; use its exact name below.",
          ]
        : []),
      `1. ${call("describe_pattern", `{name: "${pattern}"}`)}: its roles (\`*\` binds several ` +
        "elements, `?` is optional), what each gets and the relationship ends it sets.",
      `2. Bind each role to existing classes${scope} by path; staruml://project/tree and ` +
        'find_elements list them. Write bindings as {Role: "Pkg/Class", ManyRole: ["Pkg/A", ' +
        '"Pkg/B"]}; give a role no class plays a name in the domain\'s words, or leave it ' +
        "unbound for a new element named after the role.",
      `3. ${call("apply_pattern", `${bindings}, dryRun: true}`)}: check every role's paths, the ` +
        "elements it would create and each property it would set.",
      `4. ${call("apply_pattern", `${bindings}}`)} applies it in one undo step.`,
      `5. view_diagram({diagram: "${diagram}", annotate: "paths"}) to look at it, and ` +
        `${call("detect_patterns", `{patterns: ["${pattern}"]${args.scope === undefined ? "" : `, scope: "${args.scope}"`}}`)} ` +
        "to confirm it: confidence 1 and nothing missing.",
      "",
      "Report the bindings, what was created and anything detect_patterns still lists as missing.",
    ].join("\n"),
  );
}

export interface ModelFirstArgs {
  system?: string;
  description?: string;
}

/**
 * Object-first authoring (issue #17): the domain stated as objects, the model built from them
 * after a dry run, every diagram derived by rule and laid out by the style profile, then read,
 * reviewed with model_lint and refined through the spec. The agent never draws: the oo tier
 * lists nothing that could, and the prompt says so, but the tier is what keeps it so.
 */
export function modelFirst(state: CatalogState, args: ModelFirstArgs): GetPromptResult {
  const system = args.system ?? "<system>";
  const call = (endpoint: string, body: string) => invocation(state, endpoint, body);
  const scope = `{scope: "${system}"}`;
  return message(
    [
      `Model ${args.system ?? "the system described below"} object-first: state it as objects ` +
        "and let StarUML derive and lay out every diagram. Do not place, size or colour views.",
      ...(args.description === undefined ? [] : [`About it: ${args.description}`]),
      "",
      "1. Explain the domain back in a few sentences: its bounded contexts, the main classes " +
        "with one responsibility each, how they relate (owns, has, uses, isA, implements, " +
        "knows), the actors and their use cases, the collaborations worth a sequence diagram and " +
        "the lifecycles worth a state machine. Write that as a build_model spec with system " +
        `"${system}".`,
      `2. ${call("build_model", "{spec, dryRun: true}")}: check the paths it would create (the ` +
        'first 20 of each kind, the rest counted in omitted; detail: "full" lists all) and ' +
        "that each relationship verb points the right way (from is the whole, the client, the " +
        "specific kind or the side that navigates).",
      `3. ${call("build_model", "{spec}")} builds the model in one undo step. classViews and ` +
        "useCaseViews in the spec group the class and use case diagrams as the user wants them.",
      `4. ${call("derive_diagrams", scope)} draws every diagram the model implies, each laid ` +
        "out by the style profile and run through the quality loop; quality.failing names any " +
        "below its target.",
      '5. view_diagram({diagram: "<a derived diagram\'s name>"}) for the diagrams that matter ' +
        `most, diagram_as_text for their content, ${call("explain_model", scope)} for the whole ` +
        "model as text.",
      `6. ${call("model_lint", scope)} reviews the object design. Fix what it reports in the ` +
        `spec, then ${call("build_model", "{spec, upsert: true}")} and ` +
        `${call("derive_diagrams", scope)} again: both update in place. Repeat until it reports ` +
        "no error or warning, at most three rounds.",
      "",
      "Report the model in a few sentences, the diagrams derived with their scores, and what " +
        "model_lint still reports.",
    ].join("\n"),
  );
}

const ModelFirstPromptArgs = {
  system: z.string().optional().describe("Name of the system, which names the model."),
  description: z.string().optional().describe("What the domain is and does."),
};

const ModelCodebaseArgs = {
  path: z.string().optional().describe("Absolute source directory to reverse-engineer."),
  language: z.string().optional().describe("java, cpp, csharp or python, for reverse_code."),
  description: z.string().optional().describe("What the codebase does, or what to focus on."),
  name: z.string().optional().describe("Name of the class diagram; default Overview."),
};

const ReviewDiagramArgs = {
  diagram: z.string().optional().describe("Diagram id or path; default the current diagram."),
};

const ImproveDiagramArgs = ReviewDiagramArgs;

const ApplyPatternPromptArgs = {
  pattern: z
    .string()
    .optional()
    .describe("Pattern name, e.g. Strategy; default chosen from the list."),
  scope: z.string().optional().describe("Package or model holding the classes, by path."),
  diagram: z
    .string()
    .optional()
    .describe("Class diagram to show it on; default '<pattern> pattern'."),
};

/** A registered prompt's callback; every argument of these prompts is an optional string. */
type Render = (args: Record<string, string>, extra: unknown) => GetPromptResult;

/** Endpoints a prompt cannot do without, listed or through call_endpoint. */
const NEEDS: Record<string, readonly string[]> = {
  [MODEL_CODEBASE]: ["build_diagram"],
  [REVIEW_DIAGRAM]: ["describe_diagram", "validate_model"],
  [IMPROVE_DIAGRAM]: ["diagram_quality", "improve_diagram"],
  [APPLY_PATTERN_PROMPT]: ["describe_pattern", "apply_pattern"],
  [MODEL_FIRST]: ["build_model", "derive_diagrams"],
};

/**
 * Lists each prompt whose endpoints the tier reaches (what a tier lists it reaches, tiers.ts);
 * hides the others.
 */
export function syncPrompts(state: CatalogState, prompts: Record<string, RegisteredPrompt>): void {
  const { selection } = state;
  for (const [name, prompt] of Object.entries(prompts)) {
    const wanted = NEEDS[name]!.every((e) => reaches(selection, e));
    // Each change sends notifications/prompts/list_changed.
    if (prompt.enabled !== wanted) {
      if (wanted) prompt.enable();
      else prompt.disable();
    }
  }
}

export function registerPrompts(
  server: McpServer,
  state: CatalogState,
): Record<string, RegisteredPrompt> {
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
    [IMPROVE_DIAGRAM]: server.registerPrompt(
      IMPROVE_DIAGRAM,
      {
        title: "Improve a diagram",
        description: "Score a diagram, let the quality loop re-lay it out, then look at it.",
        argsSchema: ImproveDiagramArgs,
      },
      ({ diagram }) => improveDiagram(state, diagram),
    ),
    [APPLY_PATTERN_PROMPT]: server.registerPrompt(
      APPLY_PATTERN_PROMPT,
      {
        title: "Apply a design pattern",
        description:
          "Bind a pattern's roles to existing classes by path, dry-run, apply, look and detect it back.",
        argsSchema: ApplyPatternPromptArgs,
      },
      (args) => applyPattern(state, args),
    ),
    [MODEL_FIRST]: server.registerPrompt(
      MODEL_FIRST,
      {
        title: "Model a domain object-first",
        description:
          "State a domain as objects, dry-run and build the model, derive every diagram, review.",
        argsSchema: ModelFirstPromptArgs,
      },
      (args) => modelFirst(state, args),
    ),
  };
  // GetPromptRequest's arguments are optional (MCP 2025-06-18, schema.ts), but McpServer 1.29
  // parses an absent one against the argument object and answers -32602. Every argument here is
  // an optional string, which the request schema has checked, so the SDK's handler is replaced
  // by one that reads an absent one as {}.
  server.server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    const prompt = registered[request.params.name];
    if (prompt === undefined || !prompt.enabled) {
      throw new McpError(ErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
    }
    return (prompt.callback as Render)(request.params.arguments ?? {}, extra);
  });
  return registered;
}
