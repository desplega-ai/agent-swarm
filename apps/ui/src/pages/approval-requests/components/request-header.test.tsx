import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalRequest } from "../../../api/types";

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file.
mock.module(
  "@/components/shared/status-badge",
  () => import("../../../components/shared/status-badge"),
);
mock.module(
  "@/components/shared/status-icon",
  () => import("../../../components/shared/status-icon"),
);
mock.module("@/components/shared/user-chip", () => import("../../../components/shared/user-chip"));
mock.module("@/components/ui/tooltip", () => import("../../../components/ui/tooltip"));
mock.module("@/hooks/use-user-name", () => import("../../../hooks/use-user-name"));
mock.module("@/hooks/use-copy-to-clipboard", () => import("../../../hooks/use-copy-to-clipboard"));
mock.module("@/lib/approval-format", () => import("../../../lib/approval-format"));
mock.module("@/lib/utils", () => import("../../../lib/utils"));

mock.module("@/api/hooks/use-users", () => import("../../../api/hooks/use-users"));
mock.module("@/components/ui/badge", () => import("../../../components/ui/badge"));
mock.module("@/components/ui/dialog", () => import("../../../components/ui/dialog"));
mock.module("@/components/ui/kbd", () => import("../../../components/ui/kbd"));
mock.module("@/lib/approval-shortcuts", () => import("../../../lib/approval-shortcuts"));
mock.module("@/components/ui/button", () => import("../../../components/ui/button"));
mock.module("@/lib/config", () => import("../../../lib/config"));
const { ResolutionBanner } = await import("./request-header");

function request(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Deploy",
    questions: [],
    workflowRunId: null,
    workflowRunStepId: null,
    sourceTaskId: null,
    approvers: { policy: "any" },
    status: "pending",
    responses: null,
    resolvedBy: null,
    resolvedAt: "2026-09-28T10:00:00.000Z",
    resolutionReason: null,
    timeoutSeconds: null,
    expiresAt: null,
    notificationChannels: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
    ...overrides,
  } as ApprovalRequest;
}

describe("ResolutionBanner", () => {
  test("an auto-cancelled request shows Cancelled and the sweep reason", () => {
    const html = renderToStaticMarkup(
      <ResolutionBanner
        request={request({
          status: "cancelled",
          resolutionReason: "Auto-cancelled by the approval sweep after 7 days with no response",
        })}
        resolvedBy={null}
      />,
    );
    expect(html).toContain("Cancelled");
    expect(html).toContain("Auto-cancelled by the approval sweep after 7 days with no response");
  });

  test("a timed-out request shows Timed out, the window, and the sweep reason", () => {
    const html = renderToStaticMarkup(
      <ResolutionBanner
        request={request({
          status: "timeout",
          timeoutSeconds: 3600,
          resolutionReason:
            "Timed out by the approval sweep: no answer before 2026-09-28T00:00:00.000Z",
        })}
        resolvedBy={null}
      />,
    );
    expect(html).toContain("Timed out");
    expect(html).toContain("No answer within 1 hour");
    expect(html).toContain(
      "Timed out by the approval sweep: no answer before 2026-09-28T00:00:00.000Z",
    );
  });
});
