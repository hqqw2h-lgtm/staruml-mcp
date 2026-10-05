import { readFileSync } from "node:fs";

export const SKILL_PATH = new URL(
  "../../plugins/claude-code/skills/staruml/SKILL.md",
  import.meta.url,
);

export interface SkillExample {
  tool: string;
  args: Record<string, unknown>;
  /** 1-based line of the opening fence, for failure messages. */
  line: number;
}

export function readSkill(): string {
  return readFileSync(SKILL_PATH, "utf8");
}

/** The `json <tool>` blocks of the skill: every one is a tool call an agent may copy. */
export function skillExamples(source = readSkill()): SkillExample[] {
  const examples: SkillExample[] = [];
  for (const match of source.matchAll(/^```json ([a-z_]+)\n([\s\S]*?)^```$/gm)) {
    const line = source.slice(0, match.index).split("\n").length;
    examples.push({
      tool: match[1]!,
      args: JSON.parse(match[2]!) as Record<string, unknown>,
      line,
    });
  }
  return examples;
}

/** The front matter's `key: value` lines. */
export function frontMatter(source = readSkill()): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
}
