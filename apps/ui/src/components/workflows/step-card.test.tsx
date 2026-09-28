import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { WorkflowRunStep } from "../../api/types";

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file.
mock.module("@/lib/utils", () => import("../../lib/utils"));

mock.module("@/components/shared/agent-link", () => import("../shared/agent-link"));
mock.module("@/components/shared/status-badge", () => import("../shared/status-badge"));
mock.module("@/components/ui/alert", () => import("../ui/alert"));
mock.module("@/components/ui/badge", () => import("../ui/badge"));
mock.module("@/components/workflows/graph-utils", () => import("./graph-utils"));
mock.module("@/components/workflows/json-tree", () => import("./json-tree"));
mock.module("@/lib/synthetic-step-id", () => import("../../lib/synthetic-step-id"));
mock.module("@/api/hooks/use-agents", () => import("../../api/hooks/use-agents"));
mock.module("@/lib/config", () => import("../../lib/config"));
const { HitlOutput } = await import("./step-card");

function step(status: string): WorkflowRunStep {
  return {
    id: "step-1",
    runId: "run-1",
    nodeId: "review",
    nodeType: "human-in-the-loop",
    status: "completed",
    output: { requestId: "00000000-0000-4000-8000-000000000001", status, responses: null },
    startedAt: "2026-09-28T10:00:00.000Z",
  } as WorkflowRunStep;
}

function render(status: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <HitlOutput step={step(status)} />
    </MemoryRouter>,
  );
}

describe("HitlOutput", () => {
  test("a cancelled approval reads Cancelled, never Timed out", () => {
    const html = render("cancelled");
    expect(html).toContain("Cancelled");
    expect(html).not.toContain("Timed out");
  });

  test("a timed-out approval reads Timed out", () => {
    expect(render("timeout")).toContain("Timed out");
  });
});
