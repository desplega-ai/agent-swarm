import { describe, expect, test } from "bun:test";
import { runContext } from "@/extensions/dispatcher";

describe("runContext", () => {
  test("tool events record the calling agent and the tool name", () => {
    expect(
      runContext("pre.tool.call", {
        tool: "store-progress",
        args: { status: "completed" },
        requestInfo: { agentId: "agent-1", callOrigin: "mcp" },
      }),
    ).toEqual({ agentId: "agent-1", subject: "tool store-progress" });
  });

  test("task creation records origin and a short description", () => {
    const context = runContext("pre.task.create", {
      origin: "rest",
      description: `token=sk-ant-${"a".repeat(40)} ${"x".repeat(200)}`,
      options: { agentId: "pinned-agent" },
    });
    expect(context.agentId).toBe("pinned-agent");
    expect(context.subject?.startsWith("rest: ")).toBe(true);
    expect(context.subject?.length).toBeLessThan(100);
    expect(context.subject?.includes("sk-ant-")).toBe(false);
  });

  test("post task events record the task's agent", () => {
    expect(
      runContext("post.task.completed", {
        task: { id: "task-1", agentId: "agent-2", task: "Do the thing" },
        output: "done",
      }),
    ).toEqual({ agentId: "agent-2", subject: "task task-1: Do the thing" });
  });

  test("an approval records its request id and status", () => {
    expect(
      runContext("post.approval.resolved", {
        requestId: "req-1",
        status: "approved",
        responses: null,
      }),
    ).toEqual({ agentId: null, subject: "approval req-1: approved" });
  });

  test("a budget refusal records the refused agent and the cause", () => {
    expect(
      runContext("post.task.budgetRefused", {
        task: { id: "task-1", agentId: "agent-2", task: "Do the thing" },
        agentId: "agent-3",
        cause: "global",
        resetAt: "2026-10-06T00:00:00.000Z",
      }),
    ).toEqual({ agentId: "agent-3", subject: "task task-1: global budget" });
  });

  test("email and WhatsApp events record ids, never the message content", () => {
    expect(
      runContext("post.email.received", {
        inboxId: "inbox-1",
        from: "ada@example.com",
        subject: "Salary review",
        body: "private",
        threadId: "thread-1",
        messageId: "message-1",
      }),
    ).toEqual({ agentId: null, subject: "inbox inbox-1: thread thread-1" });
    expect(
      runContext("post.kapso.message", {
        phoneNumberId: "pn-1",
        messageId: "wamid-1",
        text: "private",
      }),
    ).toEqual({ agentId: null, subject: "number pn-1: message wamid-1" });
  });

  test("a code-host event records provider, kind, action, and repo with its number", () => {
    expect(
      runContext("post.vcs.event", {
        provider: "github",
        kind: "pull_request",
        action: "opened",
        repo: "acme/api",
        number: 7,
      }),
    ).toEqual({ agentId: null, subject: "github pull_request.opened: acme/api#7" });
    expect(
      runContext("post.vcs.event", {
        provider: "gitlab",
        kind: "pipeline",
        action: "failed",
        repo: "acme/api",
      }),
    ).toEqual({ agentId: null, subject: "gitlab pipeline.failed: acme/api" });
  });

  test("slack events carry the channel and no agent", () => {
    expect(runContext("pre.slack.route", { channelId: "C1", userId: "U1", text: "hello" })).toEqual(
      { agentId: null, subject: "channel C1: hello" },
    );
  });
});
