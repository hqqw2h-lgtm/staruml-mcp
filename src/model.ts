/**
 * Client side of extension #23's `/build_model` (src/handlers/model.ts there): a model made or
 * updated from an object-level spec, without diagrams, and of extension #33's `/derive_diagrams`
 * and `/explain_model` (src/handlers/oo.ts): the diagrams the model implies, drawn by rule, and the
 * model as text. Listed with short schemas (build_model in the core and `oo` tiers, the other two
 * in `oo`); bodies are still checked against the entry's whole request schema before they are
 * sent.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { shortInput, type ManifestEntry } from "./manifest.js";
import { jsonResult, textResult } from "./tool-result.js";

export const BUILD_MODEL = "build_model";
export const DERIVE_DIAGRAMS = "derive_diagrams";
export const EXPLAIN_MODEL = "explain_model";
export const SYNC_OPERATIONS = "sync_operations";
export const APPLY_THEME = "apply_theme";

/** One line for tools/list; the extension's description is 840 characters. */
export const BUILD_MODEL_DESCRIPTION = "Make or update a model, no diagrams, from an object spec.";

/**
 * The spec in brief: the manifest's description of `spec` is about 1,100 characters, most of it
 * the direction of each relationship verb, which the skill's "Model first" section and
 * describe_endpoints carry.
 */
const SPEC =
  "contexts,classes[{name,context,kind,responsibility,attributes,operations}]," +
  "relationships[{from,to,type:owns|has|uses|isA|implements|knows,fromMult,toMult}]," +
  "actors,useCases,collaborations,lifecycles";

const LISTED: Record<string, string> = {
  spec: SPEC,
  upsert: "Update the same-named model; removes nothing.",
  dryRun: "Change nothing; answer the changes (detail full: past 20).",
};

/**
 * The flags say they are flags, and spec's record type lists as four keywords. `detail`, which
 * the dryRun line names, passes unlisted: its enum and the extension's 260-character description
 * would cost the core tier about 60 tokens for a call a model makes once per model, if at all.
 */
const UNTYPED = new Set(["spec", "upsert", "dryRun"]);

export function buildModelInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(entry, LISTED, UNTYPED);
}

type Json = Record<string, unknown>;

/**
 * A dry run's answer with its `/batch` ops counted ({@link countedPlan}): `changes` names every
 * element the run would make or change by path, and the ops spell the same out at several times
 * the size. A placeholder id ("$m0") for a model that does not exist yet is dropped; its path
 * names it. A real build's answer, counts by type, passes as compact JSON.
 */
export function modelResult(data: unknown, input: Json): CallToolResult {
  return jsonResult(countedPlan(data), input);
}

/**
 * `data` with a dry run's `plan.ops` replaced by their number and placeholder ids dropped. Where
 * the answer has `changes`, which name every element made or changed by path, the plan's step
 * lists (`creates`, `updates`, `deletes`) say the same again by "$name" and are dropped too: for
 * Strategy over three classes that is 460 tokens down to 265.
 *
 * Since extension #39 a dry run answers a summary unless `detail: "full"`: the first 20 of each
 * list, with what it left out counted in `omitted`. The op count adds the omitted ops, so it is
 * what applying runs either way; `omitted` keeps the counts of what the answer still lists (the
 * steps only where they stay) and is dropped when nothing is left out.
 */
export function countedPlan(data: unknown): unknown {
  const answer = data as { dryRun?: unknown; plan?: { ops?: unknown } } | null;
  if (answer?.dryRun !== true || !Array.isArray(answer.plan?.ops)) return data;
  const { plan, omitted, ...rest } = answer as Json & { plan: Json & { ops: unknown[] } };
  const left = (omitted ?? {}) as Record<string, unknown>;
  const ops = plan.ops.length + (typeof left.ops === "number" ? left.ops : 0);
  const steps = !("changes" in rest);
  const still = Object.entries(left).filter(
    ([key, count]) => key !== "ops" && (steps || key !== "steps") && count !== 0,
  );
  return withoutPlaceholders({
    ...rest,
    plan: steps ? { ...plan, ops } : { ops },
    ...(still.length > 0 ? { omitted: Object.fromEntries(still) } : {}),
  });
}

/** `{_id: "$m0", ...}` objects without the `_id`, recursively; ids of existing elements stay. */
function withoutPlaceholders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPlaceholders);
  if (typeof value !== "object" || value === null) return value;
  // fromEntries keeps a "__proto__" key as data (compact.ts prune).
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => !(key === "_id" && typeof item === "string" && item.startsWith("$")))
      .map(([key, item]) => [key, withoutPlaceholders(item)]),
  );
}

/** The extension's description is 820 characters, the rules for each kind. */
export const DERIVE_DIAGRAMS_DESCRIPTION =
  "Draw every diagram a model implies, laid out by the style profile, in one undo step.";

export const EXPLAIN_MODEL_DESCRIPTION =
  "The model as compact text by section: classes, relationships, operations, flows, views.";

export function deriveDiagramsInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    {
      scope: "The model, or a package of it.",
      kinds:
        "Only these: package|class|sequence|usecase|statemachine|activity|erd|c4|deployment|mindmap.",
      dryRun: "Change nothing; answer what each diagram would change.",
    },
    // The kinds enum is in the description; policy, a profile patch, passes unlisted.
    new Set(["kinds", "dryRun"]),
  );
}

/**
 * sections lists with its six-name enum, which says what there is to pick; cursor and maxChars
 * are numbers their descriptions name.
 */
export function explainModelInput(entry: ManifestEntry): z.ZodObject {
  return shortInput(
    entry,
    {
      scope: "Model or package; default the project.",
      sections: "Only these; default all.",
      maxChars: "Default 20000.",
      cursor: "A cut answer's next.",
    },
    new Set(["maxChars", "cursor"]),
  );
}

/** Counts a derived diagram answers; a zero says nothing a missing count does not. */
const COUNTS = ["created", "updated", "unchanged", "deleted", "ops"] as const;

interface Derived {
  kind?: unknown;
  name?: unknown;
  quality?: { score?: unknown };
  viewpoint?: unknown;
  template?: unknown;
  conforms?: unknown;
  accepted?: unknown;
  [field: string]: unknown;
}

/**
 * A /derive_diagrams or /request_diagram answer for the model: each diagram as its kind, its
 * name, its id and its non-zero counts, with the score its quality loop reached, and since
 * extension #42/#43 the viewpoint it is a view of and the template it was drawn with; the rating
 * and `passes` are left out (the totals' `quality.failing` names every diagram below its target).
 * The id stays: a derived sequence diagram is named like the collaboration and the interaction it
 * shows, so its name alone is an AMBIGUOUS_REF (extension 0.3.0, phase 1h). A dry run's
 * "$diagram" placeholder is dropped.
 *
 * `conforms` (no viewpoint_lint error or warning) and `accepted` (it passes as one of its
 * template's) are written per diagram only when false, and counted in `viewpoints`: on the 25
 * ThingsBoard diagrams the two flags cost 225 tokens (9 a diagram) to say what two numbers say.
 */
export function deriveResult(data: unknown, input: Json): CallToolResult {
  const diagrams = (data as { diagrams?: unknown } | null)?.diagrams;
  if (!Array.isArray(diagrams)) return jsonResult(data, input);
  const flagged = (diagrams as Derived[]).filter(
    (d) => typeof d === "object" && d !== null && typeof d.conforms === "boolean",
  );
  return jsonResult(
    {
      ...(data as Json),
      diagrams: diagrams.map((d: Derived) => {
        if (typeof d !== "object" || d === null) return d;
        const counts = COUNTS.filter((c) => typeof d[c] === "number" && d[c] !== 0);
        const id =
          typeof d.diagram === "string" && !d.diagram.startsWith("$") ? d.diagram : undefined;
        return {
          kind: d.kind,
          name: d.name,
          ...(id === undefined ? {} : { diagram: id }),
          ...Object.fromEntries(counts.map((c) => [c, d[c]])),
          ...(typeof d.quality?.score === "number" ? { score: d.quality.score } : {}),
          ...(typeof d.viewpoint === "string" ? { viewpoint: d.viewpoint } : {}),
          ...(typeof d.template === "string" ? { template: d.template } : {}),
          ...(d.conforms === false ? { conforms: false } : {}),
          ...(d.accepted === false ? { accepted: false } : {}),
        };
      }),
      ...(flagged.length === 0
        ? {}
        : {
            viewpoints: {
              conforming: flagged.filter((d) => d.conforms === true).length,
              accepted: flagged.filter((d) => d.accepted === true).length,
            },
          }),
    },
    input,
  );
}

/**
 * The explanation as plain text: as a JSON string every quote and line break in it would be
 * escaped. A cut text says so on a last line: since extension #40 the extension writes that line
 * itself, naming the section and the cursor to read on from (`next`), so one without `next` is
 * an older build's and gets this server's.
 */
export function explainResult(data: unknown, input: Json): CallToolResult {
  const answer = data as { text?: unknown; truncated?: unknown; next?: unknown } | null;
  if (typeof answer?.text !== "string") return jsonResult(data, input);
  return textResult(
    answer.truncated === true && typeof answer.next !== "number"
      ? `${answer.text}\n[cut at maxChars; raise it or narrow scope]`
      : answer.text,
  );
}
