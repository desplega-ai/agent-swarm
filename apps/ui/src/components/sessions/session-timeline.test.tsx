import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTask } from "../../api/types";

// The root-level test run cannot resolve ui's `@/` alias. Plain lib utils map
// to their real modules; the rows and avatars are stubbed so only the
// parent's closing chip copy is under test.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/task-activity", () => require("../../lib/task-activity"));
mock.module("@/lib/auto-review", () => require("../../lib/auto-review"));
mock.module("@/api/hooks/use-agents", () => ({
  useAgent: (id: string) => ({ data: id ? { id, name: "Lead" } : undefined }),
}));
mock.module("@/components/shared/agent-avatar", () => ({ AgentAvatar: () => null }));
mock.module("@/components/shared/empty-state", () => ({ EmptyState: () => null }));
mock.module("./task-card", () => ({ TaskCard: () => null, ParallelGroup: () => null }));
mock.module("./task-outcome", () => ({
  TaskOutcome: ({ task }: { task: AgentTask }) => <div>{task.failureReason ?? ""}</div>,
}));
mock.module("./user-prompt-bubble", () => ({ UserPromptBubble: () => null }));

const { SessionTimeline } = await import("./session-timeline");

function task(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: "root",
    agentId: "lead-1",
    task: "Coordinate the fix",
    status: "completed",
    source: "mcp",
    tags: [],
    priority: 0,
    dependsOn: [],
    createdAt: "2026-10-29T12:00:00.000Z",
    lastUpdatedAt: "2026-10-29T12:10:00.000Z",
    ...overrides,
  } as AgentTask;
}

function closingChip(rootStatus: AgentTask["status"]): string {
  const html = renderToStaticMarkup(
    <SessionTimeline
      rootTaskId="root"
      chain={[
        task({ status: rootStatus, failureReason: "Already handled." }),
        task({ id: "child", parentTaskId: "root", lastUpdatedAt: "2026-10-29T12:05:00.000Z" }),
      ]}
    />,
  );
  return html.match(/data-slot="parent-closing-chip"[\s\S]*$/)?.[0] ?? "";
}

describe("SessionTimeline parent closing chip", () => {
  test("a skipped parent says it skipped the fork, not that it was cancelled", () => {
    const chip = closingChip("skipped");
    expect(chip).toContain("skipped this fork");
    expect(chip).not.toContain("was cancelled");
  });

  test("a cancelled parent still says it was cancelled", () => {
    expect(closingChip("cancelled")).toContain("was cancelled");
  });
});
