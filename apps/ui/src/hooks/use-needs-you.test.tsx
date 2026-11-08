import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The test runner cannot resolve ui's `@/` alias: each aliased module maps to a stub.
const calls: Record<string, unknown[]> = { approvals: [], sessions: [], credentials: [] };
mock.module("@/api/hooks/use-approval-requests", () => ({
  useApprovalRequestSummaries: (...args: unknown[]) => {
    calls.approvals?.push(args);
    return {};
  },
}));
mock.module("@/api/hooks/use-sessions", () => ({
  useSessions: (...args: unknown[]) => {
    calls.sessions?.push(args);
    return {};
  },
}));
mock.module("@/api/hooks/use-credential-missing-agents", () => ({
  useCredentialMissingAgents: (...args: unknown[]) => {
    calls.credentials?.push(args);
    return {};
  },
}));
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true }),
}));
mock.module("@/lib/needs-you", () => require("../lib/needs-you"));
mock.module("@/lib/sessions-v2", () => require("../lib/sessions-v2"));

const { useNeedsYou } = await import("./use-needs-you");

function Probe(props: { refetchInterval?: number }) {
  useNeedsYou(props);
  return null;
}

describe("useNeedsYou", () => {
  test("a caller's refetchInterval reaches all three reads", () => {
    renderToStaticMarkup(<Probe refetchInterval={30_000} />);
    expect(calls.approvals?.at(-1)).toEqual([
      { status: "pending" },
      { enabled: true, refetchInterval: 30_000 },
    ]);
    expect((calls.sessions?.at(-1) as unknown[])[1]).toEqual({ refetchInterval: 30_000 });
    expect(calls.credentials?.at(-1)).toEqual([{ enabled: true, refetchInterval: 30_000 }]);
  });

  test("without one, each read keeps its own poll", () => {
    renderToStaticMarkup(<Probe />);
    expect(calls.approvals?.at(-1)).toEqual([
      { status: "pending" },
      { enabled: true, refetchInterval: undefined },
    ]);
    expect((calls.sessions?.at(-1) as unknown[])[1]).toEqual({ refetchInterval: undefined });
  });
});
