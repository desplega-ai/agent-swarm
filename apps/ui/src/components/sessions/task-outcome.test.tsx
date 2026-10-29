import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTask } from "../../api/types";

// The root-level test run cannot resolve ui's `@/` alias. Plain lib utils map
// to their real modules; the Copy button's UI primitives are stubbed.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/json-output", () => require("../../lib/json-output"));
mock.module("@/lib/task-reason", () => require("../../lib/task-reason"));
mock.module("@/hooks/use-copy-to-clipboard", () => require("../../hooks/use-copy-to-clipboard"));
mock.module("@/components/shared/inline-identifier-code", () => ({
  InlineIdentifierCode: ({ children }: { children?: ReactNode }) => <code>{children}</code>,
}));
mock.module("@/components/shared/json-tree", () => ({ JsonTree: () => null }));
mock.module("@/components/ui/button", () => ({
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const { TaskOutcome } = await import("./task-outcome");
const { taskReason } = await import("../../lib/task-reason");

function task(overrides: Partial<AgentTask>): AgentTask {
  return { id: "t1", task: "Answer the thread", status: "completed", ...overrides } as AgentTask;
}

describe("taskReason", () => {
  test("a skipped task's reason is labeled Skipped in the neutral tone", () => {
    expect(taskReason(task({ status: "skipped", failureReason: "  Not for me.  " }))).toEqual({
      label: "Skipped",
      text: "Not for me.",
      tone: "neutral",
    });
  });

  test("failed and cancelled keep the error tone", () => {
    expect(taskReason(task({ status: "failed", failureReason: "boom" }))).toMatchObject({
      label: "Failure",
      tone: "error",
    });
    expect(taskReason(task({ status: "cancelled", failureReason: "stop" }))).toMatchObject({
      label: "Cancelled",
      tone: "error",
    });
  });

  test("no reason without a terminal status or a non-blank text", () => {
    expect(taskReason(task({ status: "skipped", failureReason: "   " }))).toBeNull();
    expect(taskReason(task({ status: "skipped" }))).toBeNull();
    expect(taskReason(task({ status: "completed", failureReason: "stale" }))).toBeNull();
  });
});

describe("TaskOutcome", () => {
  test("a skipped task shows its reason under Skipped, not in the error tone", () => {
    const html = renderToStaticMarkup(
      <TaskOutcome task={task({ status: "skipped", failureReason: "Someone else answered." })} />,
    );
    expect(html).toContain("Skipped");
    expect(html).toContain("Someone else answered.");
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("status-error");
  });

  test("a failed task keeps the error frame", () => {
    const html = renderToStaticMarkup(
      <TaskOutcome task={task({ status: "failed", failureReason: "boom" })} />,
    );
    expect(html).toContain("Failure");
    expect(html).toContain("text-status-error-strong");
  });
});
