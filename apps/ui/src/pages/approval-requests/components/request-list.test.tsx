import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ApprovalRequestSummary } from "../../../api/types";

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file.
// Factories use require, not `() => import()`: Bun hangs when a later test
// file in the same run re-registers an alias with an async factory.
mock.module("@/components/shared/questions/answer-view", () =>
  require("../../../components/shared/questions/answer-view"),
);
mock.module("@/components/shared/questions/keyboard", () =>
  require("../../../components/shared/questions/keyboard"),
);
mock.module("@/components/shared/status-badge", () =>
  require("../../../components/shared/status-badge"),
);
mock.module("@/components/shared/task-status-icon", () =>
  require("../../../components/shared/task-status-icon"),
);
mock.module("@/components/shared/status-icon", () =>
  require("../../../components/shared/status-icon"),
);
mock.module("@/components/ui/button", () => require("../../../components/ui/button"));
mock.module("@/components/ui/skeleton", () => require("../../../components/ui/skeleton"));
mock.module("@/components/ui/dialog", () => require("../../../components/ui/dialog"));
mock.module("@/components/ui/kbd", () => require("../../../components/ui/kbd"));
mock.module("@/components/ui/badge", () => require("../../../components/ui/badge"));
mock.module("@/components/ui/tooltip", () => require("../../../components/ui/tooltip"));
mock.module("@/components/kibo-ui/spinner", () => require("../../../components/kibo-ui/spinner"));
mock.module("@/components/ui/spinner", () => require("../../../components/ui/spinner"));
mock.module("@/hooks/use-user-name", () => ({ useUserName: () => () => null }));
mock.module("@/lib/approval-format", () => require("../../../lib/approval-format"));
mock.module("@/lib/approval-shortcuts", () => require("../../../lib/approval-shortcuts"));
mock.module("@/lib/status-labels", () => require("../../../lib/status-labels"));
mock.module("@/lib/utils", () => require("../../../lib/utils"));
const { RequestList } = await import("./request-list");

const row = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Deploy the production release candidate",
  status: "pending",
  questionCount: 2,
  createdAt: "2026-09-20T10:00:00.000Z",
  resolvedBy: null,
  approvalProgress: null,
} as unknown as ApprovalRequestSummary;

describe("RequestList layout", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RequestList rows={[row]} loading={false} onOpen={() => {}} />
    </MemoryRouter>,
  );

  // The dashboard sidebar takes 256px, so a viewport breakpoint (`md:`, 768px)
  // leaves a tablet list only ~500px wide, which crushed the title column to
  // one character per line. The table must follow the list's own width.
  test("switches card to table by the list's own width, not the viewport", () => {
    expect(html).toContain("@container");
    expect(html).toContain("@4xl:grid-cols-");
    expect(html).not.toMatch(/(^|[\s"])md:/);
  });
});
