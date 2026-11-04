import { describe, expect, test } from "bun:test";
import {
  buildChecklistNudgePrompt,
  buildRequesterProfilePrompt,
  buildTaskSessionPrompts,
  buildUseCasePrompt,
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
  checklistNudge: {
    itemId: "swarm:channel",
    kind: "channel",
    label: "Connect a chat channel",
    href: "https://swarm.example.com/integrations/channels",
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
      for (const perTask of [
        "## Repository",
        "## Requester Profile",
        "## Setup suggestion",
        "has not finished setting up",
        "Connect a chat channel",
        "Taras",
        "Eze",
        "/nope",
      ]) {
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
    const nudge = await buildChecklistNudgePrompt(sessionA.checklistNudge);
    expect(repoBlock).toContain("## Repository");
    expect(repoBlock).toContain("Alpha repo rules.");
    expect(profile).toContain("This task was requested by Taras (CTO).");

    expect(prompt).toStartWith(`${taskPrompt}\n\n`);
    expect(prompt).toContain(repoBlock);
    expect(prompt).toContain(profile);
    expect(prompt).toEndWith(sessionA.cwdWarning ?? "");
    expect(prompt.indexOf(repoBlock)).toBeLessThan(prompt.indexOf(profile));
    expect(prompt.indexOf(profile)).toBeLessThan(prompt.indexOf(nudge));
    expect(prompt).not.toMatch(/\n{3,}/);
  });

  test("a task with no per-task context keeps its prompt unchanged", async () => {
    const { prompt } = await build(agentArgs("claude"), sessionC, "/work-on-task ccc");
    expect(prompt).toBe("/work-on-task ccc");
  });

  test("a lead task with a checklist nudge carries it once, in the task prompt only", async () => {
    const lead = agentArgs("claude", { role: "lead" });
    const withNudge = await build(lead, sessionA, "/work-on-task aaa");
    const withoutNudge = await build(
      lead,
      { ...sessionA, checklistNudge: undefined },
      "/work-on-task aaa",
    );
    const nudge = await buildChecklistNudgePrompt(sessionA.checklistNudge);

    expect(nudge).toContain("## Setup suggestion");
    expect(nudge).toContain("Open item: Connect a chat channel.");
    expect(nudge).toContain("https://swarm.example.com/integrations/channels");
    expect(withNudge.systemPrompt).toBe(withoutNudge.systemPrompt);
    expect(withNudge.systemPrompt).not.toContain("has not finished setting up");
    expect(withNudge.prompt.split("has not finished setting up").length - 1).toBe(1);
    expect(withoutNudge.prompt).not.toContain("has not finished setting up");
    // The static pointer for missing tools lives in the lead contract instead.
    expect(withNudge.systemPrompt).toContain("/integrations/tools");
  });

  test("no nudge renders nothing", async () => {
    expect(await buildChecklistNudgePrompt(undefined)).toBe("");
  });

  test("a lead task in a use-case group carries the key once, in the task prompt only", async () => {
    const lead = agentArgs("claude", { role: "lead" });
    const inGroup = await build(
      lead,
      { ...sessionA, taskKey: "shared/competitor-watch/" },
      "/work-on-task aaa",
    );
    const inInbox = await build(
      lead,
      { ...sessionA, taskKey: "shared/task:aaa/" },
      "/work-on-task aaa",
    );

    expect(inGroup.systemPrompt).toBe(inInbox.systemPrompt);
    expect(inGroup.systemPrompt).not.toContain("shared/competitor-watch/");
    expect(inGroup.systemPrompt).not.toContain("## Use case\n");
    expect(inGroup.prompt.split("## Use case\n").length - 1).toBe(1);
    expect(inGroup.prompt).toContain(
      "This task is in the use case with key `shared/competitor-watch/`.",
    );
    expect(inInbox.prompt).not.toContain("## Use case\n");
    // The use-case paragraph and its link base stay in the system prompt, once.
    expect(inGroup.systemPrompt.split("A use case is work that repeats").length - 1).toBe(1);
    expect(inGroup.prompt).not.toContain("A use case is work that repeats");
  });

  test("the use-case note needs a lead and a user group key", async () => {
    expect(await buildUseCasePrompt("lead", "shared/acme/")).toContain("`shared/acme/`");
    expect(await buildUseCasePrompt("lead", "personal/u1/acme/")).toContain("`personal/u1/acme/`");
    expect(await buildUseCasePrompt("worker", "shared/acme/")).toBe("");
    expect(await buildUseCasePrompt("lead", undefined)).toBe("");
    expect(await buildUseCasePrompt("lead", "shared/")).toBe("");
    expect(await buildUseCasePrompt("lead", "shared/task:abc/")).toBe("");
    expect(await buildUseCasePrompt("lead", "shared/schedule:abc/")).toBe("");
    expect(await buildUseCasePrompt("lead", "shared/slack/C123/thread:1.2/")).toBe("");
  });
});
