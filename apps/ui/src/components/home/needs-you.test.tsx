import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type {
  AgentTask,
  ApprovalRequestSummary,
  CredentialMissingAgent,
  SessionListItem,
} from "../../api/types";
import type { NeedsYouViewProps } from "./needs-you";
import type { SectionQuery } from "./section-state";

// The test runner resolves `@/` to the API's src/, so each aliased module in
// the view's graph maps to its real ui file. The container's hooks are never
// called by the view, so they are stubs.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/approval-format", () => require("../../lib/approval-format"));
mock.module("@/lib/needs-you", () => require("../../lib/needs-you"));
mock.module("@/lib/recent-failures", () => require("../../lib/recent-failures"));
mock.module("@/lib/session-groups", () => require("../../lib/session-groups"));
mock.module("@/lib/task-title", () => require("../../lib/task-title"));
mock.module("@/components/shared/task-status-icon", () => require("../shared/task-status-icon"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/skeleton", () => require("../ui/skeleton"));
mock.module("@/api/hooks/use-agents", () => ({ useAgents: () => ({}) }));
mock.module("@/api/hooks/use-session-tree", () => ({
  useSessionLabels: () => ({}),
  useSessionTree: () => ({}),
}));
mock.module("@/api/hooks/use-tasks", () => ({ useTasks: () => ({}) }));
mock.module("@/contexts/current-user-context", () => ({ useCurrentUser: () => ({}) }));
mock.module("@/hooks/use-needs-you", () => ({ useNeedsYou: () => ({}) }));
mock.module("@/hooks/use-minute-clock", () => ({ useMinuteClock: () => 0 }));

const { NeedsYouView } = await import("./needs-you");
const { needsYouCount, needsYouItems } = await import("../../lib/needs-you");

const NOW = Date.parse("2026-11-04T12:00:00Z");

function ok<T>(data: T): SectionQuery<T> {
  return { data, isLoading: false, isError: false, errorUpdateCount: 0, refetch: () => {} };
}
function failedRead<T>(): SectionQuery<T> {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    errorUpdateCount: 1,
    refetch: () => {},
  };
}

const approval = {
  id: "ap1",
  title: "Post the digest to #market-intel",
  sourceTaskId: "root-1",
  workflowRunId: null,
  questionCount: 1,
  approvalProgress: null,
  createdAt: "2026-11-04T11:00:00Z",
} as ApprovalRequestSummary;

const approvalSession: SessionListItem = {
  root: { id: "root-1", task: "Run the competitor scan" } as AgentTask,
  chainTaskCount: 2,
  lastActivityAt: "2026-11-04T11:30:00Z",
  latestStatus: "in_progress",
  readState: "read",
  needsYou: true,
  groupKey: "shared/po-qa/",
};

const failedTask = {
  id: "t-failed",
  task: "Scrape the pricing page",
  status: "failed",
  agentId: "agent-1",
  createdAt: "2026-11-04T10:00:00Z",
  lastUpdatedAt: "2026-11-04T11:00:00Z",
  finishedAt: "2026-11-04T11:00:00Z",
} as AgentTask;

function render(input: {
  approvals?: ApprovalRequestSummary[];
  sessions?: SessionListItem[];
  credentials?: CredentialMissingAgent[];
  failed?: AgentTask[];
  overrides?: Partial<NeedsYouViewProps>;
}) {
  const items = needsYouItems({
    approvals: input.approvals ?? [],
    sessions: input.sessions ?? [],
    credentials: input.credentials ?? [],
  });
  const props: NeedsYouViewProps = {
    items,
    count: needsYouCount(items),
    approvals: ok(input.approvals ?? []),
    sessions: ok(input.sessions ?? []),
    credentials: ok(input.credentials ?? []),
    failed: ok({ tasks: input.failed ?? [] }),
    agentName: () => "Researcher",
    groupName: (key) => (key ? "po-qa" : "No group"),
    now: NOW,
    ...input.overrides,
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <NeedsYouView {...props} />
    </MemoryRouter>,
  );
}

describe("NeedsYouView", () => {
  test("an approval and its session show once, the failure below, the count is 1", () => {
    const html = render({
      approvals: [approval],
      sessions: [approvalSession],
      failed: [failedTask],
    });
    expect(html.match(/Post the digest to #market-intel/g)?.length).toBe(1);
    expect(html).not.toContain("Run the competitor scan");
    expect(html).toContain('href="/approval-requests/ap1"');
    expect(html).toContain("1 item needs you");
    expect(html).toContain("Failed in the last 24h");
    expect(html).toContain("Scrape the pricing page");
    expect(html).toContain('href="/tasks/t-failed"');
  });

  test("an agent blocked on credentials links to the agent", () => {
    const html = render({
      credentials: [
        {
          agentId: "agent-2",
          name: "Coder",
          missing: ["GITHUB_TOKEN"],
          credStatus: null,
        } as unknown as CredentialMissingAgent,
      ],
    });
    expect(html).toContain("Coder is blocked on credentials");
    expect(html).toContain("Missing GITHUB_TOKEN");
    expect(html).toContain('href="/agents/agent-2"');
    expect(html).toContain("No failed runs in the last 24h.");
  });

  test("nothing at all reads as all clear", () => {
    const html = render({});
    expect(html).toContain("Nothing needs you.");
    expect(html).toContain("No blocked agents and no failed runs in the last 24h.");
    expect(html).not.toContain("needs you</span>");
  });

  test("a failed read is never an all clear", () => {
    const html = render({ overrides: { approvals: failedRead() } });
    expect(html).toContain("Couldn&#x27;t load approvals");
    expect(html).not.toContain("Nothing needs you.");
  });
});
