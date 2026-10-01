/**
 * The claude harness must deliver the task body once in a task's first
 * message. Claude Code's native `/<skill> <args>` expansion puts the args in
 * `<command-args>` and again after `ARGUMENTS:`, so the adapter inlines the
 * runner's skill command instead (`resolveClaudePrompt`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptForTrigger, buildResumePrompt } from "../commands/runner";
import { ClaudeAdapter, resolveClaudePrompt } from "../providers/claude-adapter";

const BODY_MARKER = "BODY-MARKER-4c1e";
const TASK_ID = "00000000-0000-4000-8000-000000000001";
const BODY = `${BODY_MARKER} Fix the flaky export.\n\nMulti-line body with "quotes" and $ARGUMENTS text.`;

let home: string;
const fmt = (cmd: string) => new ClaudeAdapter().formatCommand(cmd);

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeAll(() => {
  home = join(tmpdir(), `claude-prompt-body-once-${crypto.randomUUID()}`);
  for (const skill of ["work-on-task", "review-offered-task"]) {
    const dir = join(home, ".claude", "skills", skill);
    mkdirSync(dir, { recursive: true });
    cpSync(
      join(import.meta.dir, "../../templates/skills", skill, "SKILL.md"),
      join(dir, "SKILL.md"),
    );
  }
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  // Other test files clear the template registry; re-register the defaults.
  await import(`../commands/templates?t=${Date.now()}`);
});

describe("claude first-message prompt", () => {
  const cases: Array<{ name: string; skill: string; build: () => Promise<string> }> = [
    {
      name: "task_assigned (new tasks, follow-ups, heartbeat checklist)",
      skill: "work-on-task",
      build: () =>
        buildPromptForTrigger(
          { type: "task_assigned", taskId: TASK_ID, task: { id: TASK_ID, task: BODY } },
          "",
          fmt,
        ),
    },
    {
      name: "task_offered",
      skill: "review-offered-task",
      build: () =>
        buildPromptForTrigger(
          { type: "task_offered", taskId: TASK_ID, task: { id: TASK_ID, task: BODY } },
          "",
          fmt,
        ),
    },
    {
      name: "resumed task with progress",
      skill: "work-on-task",
      build: () => buildResumePrompt({ id: TASK_ID, task: BODY, progress: "Read the file" }, fmt),
    },
    {
      name: "resumed task without progress",
      skill: "work-on-task",
      build: () => buildResumePrompt({ id: TASK_ID, task: BODY }, fmt),
    },
  ];

  for (const { name, skill, build } of cases) {
    test(`${name}: skill inlined, body sent once`, async () => {
      const runnerPrompt = await build();
      // The runner still emits a slash command carrying the body as its args.
      expect(runnerPrompt.startsWith(`/${skill} ${TASK_ID}`)).toBe(true);

      const prompt = await resolveClaudePrompt(runnerPrompt, home);

      // No leading slash, so Claude Code does not re-expand (and duplicate) it.
      expect(prompt.startsWith("/")).toBe(false);
      // No leading dash either: `claude -p <prompt>` would parse it as an option.
      expect(prompt.startsWith("-")).toBe(false);
      expect(prompt.startsWith("# ")).toBe(true);
      expect(prompt).not.toContain(`name: ${skill}`);
      expect(prompt).toContain(`User request: ${TASK_ID}`);
      expect(prompt).toContain(TASK_ID);
      expect(countOccurrences(prompt, BODY_MARKER)).toBe(1);
    });
  }

  test("commands without a SKILL.md pass through for native expansion", async () => {
    const runnerPrompt = `/desplega:research ${TASK_ID}\n\n${BODY}`;
    expect(await resolveClaudePrompt(runnerPrompt, home)).toBe(runnerPrompt);
  });

  test("a skill that would start the prompt with a dash keeps the native form", async () => {
    const dir = join(home, ".claude", "skills", "dash-skill");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "SKILL.md"), "--flag-looking first line\n");
    const runnerPrompt = `/dash-skill ${TASK_ID}\n\n${BODY}`;
    expect(await resolveClaudePrompt(runnerPrompt, home)).toBe(runnerPrompt);
  });

  test("prompts without a slash command are unchanged", async () => {
    expect(await resolveClaudePrompt(BODY, home)).toBe(BODY);
  });
});
