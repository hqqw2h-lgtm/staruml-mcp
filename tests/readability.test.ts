/**
 * The readability check (issue #20) offline: the request it sends, the judgement it reads back,
 * the verdicts, and replaying and recording, with Messages API responses from
 * tests/fixtures/readability.messages.json instead of the network.
 */
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkReadability,
  DEFAULT_READABILITY_MODEL,
  DEFAULT_THRESHOLD,
  JUDGEMENT_SCHEMA,
  judge,
  parseJudgement,
  passes,
  readabilityRequest,
  recordingClient,
  replayClient,
  type Diagram,
  type MessagesResponse,
  type Recording,
} from "../src/readability.js";

const { recordings } = JSON.parse(
  readFileSync(new URL("./fixtures/readability.messages.json", import.meta.url), "utf8"),
) as { recordings: Recording[] };

const diagram = (name: string, extra: Partial<Diagram> = {}): Diagram => ({
  name,
  kind: "sequence",
  viewpoint: "runtime",
  question: "What happens, step by step and between which parts, when the scenario is triggered?",
  png: "iVBORw0KGgo=",
  ...extra,
});

const text = (value: string): MessagesResponse => ({
  content: [{ type: "text", text: value }],
  stop_reason: "end_turn",
});

describe("readabilityRequest", () => {
  it("sends the PNG first, then the instructions, the diagram and its question, as JSON output", () => {
    const request = readabilityRequest("m", diagram("Checkout"));

    expect(request.model).toBe("m");
    expect(request.max_tokens).toBe(1024);
    expect(request.messages).toHaveLength(1);
    const [image, question] = request.messages[0]!.content;
    expect(image).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
    expect(question).toMatchObject({ type: "text" });
    const asked = (question as { text: string }).text;
    expect(asked).toContain("using only what the picture shows");
    expect(asked).toMatch(/The diagram is "Checkout" \(sequence\)\. Question: What happens/);
    expect(request.output_config).toEqual({
      format: { type: "json_schema", schema: JUDGEMENT_SCHEMA },
    });
  });

  it("uses a schema structured outputs accept: every object closed, every property required", () => {
    expect(JUDGEMENT_SCHEMA.additionalProperties).toBe(false);
    expect([...JUDGEMENT_SCHEMA.required].sort()).toEqual(
      Object.keys(JUDGEMENT_SCHEMA.properties).sort(),
    );
    expect(DEFAULT_READABILITY_MODEL).toBe("claude-haiku-4-5-20251001");
  });
});

describe("parseJudgement", () => {
  it("reads the recorded answers, clamping and rounding the confidence", () => {
    expect(parseJudgement(recordings[0]!.response)).toMatchObject({
      answerable: true,
      confidence: 86,
      missing: "",
    });
    const odd = (confidence: number) =>
      parseJudgement(
        text(JSON.stringify({ answer: "a", answerable: true, confidence, missing: "" })),
      ).confidence;
    expect(odd(140)).toBe(100);
    expect(odd(-3)).toBe(0);
    expect(odd(71.6)).toBe(72);
  });

  it("refuses a refusal, a cut reply, a reply without text, text that is not JSON or off the schema", () => {
    expect(() => parseJudgement(recordings[3]!.response)).toThrow("the model refused");
    expect(() => parseJudgement({ ...text("{}"), stop_reason: "max_tokens" })).toThrow(
      "cut at max_tokens",
    );
    expect(() => parseJudgement({ content: [{ type: "thinking" }] })).toThrow("has no text");
    expect(() => parseJudgement(text("The flow is clear."))).toThrow("is not JSON");
    expect(() => parseJudgement(text("null"))).toThrow("off the schema");
    for (const partial of [
      { answer: 1, answerable: true, confidence: 1, missing: "" },
      { answer: "a", answerable: "yes", confidence: 1, missing: "" },
      { answer: "a", answerable: true, confidence: "high", missing: "" },
      { answer: "a", answerable: true, confidence: 1 },
    ]) {
      expect(() => parseJudgement(text(JSON.stringify(partial)))).toThrow("off the schema");
    }
  });

  it("answers a judgement in range or throws an Error, for any text", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.jsonValue().map((v) => JSON.stringify(v)),
          fc
            .record({
              answer: fc.string(),
              answerable: fc.boolean(),
              confidence: fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
              missing: fc.string(),
            })
            .map((v) => JSON.stringify(v)),
        ),
        (value) => {
          try {
            const j = parseJudgement(text(value));
            expect(j.confidence).toBeGreaterThanOrEqual(0);
            expect(j.confidence).toBeLessThanOrEqual(100);
            expect(Number.isInteger(j.confidence)).toBe(true);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("passes", () => {
  it("passes an answerable judgement at or above the threshold only", () => {
    const j = { answer: "a", answerable: true, confidence: 70, missing: "" };
    expect(passes(j, 70)).toBe(true);
    expect(passes({ ...j, confidence: 69 }, 70)).toBe(false);
    expect(passes({ ...j, answerable: false, confidence: 100 }, 70)).toBe(false);
  });
});

describe("checkReadability over recorded answers", () => {
  it("judges each diagram, failing the unsure, the unanswerable, the refused and the unrecorded", async () => {
    const diagrams = [
      diagram("Seq - Telemetry ingestion over MQTT", { score: 91, template: "runtime-sequence" }),
      diagram("Class - Rule Engine", { kind: "class", viewpoint: "code" }),
      diagram("State - Alarm lifecycle", { kind: "statemachine", viewpoint: "lifecycle" }),
      diagram("Refused"),
      diagram("Never recorded"),
    ];

    const report = await checkReadability(replayClient(recordings), diagrams);

    expect(report).toMatchObject({
      model: DEFAULT_READABILITY_MODEL,
      threshold: DEFAULT_THRESHOLD,
      passed: 1,
      failed: 4,
      meanConfidence: 54,
    });
    expect(report.diagrams.map((d) => [d.name, d.passed, d.error])).toEqual([
      ["Seq - Telemetry ingestion over MQTT", true, undefined],
      ["Class - Rule Engine", false, undefined],
      ["State - Alarm lifecycle", false, undefined],
      ["Refused", false, "the model refused"],
      ["Never recorded", false, "no recording for Never recorded"],
    ]);
    expect(report.diagrams[0]).toMatchObject({
      score: 91,
      template: "runtime-sequence",
      tokens: { input: 1720, output: 74 },
    });
    expect(report.diagrams[0]).not.toHaveProperty("png");
    // No usage in the recording: no tokens.
    expect(report.diagrams[2]).not.toHaveProperty("tokens");
  });

  it("takes the model and the threshold, and reports no mean when nothing was judged", async () => {
    const lenient = await checkReadability(
      replayClient(recordings),
      [diagram("Class - Rule Engine")],
      { model: "claude-sonnet-5-5", threshold: 50 },
    );
    expect(lenient).toMatchObject({ model: "claude-sonnet-5-5", threshold: 50, passed: 1 });

    const none = await checkReadability(replayClient([]), [diagram("A")]);
    expect(none).toEqual({
      model: DEFAULT_READABILITY_MODEL,
      threshold: DEFAULT_THRESHOLD,
      diagrams: [expect.objectContaining({ name: "A", passed: false })],
      passed: 0,
      failed: 1,
    });
  });

  it("counts a usage without token fields as zero", async () => {
    const client = replayClient([
      {
        diagram: "A",
        response: {
          ...text(JSON.stringify({ answer: "a", answerable: true, confidence: 90, missing: "" })),
          usage: {},
        },
      },
    ]);
    const verdict = await judge(client, diagram("A"), { model: "m", threshold: 70 });
    expect(verdict.tokens).toEqual({ input: 0, output: 0 });
  });
});

describe("recordingClient", () => {
  it("records what the inner client answers, by diagram, and replays the same", async () => {
    const recorded: Recording[] = [];
    const inner = replayClient(recordings);
    const name = 'Seq - "quoted" (v2)';
    const recorder = recordingClient(
      {
        messages: {
          create: async (request) =>
            request.messages[0]!.content.some((c) => c.type === "text" && c.text.includes(name))
              ? recordings[0]!.response
              : inner.messages.create(request),
        },
      },
      recorded,
    );

    const first = await checkReadability(recorder, [diagram(name), diagram("Class - Rule Engine")]);
    const again = await checkReadability(replayClient(recorded), [
      diagram(name),
      diagram("Class - Rule Engine"),
    ]);

    expect(recorded.map((r) => r.diagram)).toEqual([name, "Class - Rule Engine"]);
    expect(again).toEqual(first);
  });
});
