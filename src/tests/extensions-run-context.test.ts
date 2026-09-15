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

  test("slack events carry the channel and no agent", () => {
    expect(runContext("pre.slack.route", { channelId: "C1", userId: "U1", text: "hello" })).toEqual(
      { agentId: null, subject: "channel C1: hello" },
    );
  });
});
