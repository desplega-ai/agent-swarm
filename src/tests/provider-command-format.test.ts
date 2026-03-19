import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../providers/claude-adapter";
import { createProviderAdapter } from "../providers/index";
import { PiMonoAdapter } from "../providers/pi-mono-adapter";

describe("ProviderAdapter.formatCommand", () => {
  const claude = new ClaudeAdapter();
  const pi = new PiMonoAdapter();

  test("claude formats commands with / prefix", () => {
    expect(claude.formatCommand("work-on-task")).toBe("/work-on-task");
    expect(claude.formatCommand("review-offered-task")).toBe("/review-offered-task");
    expect(claude.formatCommand("swarm-chat")).toBe("/swarm-chat");
  });

  test("pi formats commands with /skill: prefix", () => {
    expect(pi.formatCommand("work-on-task")).toBe("/skill:work-on-task");
    expect(pi.formatCommand("review-offered-task")).toBe("/skill:review-offered-task");
    expect(pi.formatCommand("swarm-chat")).toBe("/skill:swarm-chat");
  });

  test("adapter name matches expected provider", () => {
    expect(claude.name).toBe("claude");
    expect(pi.name).toBe("pi");
  });

  test("createProviderAdapter returns adapters that implement formatCommand", () => {
    const claudeAdapter = createProviderAdapter("claude");
    const piAdapter = createProviderAdapter("pi");
    expect(typeof claudeAdapter.formatCommand).toBe("function");
    expect(typeof piAdapter.formatCommand).toBe("function");
    expect(claudeAdapter.formatCommand("work-on-task")).toBe("/work-on-task");
    expect(piAdapter.formatCommand("work-on-task")).toBe("/skill:work-on-task");
  });
});

describe("regression: pi worker prompt must use /skill: prefix", () => {
  const pi = new PiMonoAdapter();
  const claude = new ClaudeAdapter();

  function simulateTaskAssignedPrompt(
    adapter: { formatCommand: (cmd: string) => string },
    taskId: string,
    taskDesc: string,
  ): string {
    let prompt = `${adapter.formatCommand("work-on-task")} ${taskId}`;
    prompt += `\n\nTask: "${taskDesc}"`;
    prompt += `\n\nWhen done, use \`store-progress\` with status: "completed" and include your output.`;
    return prompt;
  }

  function simulateTaskOfferedPrompt(
    adapter: { formatCommand: (cmd: string) => string },
    taskId: string,
    taskDesc: string,
  ): string {
    let prompt = `${adapter.formatCommand("review-offered-task")} ${taskId}`;
    prompt += `\n\nA task has been offered to you:\n"${taskDesc}"`;
    prompt += `\n\nAccept if you have capacity and skills. Reject with a reason if you cannot handle it.`;
    return prompt;
  }

  function simulateResumePrompt(
    adapter: { formatCommand: (cmd: string) => string },
    taskId: string,
  ): string {
    return `${adapter.formatCommand("work-on-task")} ${taskId}\n\n**RESUMED TASK**`;
  }

  test("pi task_assigned prompt starts with /skill:work-on-task", () => {
    const prompt = simulateTaskAssignedPrompt(pi, "abc-123", "Review the PR");
    expect(prompt).toStartWith("/skill:work-on-task abc-123");
    expect(prompt).not.toStartWith("/work-on-task abc-123");
  });

  test("pi task_offered prompt starts with /skill:review-offered-task", () => {
    const prompt = simulateTaskOfferedPrompt(pi, "def-456", "Check deployment");
    expect(prompt).toStartWith("/skill:review-offered-task def-456");
    expect(prompt).not.toStartWith("/review-offered-task def-456");
  });

  test("pi resume prompt starts with /skill:work-on-task", () => {
    const prompt = simulateResumePrompt(pi, "ghi-789");
    expect(prompt).toStartWith("/skill:work-on-task ghi-789");
  });

  test("claude task_assigned prompt starts with /work-on-task (no /skill:)", () => {
    const prompt = simulateTaskAssignedPrompt(claude, "abc-123", "Review the PR");
    expect(prompt).toStartWith("/work-on-task abc-123");
    expect(prompt).not.toContain("/skill:");
  });

  test("claude task_offered prompt starts with /review-offered-task (no /skill:)", () => {
    const prompt = simulateTaskOfferedPrompt(claude, "def-456", "Check deployment");
    expect(prompt).toStartWith("/review-offered-task def-456");
    expect(prompt).not.toContain("/skill:");
  });
});
