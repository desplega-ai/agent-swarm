import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { SEED_SCRIPTS } from "../be/seed-scripts";

// A shipped skill that tells agents to `script-run` a named script must name a
// script this repo ships in SEED_SCRIPTS. Otherwise the skill works only on a
// swarm that happens to hold that script in its catalog, and every other
// deployment hits "Script not found" at that step.

const REPO_ROOT = join(import.meta.dir, "../..");
// Seeded skills, baked plugin commands/agents/skills, and public operator skills.
const SKILL_DIRS = ["templates/skills", "plugin", "skills"].map((d) => join(REPO_ROOT, d));

// `script-run name="x"` and the prose forms "`script-run` with name `x`" / "`script-run` on `x`".
const REF_PATTERNS = [
  /script-run\s+name=["']([a-z0-9][a-z0-9-]*)["']/g,
  /`script-run`\s+(?:with\s+name|on)\s+`([a-z0-9][a-z0-9-]*)`/g,
];

function findScriptRefs(text: string): string[] {
  const names = new Set<string>();
  for (const re of REF_PATTERNS) {
    for (const m of text.matchAll(re)) if (m[1]) names.add(m[1]);
  }
  return [...names];
}

async function collectRefs(): Promise<{ file: string; name: string }[]> {
  const refs: { file: string; name: string }[] = [];
  for (const dir of SKILL_DIRS) {
    for await (const path of new Bun.Glob("**/*.md").scan({ cwd: dir, absolute: true })) {
      const text = await Bun.file(path).text();
      for (const name of findScriptRefs(text)) refs.push({ file: relative(REPO_ROOT, path), name });
    }
  }
  return refs;
}

describe("shipped skills only script-run scripts the repo ships", () => {
  test("the reference scanner matches each call form and ignores prose", () => {
    expect(
      findScriptRefs(
        [
          'Run `script-run name="internal-only-gate" scope="global" args=<draft>`.',
          "Run `script-run` with name `boot-triage`.",
          "Preview with `script-run` on `heartbeat-jev-gate`.",
          "Seed scripts (`script-run` with `name` and `args`):",
          "Inline `script-run` for a one-off.",
        ].join("\n"),
      ).sort(),
    ).toEqual(["boot-triage", "heartbeat-jev-gate", "internal-only-gate"]);
  });

  test("every script-run name in a shipped skill is in SEED_SCRIPTS", async () => {
    const refs = await collectRefs();
    // Positive control: the scan must see heartbeat-runbook's boot-triage reference, or it is blind.
    expect(refs.some((r) => r.name === "boot-triage")).toBe(true);

    const shipped = new Set(SEED_SCRIPTS.map((s) => s.name));
    const missing = refs.filter((r) => !shipped.has(r.name)).map((r) => `${r.file}: ${r.name}`);
    expect(missing).toEqual([]);
  });
});
