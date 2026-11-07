import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AgentTask, TaskAttachment } from "../../../api/types";

// The root-level test run cannot resolve ui's `@/` alias. Lib utils map to
// their real modules; the live activity, outcome and file chips are stubbed.
mock.module("@/lib/utils", () => require("../../../lib/utils"));
mock.module("@/lib/relative-time", () => require("../../../lib/relative-time"));
mock.module("@/lib/task-activity", () => require("../../../lib/task-activity"));
mock.module("@/components/sessions/chain-of-thought", () => ({
  ChainOfThought: () => <div data-slot="chain-of-thought" />,
}));
mock.module("@/components/sessions/task-outcome", () => ({
  TaskOutcome: () => null,
  outcomeCopyText: () => null,
}));
mock.module("@/components/shared/message-copy-button", () => ({
  MessageCopyButton: () => null,
  messageActionClass: () => "",
}));
mock.module("@/components/shared/relative-time", () => ({ RelativeTime: () => null }));
mock.module("@/components/shared/status-badge", () => ({ StatusBadge: () => null }));
mock.module("@/components/ui/button", () => ({
  Button: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
mock.module("@/components/shared/task-attachments-section", () => ({
  TaskPromptAttachments: ({
    attachments,
    from,
  }: {
    attachments?: TaskAttachment[];
    from?: string;
  }) => (
    <section data-from={from}>
      {attachments?.map((a) => (
        <span key={a.id}>{a.name}</span>
      ))}
    </section>
  ),
}));

const { SwarmReply } = await import("./swarm-reply");

const agentFile = {
  id: "a1",
  name: "report.md",
  intent: "deliverable",
  agentId: "agent-1",
} as unknown as TaskAttachment;

function render(status: AgentTask["status"]): string {
  const task = {
    id: "t1",
    task: "Write the report",
    status,
    createdAt: "2026-11-07T12:00:00.000Z",
    lastUpdatedAt: "2026-11-07T12:05:00.000Z",
    attachments: [agentFile],
  } as AgentTask;
  return renderToStaticMarkup(
    <MemoryRouter>
      <SwarmReply task={task} />
    </MemoryRouter>,
  );
}

describe("SwarmReply agent attachments", () => {
  // The person's bubble filters agent files out, so a reply still at work must show them.
  test.each([
    "in_progress",
    "pending",
  ] as const)("a %s reply shows the agent's files next to its live activity", (status) => {
    const html = render(status);
    expect(html).toContain('data-slot="chain-of-thought"');
    expect(html).toContain('data-from="agent"');
    expect(html).toContain("report.md");
  });

  test("a finished reply still shows the agent's files", () => {
    const html = render("completed");
    expect(html).toContain('data-slot="swarm-reply"');
    expect(html).toContain('data-from="agent"');
    expect(html).toContain("report.md");
  });
});
