import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { AgentTask } from "@/api/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

let chain: AgentTask[] = [];
type Captured = Record<string, unknown>;
let composer: Captured | undefined;
let timeline: Captured | undefined;

mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true }),
}));
mock.module("@/api/hooks/use-sessions", () => ({
  useSession: () => ({
    data: { root: chain[0], chain, approvals: [] },
    isLoading: false,
    error: null,
  }),
  sessionErrorStatus: () => null,
}));
mock.module("@/api/hooks/use-stats", () => ({ useSteeringEnabled: () => ({ data: true }) }));
mock.module("@/hooks/use-auto-scroll", () => ({
  useAutoScroll: () => ({ isFollowing: true, scrollToBottom: () => {}, recheck: () => {} }),
}));
// The composer and the timeline have their own tests: the stubs record what
// the conversation hands them.
mock.module("@/components/shared/task-composer", () => ({
  TaskComposer: (props: Captured) => {
    composer = props;
    return null;
  },
}));
mock.module("@/components/sessions-v2/pane/turn-timeline", () => ({
  TurnTimeline: (props: Captured) => {
    timeline = props;
    return null;
  },
}));
mock.module("./session-timeline", () => ({ SessionTimeline: () => null }));
mock.module("./session-presence", () => ({
  useSessionPresenceContext: () => ({ viewers: [], setTyping: () => {} }),
}));
mock.module("./composer-dock", () => ({ ComposerReadOnlyNotice: () => null }));
mock.module("@/components/shared/empty-state", () => ({ EmptyState: () => null }));
mock.module("@/components/ui/button", () => ({ Button: () => null }));
mock.module("@/components/ui/skeleton", () => ({ Skeleton: () => null }));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/chat-width", () => require("../../lib/chat-width"));
mock.module("@/lib/session-presence", () => require("../../lib/session-presence"));
mock.module("@/lib/session-sharing", () => require("../../lib/session-sharing"));
mock.module("@/lib/task-steer", () => require("../../lib/task-steer"));

const { createRoot } = await import("react-dom/client");
const { SessionConversation } = await import("./session-conversation");

function task(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: "t",
    task: "do it",
    status: "completed",
    source: "api",
    tags: [],
    priority: 50,
    dependsOn: [],
    createdAt: "2026-11-05T00:00:00.000Z",
    lastUpdatedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  } as AgentTask;
}

beforeEach(() => {
  composer = undefined;
  timeline = undefined;
  // A lead root that finished, then a worker task that runs now.
  chain = [
    task({ id: "root", isLeadTask: true }),
    task({
      id: "worker",
      status: "in_progress",
      isLeadTask: false,
      parentTaskId: "root",
      createdAt: "2026-11-05T01:00:00.000Z",
    }),
  ];
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(node));
  await act(async () => root.unmount());
}

test("by default only a live lead task is steered: a running worker gets a follow-up", async () => {
  await render(<SessionConversation rootTaskId="root" timeline="turns" />);
  expect(composer).toMatchObject({ canSteer: false });
  expect((composer?.targetTask as AgentTask).id).toBe("worker");
  expect(composer?.steerSource).toBeUndefined();
  expect(composer?.onFollowUp).toBeUndefined();
  expect(composer?.value).toBeUndefined();
  expect(timeline?.requestText).toBeUndefined();
});

test("steerTarget any steers the running worker task", async () => {
  await render(<SessionConversation rootTaskId="root" timeline="turns" steerTarget="any" />);
  expect(composer).toMatchObject({ canSteer: true });
  expect((composer?.targetTask as AgentTask).id).toBe("worker");
});

test("the app's send contract reaches the composer and the timeline", async () => {
  const onFollowUp = async () => {};
  const requestText = () => null;
  const drafts: string[] = [];
  await render(
    <SessionConversation
      rootTaskId="root"
      timeline="turns"
      steerSource="app-page"
      onFollowUp={onFollowUp}
      requestText={requestText}
      value="draft"
      onValueChange={(next) => drafts.push(next)}
      placeholder="Ask…"
      routeLabel="Runs this page's action"
    />,
  );
  expect(composer).toMatchObject({
    steerSource: "app-page",
    onFollowUp,
    value: "draft",
    placeholder: "Ask…",
    routeLabel: "Runs this page's action",
  });
  expect(timeline?.requestText).toBe(requestText);
  // The caller hears every draft change, next to the typing report.
  (composer?.onValueChange as (next: string) => void)("typed");
  expect(drafts).toEqual(["typed"]);
});
