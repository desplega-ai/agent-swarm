import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AgentTask, SessionListItem, SessionTreeResponse } from "../../api/types";
import type { InProgressViewProps } from "./in-progress";

// `@/` resolves to the API's src/ under the test runner: map each ui module.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/in-progress", () => require("../../lib/in-progress"));
mock.module("@/lib/session-groups", () => require("../../lib/session-groups"));
mock.module("@/lib/sessions-v2", () => ({ SESSIONS_V2_MIN_VERSION: "2.5.1" }));
mock.module("@/lib/task-title", () => require("../../lib/task-title"));
mock.module("@/components/shared/task-status-icon", () => require("../shared/task-status-icon"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/skeleton", () => require("../ui/skeleton"));
mock.module("@/api/hooks/use-agents", () => ({ useAgents: () => ({}) }));
mock.module("@/api/hooks/use-favorites", () => ({ useFavorites: () => ({}) }));
mock.module("@/api/hooks/use-feature-gate", () => ({ useFeatureGate: () => ({}) }));
mock.module("@/api/hooks/use-sessions", () => ({ useSessions: () => ({}) }));
mock.module("@/api/hooks/use-session-tree", () => ({
  useSessionLabels: () => ({}),
  useSessionTree: () => ({}),
}));
mock.module("@/contexts/current-user-context", () => ({ useCurrentUser: () => ({}) }));

const { InProgressView } = await import("./in-progress");

const counts = (running: number) => ({ total: running, unread: 0, running, needsYou: 0 });
const tree: SessionTreeResponse = {
  groups: [{ key: "shared/po-qa/", ...counts(1), lastActivityAt: "2026-11-04T10:00:00Z" }],
  inbox: counts(0),
  later: counts(0),
  done: counts(0),
  noGroup: counts(1),
};

const session = (id: string, task: string, groupKey?: string): SessionListItem => ({
  root: { id, task, agentId: "agent-1", createdAt: "2026-11-04T10:00:00Z" } as AgentTask,
  chainTaskCount: 1,
  lastActivityAt: "2026-11-04T10:00:00Z",
  latestStatus: "in_progress",
  groupKey,
});

function render(overrides: Partial<InProgressViewProps>) {
  const props: InProgressViewProps = {
    tree: { data: tree, isLoading: false, isError: false, errorUpdateCount: 0, refetch: () => {} },
    running: [
      session("s1", "Competitor scan run", "shared/po-qa/"),
      session("s2", "Fix flaky e2e"),
    ],
    starred: [],
    me: "u1",
    agentName: () => "Researcher",
    ...overrides,
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <InProgressView {...props} />
    </MemoryRouter>,
  );
}

test("a running group reads 'po-qa · 1 running' and links to its view, No group last", () => {
  const html = render({});
  expect(html).toContain("2 running");
  expect(html).toContain('aria-label="po-qa, 1 running"');
  expect(html).toContain('href="/sessions?view=shared%2Fpo-qa%2F"');
  expect(html).toContain("Competitor scan run");
  expect(html).toContain('href="/sessions/s1"');
  expect(html.indexOf("po-qa")).toBeLessThan(html.indexOf("No group"));
  expect(html).toContain('href="/sessions?view=nogroup"');
});

test("nothing running", () => {
  const empty = { ...tree, groups: [], noGroup: counts(0) };
  const html = render({
    tree: { data: empty, isLoading: false, isError: false, errorUpdateCount: 0, refetch: () => {} },
    running: [],
  });
  expect(html).toContain("Nothing running.");
});

test("a failed tree read is not 'Nothing running'", () => {
  const html = render({
    tree: {
      data: undefined,
      isLoading: false,
      isError: true,
      errorUpdateCount: 1,
      refetch: () => {},
    },
  });
  expect(html).toContain("Couldn&#x27;t load running sessions");
  expect(html).not.toContain("Nothing running.");
});
