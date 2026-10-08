/**
 * Client side of extension #42's viewpoints and #43's diagram templates (src/handlers/viewpoints.ts
 * and templates.ts there). `/request_diagram` takes what a reader wants to know and lets a
 * committed decision table (src/viewpoints/decisions.json) pick the viewpoint, the diagram kind
 * and the template; `/list_templates` names the templates `/build_diagram` and
 * `/derive_diagrams` draw with. Both are listed in the `oo` tier with short schemas; the
 * catalogue reads and `/viewpoint_lint` are reached through call_endpoint. Bodies are still checked
 * against the entry's whole request schema before they are sent.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";
import { jsonResult } from "./tool-result.js";

export const REQUEST_DIAGRAM = "request_diagram";
export const LIST_TEMPLATES = "list_templates";
export const DESCRIBE_TEMPLATE = "describe_template";
export const LIST_VIEWPOINTS = "list_viewpoints";
export const DESCRIBE_VIEWPOINT = "describe_viewpoint";
export const VIEWPOINT_LINT = "viewpoint_lint";

/** The extension's description is 1,050 characters: the decision table and every refusal. */
export const REQUEST_DIAGRAM_DESCRIPTION =
  "Draw the view that answers a question; the engine picks viewpoint, kind and template.";

/**
 * audience's seven names go in its description: as an enum with its type they cost 12 tokens
 * more. intent's 500-character cap is left to the whole request schema, which still refuses
 * anything else.
 */
export function requestDiagramInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    {
      intent: "The question it answers, in plain words.",
      audience: "business|analyst|architect|developer|tester|operator|dba.",
      scope: "Model, package, class, collaboration, state machine, actor or use case.",
      dryRun: "Change nothing; answer the choice.",
    },
    new Set(["intent", "audience", "dryRun"]),
  );
}

/** The extension's description explains StarUML's File > New From Template as well. */
export const LIST_TEMPLATES_DESCRIPTION =
  "Diagram templates by viewpoint and kind, to draw with; and the project templates.";

export function listTemplatesInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, {});
}

export const DESCRIBE_TEMPLATE_DESCRIPTION =
  "One diagram template: its viewpoint's question, kind, content limits, style and parts.";

export function describeTemplateInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, { name: "Template name from list_templates." });
}

export const LIST_VIEWPOINTS_DESCRIPTION =
  "The viewpoints: the question each answers, its diagram kinds and its readers.";

export function listViewpointsInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, {});
}

export const DESCRIBE_VIEWPOINT_DESCRIPTION =
  "One viewpoint in full: what it allows, its limits, parts and the rules leading to it.";

/** name keeps its enum: the nine names are what there is to pick from. */
export function describeViewpointInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, { name: "The viewpoint." });
}

export const VIEWPOINT_LINT_DESCRIPTION =
  "Check diagrams keep to their declared viewpoint (V001-V009), each finding with a fix.";

/** rules (a record of severities) and limit pass unlisted, as lint_diagram's do. */
export function viewpointLintInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, { scope: "Diagram, model or package; default the project." });
}

type Json = Record<string, unknown>;

interface DiagramTemplate {
  name?: unknown;
  version?: unknown;
  default?: unknown;
  [field: string]: unknown;
}

/**
 * A /list_templates answer for the model: each diagram template without `version` (1 for all
 * fourteen of extension 0.3.0; describe_template and a build's answer carry it) and `default`
 * only where false, and the project templates by name, since their install paths (about 30
 * tokens each) are what /new_from_template resolves itself.
 */
export function templatesResult(data: unknown, input: Json): CallToolResult {
  const answer = (data ?? {}) as { templates?: unknown; diagramTemplates?: unknown };
  if (!Array.isArray(answer.templates) && !Array.isArray(answer.diagramTemplates)) {
    return jsonResult(data, input);
  }
  const { templates, diagramTemplates, ...rest } = answer as Json;
  return jsonResult(
    {
      ...rest,
      ...(Array.isArray(diagramTemplates)
        ? {
            diagramTemplates: diagramTemplates.map((t: DiagramTemplate) => {
              if (typeof t !== "object" || t === null) return t;
              const { version: _version, default: isDefault, ...shown } = t;
              return isDefault === false ? { ...shown, default: false } : shown;
            }),
          }
        : {}),
      ...(Array.isArray(templates)
        ? {
            templates: templates.map((t: { name?: unknown } | null) =>
              typeof t === "object" && t !== null && typeof t.name === "string" ? t.name : t,
            ),
          }
        : {}),
    },
    input,
  );
}
