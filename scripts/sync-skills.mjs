#!/usr/bin/env node
// Writes the Codex and Copilot copies of the agent skill from the Claude Code one, which is the
// only copy edited by hand. The three hosts read the same Agent Skills format (a SKILL.md with
// name/description front matter), so the copies differ only in a note naming their source.
//
// Usage: npm run sync:skills [-- --check]
// --check writes nothing and exits 1 when a copy is missing or stale; the test suite runs it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "plugins/claude-code/skills/staruml/SKILL.md";
const COPIES = [
  "plugins/codex/staruml/skills/staruml/SKILL.md",
  "plugins/copilot/skills/staruml/SKILL.md",
];

const { values: args } = parseArgs({ options: { check: { type: "boolean", default: false } } });

/** The source with a generated-file note after its front matter. */
function render(source) {
  const end = source.indexOf("\n---\n", 4);
  if (!source.startsWith("---\n") || end < 0) throw new Error(`${SOURCE} has no front matter`);
  const head = source.slice(0, end + 5);
  const note = `<!-- Generated from ${SOURCE} by scripts/sync-skills.mjs; edit that file. -->\n`;
  return `${head}${note}${source.slice(end + 5)}`;
}

const expected = render(readFileSync(join(ROOT, SOURCE), "utf8"));
const stale = COPIES.filter((copy) => {
  const path = join(ROOT, copy);
  return !existsSync(path) || readFileSync(path, "utf8") !== expected;
});

if (args.check) {
  if (stale.length > 0) {
    console.error(`Stale skill copies: ${stale.join(", ")}. Run npm run sync:skills.`);
    process.exit(1);
  }
} else {
  for (const copy of stale) {
    mkdirSync(dirname(join(ROOT, copy)), { recursive: true });
    writeFileSync(join(ROOT, copy), expected);
    console.log(`wrote ${copy}`);
  }
}
