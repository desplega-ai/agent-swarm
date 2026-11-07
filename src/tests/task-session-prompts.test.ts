import { describe, expect, test } from "bun:test";
import {
  buildRequesterProfilePrompt,
  buildTaskSessionPrompts,
  type TaskSessionContext,
} from "../commands/runner";
import { type BasePromptArgs, getTaskContextPrompt } from "../prompts/base-prompt";
import type { ProviderName } from "../types";

// The provider caches the system prompt as a prefix, so any per-task byte in it
// re-bills the whole prompt on the first call of every session. These tests pin
// the split: one agent, different tasks, requesters and repos, same system
// prompt; the per-task context still reaches the model, in the task prompt.

const agentArgs = (
  provider: ProviderName,
  extra: Partial<BasePromptArgs> = {},
): BasePromptArgs => ({
  role: "worker",
  agentId: "11111111-2222-3333-4444-555555555555",
  name: "Ada",
  provider,
  traits: { hasMcp: true, hasLocalEnvironment: true, nativeSkillDiscovery: provider !== "codex" },
  soulMd: "You are Ada.",
  claudeMd: "# Agent: Ada\n\nAlways run the tests before you push.",
  skillsSummary: [{ name: "commit", description: "Create a commit" }],
  mcpServers: ["linear"],
  ...extra,
});

const sessionA: TaskSessionContext = {
  repoContext: {
    clonePath: "/workspace/personal/repos/alpha",
    claudeMd: "Alpha repo rules.",
    warning: "Alpha is behind origin",
    autoStashes: [{ ref: "stash@{0}", message: "WIP alpha" }],
    guidelines: {
      prChecks: ["bun run lint"],
      mergeChecks: ["CI green"],
      allowMerge: false,
      review: ["Check the db boundary"],
    },
  },
  slackContext: { channelId: "C0ALPHA", threadTs: "111.222" },
  requestedBy: {
    name: "Taras",
    role: "CTO",
    notes: "Lead with the answer.",
    comms: { verbosity: "terse" },
  },
  cwdWarning: 'Note: The task requested working directory "/nope" but it does not exist.',
};

const sessionB: TaskSessionContext = {
  repoContext: { clonePath: "/workspace/personal/repos/beta", guidelines: null },
  requestedBy: { name: "Eze", role: "CEO", comms: { language: "Spanish" } },
};

// A heartbeat: no repository, no requester, no working directory.
const sessionC: TaskSessionContext = {};

async function build(args: BasePromptArgs, context: TaskSessionContext, taskPrompt: string) {
  return buildTaskSessionPrompts({
    basePromptArgs: args,
    additionalSystemPrompt: "Operator note: be careful.",
    taskPrompt,
    context,
  });
}

describe("buildTaskSessionPrompts", () => {
  for (const provider of ["claude", "codex", "opencode", "pi"] as const) {
    test(`${provider}: the system prompt is byte-identical across tasks, requesters and repos`, async () => {
      const a = await build(agentArgs(provider), sessionA, "/work-on-task aaa\n\nTask: alpha");
      const b = await build(agentArgs(provider), sessionB, "/work-on-task bbb\n\nTask: beta");
      const c = await build(agentArgs(provider), sessionC, "/work-on-task ccc\n\nTask: heartbeat");

      expect(a.systemPrompt).toBe(b.systemPrompt);
      expect(a.systemPrompt).toBe(c.systemPrompt);
      expect(a.systemPrompt).toEndWith("\n\nOperator note: be careful.");
      for (const perTask of ["## Repository", "## Requester Profile", "Taras", "Eze", "/nope"]) {
        expect(a.systemPrompt).not.toContain(perTask);
      }
    });
  }

  test("a scripts-only worker keeps the system prompt stable across Slack and non-Slack tasks", async () => {
    const keys = ["SLACK_DISABLE", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] as const;
    const saved = keys.map((key) => [key, process.env[key]] as const);
    delete process.env.SLACK_DISABLE;
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";
    try {
      const args = agentArgs("claude", { scriptsOnly: true });
      const a = await build(args, sessionA, "task a");
      const c = await build(args, sessionC, "task c");
      expect(a.systemPrompt).toBe(c.systemPrompt);
      expect(a.systemPrompt).not.toContain("C0ALPHA");
      expect(a.prompt).toContain("## Slack (scripts-only)");
      expect(a.prompt).toContain("C0ALPHA");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("the per-task context reaches the task prompt with the same text, after the task", async () => {
    const args = agentArgs("opencode");
    const taskPrompt = "/work-on-task aaa\n\nTask: alpha";
    const { prompt } = await build(args, sessionA, taskPrompt);

    const repoBlock = await getTaskContextPrompt({ ...args, repoContext: sessionA.repoContext });
    const profile = await buildRequesterProfilePrompt(sessionA.requestedBy);
    expect(repoBlock).toContain("## Repository");
    expect(repoBlock).toContain("Alpha repo rules.");
    expect(profile).toContain("This task was requested by Taras (CTO).");

    expect(prompt).toStartWith(`${taskPrompt}\n\n`);
    expect(prompt).toContain(repoBlock);
    expect(prompt).toContain(profile);
    expect(prompt).toEndWith(sessionA.cwdWarning ?? "");
    expect(prompt.indexOf(repoBlock)).toBeLessThan(prompt.indexOf(profile));
    expect(prompt).not.toMatch(/\n{3,}/);
  });

  test("a task with no per-task context keeps its prompt unchanged", async () => {
    const { prompt } = await build(agentArgs("claude"), sessionC, "/work-on-task ccc");
    expect(prompt).toBe("/work-on-task ccc");
  });
});

describe("buildTaskSessionPrompts composition parts", () => {
  const promptParts = (kind: string) => kind === "task_prompt" || kind === "memories";
  const systemParts = (kind: string) => !promptParts(kind) && kind !== "skills_listing";

  test("parts cover the system prompt and the task prompt exactly", async () => {
    const memories = "\n\n### Relevant Past Knowledge\n\n- a memory";
    const result = await buildTaskSessionPrompts({
      basePromptArgs: agentArgs("claude"),
      additionalSystemPrompt: "Operator note: be careful.",
      taskPrompt: `/work-on-task aaa${memories}`,
      memoryChars: memories.length,
      context: sessionA,
    });
    const sum = (filter: (kind: string) => boolean) =>
      result.parts.filter((part) => filter(part.kind)).reduce((n, part) => n + part.chars, 0);

    expect(sum(systemParts)).toBe(result.systemPrompt.length);
    expect(sum(promptParts)).toBe(result.prompt.length);
    expect(result.parts.find((part) => part.kind === "operator_prompt")?.chars).toBe(
      "\n\nOperator note: be careful.".length,
    );
    expect(result.parts.find((part) => part.kind === "memories")?.chars).toBe(memories.length);
  });

  test("no operator or memories part when there are none", async () => {
    const result = await buildTaskSessionPrompts({
      basePromptArgs: agentArgs("codex"),
      taskPrompt: "task",
      context: sessionC,
    });
    const kinds = result.parts.map((part) => part.kind);
    expect(kinds).not.toContain("operator_prompt");
    expect(kinds).not.toContain("memories");
    expect(result.parts.at(-1)).toMatchObject({ kind: "task_prompt", chars: "task".length });
  });
});
