/**
 * The readability check of issue #20: each derived diagram's PNG goes to a lower-tier model with
 * the question its viewpoint must answer (extension #42's catalogue, `/list_viewpoints`), and the
 * model answers from the picture alone and rates how sure it is. A diagram whose question the
 * model cannot answer, or answers below the threshold, fails. The scores track something the
 * geometry metric of `/diagram_quality` cannot see: whether the view says what it is for.
 *
 * Nothing here touches the network. The Messages API is reached through {@link MessagesClient},
 * the slice of `@anthropic-ai/sdk`'s client this module calls, so scripts/readability-check.mjs
 * passes a real client and the tests pass recorded answers. The module is not part of the
 * server's bundle (src/index.ts does not import it).
 */

/**
 * Haiku 4.5 by its dated id, as issue #20 names it: the cheapest current model with vision and
 * structured outputs (Anthropic's model overview, October 2026). A readable diagram should not
 * need a stronger reader.
 */
export const DEFAULT_READABILITY_MODEL = "claude-haiku-4-5-20251001";

/**
 * Confidence, 0-100, a diagram's answer needs to pass: the reader commits to an answer it can
 * point at in the picture. No run with a key has been recorded yet to calibrate it against, so
 * scripts/readability-check.mjs takes `--threshold`.
 */
export const DEFAULT_THRESHOLD = 70;

/**
 * An answer and its explanation fit in a few hundred tokens; the cap only stops a runaway reply,
 * which then fails to parse and is reported as an error rather than a verdict.
 */
const MAX_TOKENS = 1024;

/** What the reader is asked to return: Messages API structured outputs (`output_config.format`). */
export const JUDGEMENT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The answer, from the picture alone." },
    answerable: {
      type: "boolean",
      description: "Whether the picture holds enough to answer the question.",
    },
    confidence: {
      type: "integer",
      description: "0-100: how sure the answer is right and fully shown by the picture.",
    },
    missing: {
      type: "string",
      description: "What the picture lacks to answer it; empty if nothing.",
    },
  },
  required: ["answer", "answerable", "confidence", "missing"],
  additionalProperties: false,
} as const;

const INSTRUCTIONS =
  "You are shown one diagram as an image and a question the diagram is meant to answer. " +
  "Answer the question using only what the picture shows: do not use outside knowledge of the " +
  "system or guess what the names usually mean. If the picture does not hold enough to answer, " +
  "set answerable to false and say in missing what it lacks. Rate confidence from 0 to 100: how " +
  "sure you are that your answer is right and that every part of it can be read off the picture.";

/** The parts of a Messages API request and response this module uses. */
export interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: {
    role: "user";
    content: (
      | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
      | { type: "text"; text: string }
    )[];
  }[];
  output_config: { format: { type: "json_schema"; schema: typeof JUDGEMENT_SCHEMA } };
}

export interface MessagesResponse {
  content: { type: string; text?: string }[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** `client.messages` of `new Anthropic()`, or a replay of recorded answers. */
export interface MessagesClient {
  messages: { create(request: MessagesRequest): Promise<MessagesResponse> };
}

/** One diagram to read, as the check found it. */
export interface Diagram {
  name: string;
  kind: string;
  viewpoint: string;
  /** What the viewpoint's views answer (`/list_viewpoints`). */
  question: string;
  /** The PNG, base64. */
  png: string;
  /** derive_diagrams' quality score, kept next to the verdict. */
  score?: number;
  template?: string;
}

export interface Judgement {
  answer: string;
  answerable: boolean;
  confidence: number;
  missing: string;
}

export interface Verdict extends Omit<Diagram, "png"> {
  judgement?: Judgement;
  /** Why no judgement was had: a refusal, a cut reply, an answer off the schema, a failed call. */
  error?: string;
  passed: boolean;
  tokens?: { input: number; output: number };
}

export interface Report {
  model: string;
  threshold: number;
  diagrams: Verdict[];
  passed: number;
  failed: number;
  /** Mean confidence of the judged diagrams; absent when none was judged. */
  meanConfidence?: number;
}

/** The request for one diagram: the image first, then the question (Anthropic's vision guide). */
export function readabilityRequest(model: string, diagram: Diagram): MessagesRequest {
  return {
    model,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: diagram.png } },
          {
            type: "text",
            text: `${INSTRUCTIONS}\n\nThe diagram is "${diagram.name}" (${diagram.kind}). Question: ${diagram.question}`,
          },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema: JUDGEMENT_SCHEMA } },
  };
}

/**
 * The judgement in a response, or why there is none. A refusal or a reply cut at `max_tokens`
 * may not match the schema (Anthropic's structured-outputs notes), so either is an error, as is
 * text that is not the schema's object.
 */
export function parseJudgement(response: MessagesResponse): Judgement {
  if (response.stop_reason === "refusal") throw new Error("the model refused");
  if (response.stop_reason === "max_tokens") throw new Error("the reply was cut at max_tokens");
  const text = response.content.find((block) => block.type === "text")?.text;
  if (text === undefined) throw new Error("the reply has no text");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`the reply is not JSON: ${text.slice(0, 80)}`);
  }
  const j = value as Partial<Judgement> | null;
  if (
    typeof j?.answer !== "string" ||
    typeof j.answerable !== "boolean" ||
    typeof j.confidence !== "number" ||
    typeof j.missing !== "string"
  ) {
    throw new Error(`the reply is off the schema: ${text.slice(0, 80)}`);
  }
  return {
    answer: j.answer,
    answerable: j.answerable,
    confidence: Math.min(100, Math.max(0, Math.round(j.confidence))),
    missing: j.missing,
  };
}

/** A diagram passes when the picture answers its question and the reader is sure enough. */
export function passes(judgement: Judgement, threshold: number): boolean {
  return judgement.answerable && judgement.confidence >= threshold;
}

/** Reads one diagram; a failed call is a failed diagram, not a failed check. */
export async function judge(
  client: MessagesClient,
  diagram: Diagram,
  options: { model: string; threshold: number },
): Promise<Verdict> {
  const { png: _png, ...shown } = diagram;
  try {
    const response = await client.messages.create(readabilityRequest(options.model, diagram));
    const judgement = parseJudgement(response);
    return {
      ...shown,
      judgement,
      passed: passes(judgement, options.threshold),
      ...(response.usage === undefined
        ? {}
        : {
            tokens: {
              input: response.usage.input_tokens ?? 0,
              output: response.usage.output_tokens ?? 0,
            },
          }),
    };
  } catch (error) {
    return { ...shown, error: (error as Error).message, passed: false };
  }
}

/**
 * Every diagram read in turn, not at once: the check runs beside StarUML on one machine and a
 * burst of vision calls would meet the account's rate limit before it saved any time.
 */
export async function checkReadability(
  client: MessagesClient,
  diagrams: readonly Diagram[],
  options: { model?: string; threshold?: number } = {},
): Promise<Report> {
  const model = options.model ?? DEFAULT_READABILITY_MODEL;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const verdicts: Verdict[] = [];
  for (const diagram of diagrams) verdicts.push(await judge(client, diagram, { model, threshold }));
  const judged = verdicts.flatMap((v) => (v.judgement === undefined ? [] : [v.judgement]));
  const passed = verdicts.filter((v) => v.passed).length;
  return {
    model,
    threshold,
    diagrams: verdicts,
    passed,
    failed: verdicts.length - passed,
    ...(judged.length === 0
      ? {}
      : {
          meanConfidence: Math.round(
            judged.reduce((sum, j) => sum + j.confidence, 0) / judged.length,
          ),
        }),
  };
}

/** The diagram name {@link readabilityRequest} wrote into the question. */
function diagramOf(request: MessagesRequest): string {
  const text = request.messages[0]!.content.find((c) => c.type === "text") as { text: string };
  return /The diagram is "(.*)" \(/.exec(text.text)![1]!;
}

/** A recorded response, keyed by the diagram it answered. */
export interface Recording {
  diagram: string;
  response: MessagesResponse;
}

/**
 * A {@link MessagesClient} that answers from recordings by the diagram name in the request's
 * text, and fails a request for a diagram it has no recording of, as the API fails a call.
 */
export function replayClient(recordings: readonly Recording[]): MessagesClient {
  const byName = new Map(recordings.map((r) => [r.diagram, r.response]));
  return {
    messages: {
      create: async (request) => {
        const name = diagramOf(request);
        const response = byName.get(name);
        if (response === undefined) throw new Error(`no recording for ${name}`);
        return response;
      },
    },
  };
}

/**
 * A client that records what `inner` answers, for scripts/readability-check.mjs `--record`: a
 * run with a key leaves fixtures a run without one replays.
 */
export function recordingClient(inner: MessagesClient, recordings: Recording[]): MessagesClient {
  return {
    messages: {
      create: async (request) => {
        const response = await inner.messages.create(request);
        recordings.push({ diagram: diagramOf(request), response });
        return response;
      },
    },
  };
}
