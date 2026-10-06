/**
 * `skill.invoke` detection for every harness: the tool path (each harness's
 * skill-loading tool name), the read path (pi loads SKILL.md with `read`), and
 * the prompt path (`resolveSlashSkillPrompt` inlining and pi `/skill:`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { resolveClaudePrompt } from "../providers/claude-adapter";
import { resolveCodexPrompt, resolveSlashSkillPrompt } from "../providers/codex-skill-resolver";
import { PiMonoSession } from "../providers/pi-mono-adapter";
import {
  createPromptSkillRecorder,
  isSkillToolName,
  piPromptSkillName,
  skillInvokeFromToolStart,
} from "../providers/skill-invoke";
import type { ProviderSessionConfig } from "../providers/types";

describe("skillInvokeFromToolStart — tool path", () => {
  test.each([
    ["Skill", { skill: "commit", args: "-m x" }, "commit"],
    ["skill", { name: "work-on-task" }, "work-on-task"],
    ["skill-get", { name: "researching" }, "researching"],
    ["swarm_skill-get", { name: "planning" }, "planning"],
    ["mcp__agent-swarm__skill-get", { name: "implementing" }, "implementing"],
  ])("%s records the skill named in its args", (toolName, args, skillName) => {
    expect(skillInvokeFromToolStart(toolName, args)).toEqual({ via: "tool", skillName });
  });

  test("skill-get by id keeps the id", () => {
    expect(skillInvokeFromToolStart("skill-get", { skillId: "sk-1" })).toEqual({
      via: "tool",
      skillId: "sk-1",
    });
  });

  test("codex MCP calls carry the args one level down, as an object or a JSON string", () => {
    const call = { server: "agent-swarm", tool: "skill-get" };
    expect(
      skillInvokeFromToolStart("skill-get", { ...call, arguments: { name: "pages" } }),
    ).toEqual({ via: "tool", skillName: "pages" });
    expect(
      skillInvokeFromToolStart("skill-get", { ...call, arguments: '{"name":"apps"}' }),
    ).toEqual({ via: "tool", skillName: "apps" });
  });

  test("a skill tool with no usable name still records the invocation", () => {
    expect(skillInvokeFromToolStart("Skill", {})).toEqual({ via: "tool" });
  });

  test.each([
    "Bash",
    "Edit",
    "skill-get-file",
    "skill-list",
    "skill-search",
    "mcp__agent-swarm__skill-install",
    "swarm_skill-list",
    "Skills",
    "reskill",
  ])("negative control: %s records nothing", (toolName) => {
    expect(isSkillToolName(toolName)).toBe(false);
    expect(skillInvokeFromToolStart(toolName, { name: "commit", skill: "commit" })).toBeNull();
  });
});

describe("skillInvokeFromToolStart — read path", () => {
  test.each([
    ["read", { path: "/home/worker/.pi/agent/skills/researching/SKILL.md" }, "researching"],
    ["Read", { file_path: "/home/worker/.claude/skills/planning/SKILL.md" }, "planning"],
    ["read", { path: "/home/worker/.agents/skills/pages/SKILL.md" }, "pages"],
  ])("%s of an installed SKILL.md records the skill", (toolName, args, skillName) => {
    expect(skillInvokeFromToolStart(toolName, args)).toEqual({ via: "read", skillName });
  });

  test.each([
    ["Read", { file_path: "/workspace/repos/agent-swarm/templates/skills/pages/SKILL.md" }],
    ["read", { path: "/home/worker/.pi/agent/skills/pages/notes.md" }],
    ["Read", { file_path: "/home/worker/.claude/skills/pages/SKILL.md.bak" }],
    ["Write", { file_path: "/home/worker/.claude/skills/pages/SKILL.md" }],
  ])("negative control: %s %j records nothing", (toolName, args) => {
    expect(skillInvokeFromToolStart(toolName, args)).toBeNull();
  });
});

describe("piPromptSkillName", () => {
  const installed = ["work-on-task", "researching"];

  test("names an installed /skill: command", () => {
    expect(piPromptSkillName("/skill:work-on-task abc-123\nmore", installed)).toBe("work-on-task");
    expect(piPromptSkillName("/skill:researching", installed)).toBe("researching");
  });

  test("ignores unknown skills, other slash commands, and plain prompts", () => {
    expect(piPromptSkillName("/skill:missing abc", installed)).toBeUndefined();
    expect(piPromptSkillName("/work-on-task abc", installed)).toBeUndefined();
    expect(piPromptSkillName("please /skill:work-on-task", installed)).toBeUndefined();
  });
});

describe("createPromptSkillRecorder", () => {
  test("holds names recorded before attach, then emits each name once", () => {
    const recorder = createPromptSkillRecorder();
    const emitted: string[] = [];
    recorder.record("work-on-task");
    recorder.record("work-on-task");
    expect(emitted).toEqual([]);
    recorder.attach((name) => emitted.push(name));
    expect(emitted).toEqual(["work-on-task"]);
    recorder.record("researching");
    recorder.record("work-on-task");
    expect(emitted).toEqual(["work-on-task", "researching"]);
  });
});

describe("prompt path — resolveSlashSkillPrompt onInline", () => {
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = join(
      tmpdir(),
      `skill-invoke-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(skillsDir, "work-on-task"), { recursive: true });
    writeFileSync(join(skillsDir, "work-on-task", "SKILL.md"), "# Work on task\n");
  });

  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
  });

  test("reports the skill it inlines", async () => {
    const inlined: string[] = [];
    const prompt = await resolveSlashSkillPrompt("/work-on-task abc-123", {
      providerLabel: "opencode",
      skillsDir,
      onInline: (name) => inlined.push(name),
    });
    expect(prompt).toContain("# Work on task");
    expect(inlined).toEqual(["work-on-task"]);
  });

  test("codex passes onInline through", async () => {
    const inlined: string[] = [];
    await resolveCodexPrompt("/work-on-task abc", skillsDir, undefined, (n) => inlined.push(n));
    expect(inlined).toEqual(["work-on-task"]);
  });

  test("claude reports skills under <home>/.claude/skills", async () => {
    const home = join(skillsDir, "home");
    mkdirSync(join(home, ".claude", "skills", "researching"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "researching", "SKILL.md"), "# Research\n");
    const inlined: string[] = [];
    await resolveClaudePrompt("/researching topic", home, (n) => inlined.push(n));
    expect(inlined).toEqual(["researching"]);
  });

  test("negative control: a missing SKILL.md or a plain prompt reports nothing", async () => {
    const inlined: string[] = [];
    const onInline = (name: string) => inlined.push(name);
    const missing = await resolveSlashSkillPrompt("/no-such-skill abc", {
      providerLabel: "dsh",
      skillsDir,
      onInline,
    });
    const plain = await resolveSlashSkillPrompt("just do the work", {
      providerLabel: "dsh",
      skillsDir,
      onInline,
    });
    expect(missing).toBe("/no-such-skill abc");
    expect(plain).toBe("just do the work");
    expect(inlined).toEqual([]);
  });
});

describe("prompt path — pi /skill:", () => {
  function piSession(prompt: string, onPromptSkill: (name: string) => void): PiMonoSession {
    const agentSession = {
      sessionId: "mock-session-id",
      isStreaming: false,
      model: undefined,
      resourceLoader: { getSkills: () => ({ skills: [{ name: "work-on-task" }] }) },
      subscribe: () => () => {},
      prompt: async () => {},
      getContextUsage: () => null,
      getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        userMessages: 0,
        assistantMessages: 0,
      }),
      abort: async () => {},
      dispose: () => {},
    } as unknown as AgentSession;
    const config: ProviderSessionConfig = {
      prompt,
      systemPrompt: "",
      model: "test-model",
      role: "worker",
      agentId: "test-agent-id",
      taskId: "test-task-id",
      apiUrl: "http://localhost:0",
      apiKey: "test",
      cwd: tmpdir(),
      logFile: join(tmpdir(), `skill-invoke-pi-${Date.now()}-${Math.random()}.log`),
      onPromptSkill,
    };
    return new PiMonoSession(agentSession, config, false);
  }

  test("reports an installed skill the prompt opens with", async () => {
    const reported: string[] = [];
    await piSession("/skill:work-on-task abc-123", (n) => reported.push(n)).waitForCompletion();
    expect(reported).toEqual(["work-on-task"]);
  });

  test("negative control: an unknown skill or plain prompt reports nothing", async () => {
    const reported: string[] = [];
    await piSession("/skill:unknown abc", (n) => reported.push(n)).waitForCompletion();
    await piSession("plain prompt", (n) => reported.push(n)).waitForCompletion();
    expect(reported).toEqual([]);
  });
});
