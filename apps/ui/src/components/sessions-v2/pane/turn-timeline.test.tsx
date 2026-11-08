import { expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTask, SessionApproval } from "../../../api/types";

// Resolve the UI alias for the real turn model; stub child views and data hooks.
mock.module("@/lib/utils", () => require("../../../lib/utils"));
mock.module("@/lib/session-turns", () => require("../../../lib/session-turns"));
mock.module("@/lib/task-activity", () => require("../../../lib/task-activity"));
mock.module("@/lib/agent-name", () => ({ agentName: () => "Lead" }));
mock.module("@/lib/chat-width", () => ({ CHAT_COLUMN: "" }));
mock.module("@/api/hooks/use-agents", () => ({ useAgents: () => ({ data: [] }) }));
mock.module("@/components/sessions/task-card", () => ({ TaskCard: () => null }));
mock.module("@/components/shared/empty-state", () => ({ EmptyState: () => null }));
mock.module("@/components/shared/user-avatar", () => ({ UserAvatar: () => null }));
mock.module("@/components/shared/animated-reveal", () => ({
  AnimatedReveal: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
mock.module("./use-step-blocks", () => ({
  useStepBlocks: () => ({ isOpen: () => false, toggle: () => {} }),
}));
mock.module("./person-bubble", () => ({ PersonBubble: () => null }));
mock.module("./internal-line", () => ({ InternalLine: () => null }));
mock.module("./deferral-line", () => ({ DeferralLine: () => null, DeferralGroup: () => null }));
mock.module("./worker-step", () => ({ WorkerStep: () => <div>Worker step</div> }));
mock.module("./worker-summary", () => ({ WorkerSummaryLine: () => null }));
mock.module("./swarm-reply", () => ({
  SwarmReply: ({ task }: { task: AgentTask }) => <div>{task.output ?? "Working"}</div>,
}));
mock.module("./approval-line", () => ({
  ApprovalLine: ({ approval }: { approval: SessionApproval }) => (
    <section>{approval.title}</section>
  ),
}));

const { TurnTimeline } = await import("./turn-timeline");

function task(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    agentId: "lead",
    task: "Answer the request",
    source: "system",
    status: "completed",
    createdAt: "2026-11-07T12:00:00.000Z",
    ...overrides,
  } as AgentTask;
}

test("a part places approvals after its answer and steps, before its live line", () => {
  const root = task("root", { source: "ui", output: "Initial answer" });
  const chain = [
    root,
    task("worker", { parentTaskId: root.id, agentId: "worker", source: "mcp" }),
    task("result", {
      parentTaskId: root.id,
      createdAt: "2026-11-07T12:01:00.000Z",
      output: "Latest answer",
    }),
    task("live", {
      parentTaskId: root.id,
      createdAt: "2026-11-07T12:02:00.000Z",
      status: "in_progress",
    }),
  ];
  const approvals = [
    { id: "approval", sourceTaskId: "result", title: "Questions" },
    { id: "fallback", sourceTaskId: "missing", title: "Unmatched approval" },
  ] as SessionApproval[];
  const html = renderToStaticMarkup(
    <TurnTimeline
      rootTaskId={root.id}
      chain={chain}
      approvals={approvals}
      showHandoffs={false}
      typing={[]}
    />,
  );
  const labels = [
    "Initial answer",
    "Worker step",
    "Latest answer",
    "Questions",
    "Working",
    "Unmatched approval",
  ];
  for (const label of labels) expect(html).toContain(label);
  for (let i = 1; i < labels.length; i++) {
    expect(html.indexOf(labels[i - 1])).toBeLessThan(html.indexOf(labels[i]));
  }
});
