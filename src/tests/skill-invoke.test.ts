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
  createSkillInvokeTracker,
  isSkillLoaderCall,
  piPromptSkillName,
  type SkillInvoke,
  skillInvokeFromToolStart,
} from "../providers/skill-invoke";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";

describe("skillInvokeFromToolStart — tool path", () => {
  test.each([
    ["Skill", { skill: "commit", args: "-m x" }, "commit"],
    ["skill", { name: "work-on-task" }, "work-on-task"],
    ["skill-get", { name: "researching" }, "researching"],
    ["swarm_skill-get", { name: "planning" }, "planning"],
    ["mcp__agent-swarm__skill-get", { name: "implementing" }, "implementing"],
    ["mcp__agent_swarm__skill_get", { name: "pages" }, "pages"],
    ["agent-swarm.skill-get", { name: "apps" }, "apps"],
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
    expect(isSkillLoaderCall(toolName, {})).toBe(false);
    expect(skillInvokeFromToolStart(toolName, { name: "commit", skill: "commit" })).toBeNull();
  });
});

describe("skillInvokeFromToolStart — only known skill loaders count", () => {
  test.each([
    // Codex reports an MCP call by its bare tool name; the server sits in the args.
    ["skill", { server: "crm", tool: "skill", arguments: { name: "typescript" } }],
    ["skill-get", { server: "crm", tool: "skill-get", arguments: { name: "typescript" } }],
    ["skill_get", { server: "docs", tool: "skill_get", arguments: '{"name":"typescript"}' }],
    ["skill-get", { server: "agent-swarm", tool: "skill-list", arguments: { name: "x" } }],
    // Prefixed names from a server other than the swarm's.
    ["mcp__crm__skill_get", { name: "typescript" }],
    ["mcp__crm__skill-get", { name: "typescript" }],
    ["mcp__crm__Skill", { skill: "typescript" }],
    ["crm_skill-get", { name: "typescript" }],
    ["crm.skill-get", { name: "typescript" }],
    ["crm:skill_get", { name: "typescript" }],
  ])("negative control: %s %j records nothing", (toolName, args) => {
    expect(isSkillLoaderCall(toolName, args)).toBe(false);
    expect(skillInvokeFromToolStart(toolName, args)).toBeNull();
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

describe("createSkillInvokeTracker", () => {
  function track() {
    const tracker = createSkillInvokeTracker();
    const emitted: SkillInvoke[] = [];
    return { tracker, emitted, attach: () => tracker.attach((i) => emitted.push(i)) };
  }
  const toolStart = (toolCallId: string, toolName: string, args: unknown): ProviderEvent => ({
    type: "tool_start",
    toolCallId,
    toolName,
    args,
  });
  const toolEnd = (toolCallId: string, isError?: boolean): ProviderEvent => ({
    type: "tool_end",
    toolCallId,
    toolName: "read",
    result: isError ? "ENOENT: no such file or directory" : "# Skill",
    ...(isError === undefined ? {} : { isError }),
  });
  const skillMd = (name: string) => ({ path: `/home/worker/.pi/agent/skills/${name}/SKILL.md` });

  test("holds invocations recorded before attach, then emits each skill once", () => {
    const { tracker, emitted, attach } = track();
    tracker.promptSkill("work-on-task");
    tracker.promptSkill("work-on-task");
    expect(emitted).toEqual([]);
    attach();
    expect(emitted).toEqual([{ via: "prompt", skillName: "work-on-task" }]);
    tracker.promptSkill("researching");
    expect(emitted.map((i) => i.skillName)).toEqual(["work-on-task", "researching"]);
  });

  test("one session-level row per skill across prompt, tool, and read delivery", () => {
    const { tracker, emitted, attach } = track();
    tracker.promptSkill("work-on-task");
    attach();
    tracker.onEvent(toolStart("t1", "skill-get", { name: "work-on-task" }));
    tracker.onEvent(toolStart("t2", "mcp__agent-swarm__skill-get", { name: "work-on-task" }));
    tracker.onEvent(toolStart("t3", "read", skillMd("work-on-task")));
    tracker.onEvent(toolEnd("t3"));
    tracker.onEvent(toolStart("t4", "Skill", { skill: "researching" }));
    tracker.onEvent(toolStart("t5", "read", skillMd("researching")));
    tracker.onEvent(toolEnd("t5"));
    expect(emitted).toEqual([
      { via: "prompt", skillName: "work-on-task" },
      { via: "tool", skillName: "researching" },
    ]);
  });

  test("a call naming both a skill and its id claims both keys", () => {
    const { tracker, emitted, attach } = track();
    attach();
    tracker.onEvent(toolStart("t1", "skill-get", { name: "pages", skillId: "sk-1" }));
    tracker.onEvent(toolStart("t2", "skill-get", { skillId: "sk-1" }));
    tracker.onEvent(toolStart("t3", "skill-get", { name: "pages" }));
    expect(emitted).toEqual([{ via: "tool", skillName: "pages", skillId: "sk-1" }]);
  });

  test("a SKILL.md read counts only after its tool_end succeeds", () => {
    const { tracker, emitted, attach } = track();
    attach();
    tracker.onEvent(toolStart("r1", "read", skillMd("researching")));
    expect(emitted).toEqual([]);
    tracker.onEvent(toolEnd("r1", false));
    expect(emitted).toEqual([{ via: "read", skillName: "researching" }]);
  });

  test("negative control: a failed or unfinished SKILL.md read records nothing", () => {
    const { tracker, emitted, attach } = track();
    attach();
    tracker.onEvent(toolStart("r1", "read", skillMd("does-not-exist")));
    tracker.onEvent(toolEnd("r1", true));
    tracker.onEvent(toolStart("r2", "read", skillMd("never-finished")));
    tracker.onEvent(toolEnd("other-call"));
    expect(emitted).toEqual([]);
    // The failed read does not claim the name: a later successful load still counts.
    tracker.onEvent(toolStart("r3", "read", skillMd("does-not-exist")));
    tracker.onEvent(toolEnd("r3"));
    expect(emitted).toEqual([{ via: "read", skillName: "does-not-exist" }]);
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

describe("read path — pi event boundary", () => {
  type PiListener = (event: Record<string, unknown>) => void;

  /** A pi session whose prompt runs two `read` calls of SKILL.md: one fails, one succeeds. */
  function piReadSession(): PiMonoSession {
    const listeners: PiListener[] = [];
    const read = (toolCallId: string, name: string, isError: boolean) => {
      const args = { path: `/home/worker/.pi/agent/skills/${name}/SKILL.md` };
      for (const l of listeners)
        l({ type: "tool_execution_start", toolCallId, toolName: "read", args });
      for (const l of listeners) {
        l({
          type: "tool_execution_end",
          toolCallId,
          toolName: "read",
          result: isError ? "ENOENT: no such file or directory" : "# Skill",
          isError,
        });
      }
    };
    const agentSession = {
      sessionId: "mock-session-id",
      isStreaming: false,
      model: undefined,
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      subscribe: (listener: PiListener) => {
        listeners.push(listener);
        return () => {};
      },
      prompt: async () => {
        read("missing", "does-not-exist", true);
        read("found", "researching", false);
      },
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
      prompt: "load your skills",
      systemPrompt: "",
      model: "test-model",
      role: "worker",
      agentId: "test-agent-id",
      taskId: "test-task-id",
      apiUrl: "http://localhost:0",
      apiKey: "test",
      cwd: tmpdir(),
      logFile: join(tmpdir(), `skill-invoke-pi-read-${Date.now()}-${Math.random()}.log`),
    };
    return new PiMonoSession(agentSession, config, false);
  }

  test("a failed read is not a skill load; the successful one is", async () => {
    const tracker = createSkillInvokeTracker();
    const emitted: SkillInvoke[] = [];
    tracker.attach((i) => emitted.push(i));
    const session = piReadSession();
    const toolEnds: ProviderEvent[] = [];
    session.onEvent((event) => {
      if (event.type === "tool_end") toolEnds.push(event);
      tracker.onEvent(event);
    });
    await session.waitForCompletion();
    expect(toolEnds.map((e) => e.type === "tool_end" && [e.toolCallId, e.isError])).toEqual([
      ["missing", true],
      ["found", false],
    ]);
    expect(emitted).toEqual([{ via: "read", skillName: "researching" }]);
  });
});
