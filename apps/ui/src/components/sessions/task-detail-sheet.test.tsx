import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTask } from "../../api/types";

const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("react-router-dom", () => ({ Link: passthrough, useNavigate: () => () => {} }));
mock.module("@/api/hooks/use-costs", () => ({ useSessionCosts: () => ({ data: [] }) }));
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true }),
}));
mock.module("@/api/hooks/use-stats", () => ({ useSteeringEnabled: () => ({ data: true }) }));
mock.module("@/api/hooks/use-tasks", () => ({
  useTaskSessionLogs: () => ({ data: [] }),
  useTaskSteeringMessages: () => ({ data: [] }),
}));
mock.module("@/components/shared/agent-link", () => ({ AgentLink: () => null }));
mock.module("@/components/shared/json-tree", () => ({ JsonTree: () => <div>JSON outcome</div> }));
mock.module("@/components/shared/show-more", () => ({ ShowMore: passthrough }));
mock.module("@/components/shared/status-badge", () => ({ StatusBadge: () => null }));
mock.module("@/components/shared/task-attachments-section", () => ({
  TaskAttachmentsSection: () => null,
}));
mock.module("@/components/shared/task-ui-spec-view", () => ({
  TaskUiSpecView: ({ task }: { task: AgentTask }) => <div>Card for {task.id}</div>,
}));
mock.module("@/components/shared/transcript/task-transcript", () => ({
  TaskTranscript: () => null,
}));
mock.module("@/components/shared/transcript/transcript-rows", () => ({
  buildTranscriptRows: () => [],
}));
mock.module("@/components/ui/button", () => ({ Button: passthrough }));
mock.module("@/components/ui/sheet", () => ({
  Sheet: passthrough,
  SheetContent: passthrough,
  SheetDescription: passthrough,
  SheetHeader: passthrough,
  SheetTitle: passthrough,
}));
mock.module("@/components/ui/skeleton", () => ({ Skeleton: () => null }));
mock.module("@/lib/json-output", () => require("../../lib/json-output"));
mock.module("@/lib/task-reason", () => require("../../lib/task-reason"));
mock.module("@/lib/task-title", () => ({ taskListTitle: () => "Task" }));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/logs-parser", () => ({ parseSessionLogs: () => [] }));

const { TaskDetailSheet } = await import("./task-detail-sheet");

function render(output: string, withCard: boolean) {
  const task = {
    id: "parent",
    status: "completed",
    output,
    uiSpec: withCard ? { spec: { root: "card", elements: {} } } : undefined,
  } as AgentTask;
  return renderToStaticMarkup(
    <TaskDetailSheet taskId={task.id} task={task} open onOpenChange={() => {}} />,
  );
}

describe("TaskDetailSheet rich outcome", () => {
  test.each(["Prose outcome", '{"answer":42}'])("renders the card below %s", (output) => {
    const html = render(output, true);
    const outcomeText = output.startsWith("{") ? "JSON outcome" : output;
    expect(html).toContain(outcomeText);
    expect(html).toContain("Card for parent");
    expect(html.indexOf("Card for parent")).toBeGreaterThan(html.indexOf(outcomeText));
  });

  test("an outcome without uiSpec has no card", () => {
    expect(render("Prose outcome", false)).not.toContain("Card for parent");
  });
});
