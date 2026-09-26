import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AgentTask } from "../../api/types";
import type { MobileNowViewProps, SectionQuery } from "./mobile-now";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this component's graph maps to its real file.
mock.module("@/api/hooks/use-agents", () => import("../../api/hooks/use-agents"));
mock.module(
  "@/api/hooks/use-approval-requests",
  () => import("../../api/hooks/use-approval-requests"),
);
mock.module("@/api/hooks/use-tasks", () => import("../../api/hooks/use-tasks"));
mock.module("@/components/shared/mobile-list", () => import("../shared/mobile-list"));
mock.module("@/components/shared/status-badge", () => import("../shared/status-badge"));
mock.module("@/components/ui/badge", () => import("../ui/badge"));
mock.module("@/components/ui/button", () => import("../ui/button"));
mock.module("@/components/ui/skeleton", () => import("../ui/skeleton"));
mock.module("@/lib/config", () => import("../../lib/config"));
mock.module("@/lib/recent-failures", () => import("../../lib/recent-failures"));
mock.module("@/lib/task-title", () => import("../../lib/task-title"));
mock.module("@/lib/utils", () => import("../../lib/utils"));

const { MobileNowView } = await import("./mobile-now");

const NOW = Date.parse("2026-09-26T12:00:00Z");

function ok<T>(data: T): SectionQuery<T> {
  return { data, isLoading: false, isError: false, errorUpdateCount: 0, refetch: () => {} };
}
function failedRead<T>(data?: T): SectionQuery<T> {
  return { data, isLoading: false, isError: true, errorUpdateCount: 1, refetch: () => {} };
}

const runningTask = {
  id: "t-run",
  task: "Ship the mobile home",
  status: "in_progress",
  agentId: null,
  createdAt: "2026-09-26T11:00:00Z",
  lastUpdatedAt: "2026-09-26T11:30:00Z",
} as AgentTask;

function render(overrides: Partial<MobileNowViewProps>) {
  const props: MobileNowViewProps = {
    approvals: ok([]),
    running: ok({ tasks: [], total: 0 }),
    queuedCount: 0,
    failed: ok({ tasks: [], total: 0 }),
    agentName: () => "Picateclas",
    now: NOW,
    ...overrides,
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <MobileNowView {...props} />
    </MemoryRouter>,
  );
}

describe("MobileNowView", () => {
  test("failed reads never render as an empty, healthy swarm", () => {
    const html = render({
      approvals: failedRead(),
      running: failedRead(),
      failed: failedRead(),
    });
    expect(html).toContain("Couldn&#x27;t load approvals");
    expect(html).toContain("Couldn&#x27;t load running tasks");
    expect(html).toContain("Couldn&#x27;t load failed tasks");
    expect(html).not.toContain("No pending approvals");
    expect(html).not.toContain("Nothing running");
    expect(html).not.toContain("No failures in the last 24 hours");
  });

  test("a retry after a failed first read stays unavailable, not a skeleton", () => {
    const retrying: SectionQuery<{ tasks: AgentTask[]; total: number }> = {
      data: undefined,
      isLoading: true,
      isError: false,
      errorUpdateCount: 2,
      refetch: () => {},
    };
    const html = render({ running: retrying });
    expect(html).toContain("Couldn&#x27;t load running tasks");
  });

  test("a failed refresh over cached data keeps the rows and flags them stale", () => {
    const html = render({ running: failedRead({ tasks: [runningTask], total: 1 }) });
    expect(html).toContain("Ship the mobile home");
    expect(html).toContain("Refresh failed. Showing earlier data.");
  });

  test("approvals are worded team-wide, not as waiting on the viewer", () => {
    const html = render({ approvals: ok([{}, {}]) });
    expect(html).toContain("2 pending approvals");
    expect(html).not.toContain("waiting on you");
  });

  test("the empty states still render when every read succeeded", () => {
    const html = render({});
    expect(html).toContain("No pending approvals");
    expect(html).toContain("Nothing running");
    expect(html).toContain("No failures in the last 24 hours");
  });
});
