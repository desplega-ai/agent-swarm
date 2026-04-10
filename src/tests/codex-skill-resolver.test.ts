/**
 * Phase 4 unit tests for the Codex slash-command / skill resolver.
 *
 * We populate a temporary skills directory with fake `SKILL.md` files and
 * exercise `resolveCodexPrompt` against several prompt shapes. The resolver is
 * purposefully decoupled from the Codex SDK so these tests run without any
 * adapter / network plumbing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexPrompt } from "../providers/codex-skill-resolver";
import type { ProviderEvent } from "../providers/types";

/** Create a fresh tmp skills dir for each test to avoid cross-test leakage. */
let skillsDir: string;

beforeEach(() => {
  skillsDir = join(
    tmpdir(),
    `codex-skill-resolver-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(skillsDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — don't mask real test failures.
  }
});

/** Write `${skillsDir}/<name>/SKILL.md` with the given content. */
async function writeSkill(name: string, content: string): Promise<void> {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "SKILL.md"), content);
}

describe("resolveCodexPrompt", () => {
  test("inlines known skill and preserves trailing args + body", async () => {
    const skillBody = "You are a task worker. Follow these steps carefully.";
    await writeSkill("work-on-task", skillBody);

    const prompt = "/work-on-task task-123\n\nProceed carefully.";
    const result = await resolveCodexPrompt(prompt, skillsDir);

    // Skill content is at the top.
    expect(result.startsWith(skillBody)).toBe(true);
    // Separator delimits skill from user request.
    expect(result).toContain("\n\n---\n\n");
    // User request section contains both the trailing args and the body.
    expect(result).toContain("User request: task-123");
    expect(result).toContain("Proceed carefully.");
    // The original slash-command line must NOT appear verbatim — the resolver
    // strips it and repackages the remainder as "User request: …".
    expect(result).not.toContain("/work-on-task task-123");
  });

  test("returns prompt unchanged when there is no slash command", async () => {
    const prompt = "Please say hi";
    const result = await resolveCodexPrompt(prompt, skillsDir);
    expect(result).toBe(prompt);
  });

  test("emits raw_stderr warning and leaves prompt unchanged for unknown skill", async () => {
    const events: ProviderEvent[] = [];
    const emit = (event: ProviderEvent) => events.push(event);

    const prompt = "/nonexistent-skill foo";
    const result = await resolveCodexPrompt(prompt, skillsDir, emit);

    expect(result).toBe(prompt);
    expect(events.length).toBe(1);
    const evt = events[0];
    expect(evt?.type).toBe("raw_stderr");
    if (evt?.type === "raw_stderr") {
      expect(evt.content).toContain("nonexistent-skill");
      expect(evt.content).toContain("SKILL.md not found");
    }
  });

  test("emit callback is optional — missing skill silently drops the warning", async () => {
    const prompt = "/nonexistent-skill foo";
    // No emit callback passed — should not throw.
    const result = await resolveCodexPrompt(prompt, skillsDir);
    expect(result).toBe(prompt);
  });

  test("inlines skill whose name contains a colon", async () => {
    const skillBody = "Research skill: start by gathering context.";
    await writeSkill("desplega:research", skillBody);

    const prompt = "/desplega:research some topic";
    const result = await resolveCodexPrompt(prompt, skillsDir);

    expect(result.startsWith(skillBody)).toBe(true);
    expect(result).toContain("User request: some topic");
  });

  test("inlines skill even when slash command has no trailing args or body", async () => {
    const skillBody = "Self-contained worker skill.";
    await writeSkill("work-on-task", skillBody);

    const prompt = "/work-on-task";
    const result = await resolveCodexPrompt(prompt, skillsDir);

    // Skill is still inlined.
    expect(result.startsWith(skillBody)).toBe(true);
    expect(result).toContain("\n\n---\n\n");
    // The "User request:" label is present but the body is empty.
    expect(result).toContain("User request: ");
    // Nothing after the label except trailing whitespace.
    const userRequestIdx = result.indexOf("User request: ");
    const tail = result.slice(userRequestIdx + "User request: ".length);
    expect(tail.trim()).toBe("");
  });

  test("multi-line prompt: trailing args on slash line + subsequent lines both preserved", async () => {
    const skillBody = "Multi-line test skill.";
    await writeSkill("multi", skillBody);

    const prompt = "/multi arg1 arg2\nline 2\nline 3";
    const result = await resolveCodexPrompt(prompt, skillsDir);

    expect(result.startsWith(skillBody)).toBe(true);
    // Trailing args land on the first line of the user request.
    expect(result).toContain("User request: arg1 arg2\nline 2\nline 3");
  });

  test("empty prompt returns empty prompt", async () => {
    const result = await resolveCodexPrompt("", skillsDir);
    expect(result).toBe("");
  });

  test("prompt with leading whitespace before slash is still detected", async () => {
    const skillBody = "Whitespace-tolerant skill.";
    await writeSkill("work-on-task", skillBody);

    const prompt = "  /work-on-task abc";
    const result = await resolveCodexPrompt(prompt, skillsDir);

    expect(result.startsWith(skillBody)).toBe(true);
    expect(result).toContain("User request: abc");
  });
});
