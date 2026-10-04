import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { WorkflowRunStep } from "../../api/types";

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file.
// Factories use require, not `() => import()`: Bun hangs when a later test
// file in the same run re-registers an alias with an async factory.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/kibo-ui/spinner", () => require("../kibo-ui/spinner"));
mock.module("@/components/ui/spinner", () => require("../ui/spinner"));

mock.module("@/components/shared/agent-link", () => require("../shared/agent-link"));
mock.module("@/components/shared/status-badge", () => require("../shared/status-badge"));
mock.module("@/components/shared/task-status-icon", () => require("../shared/task-status-icon"));
mock.module("@/components/ui/alert", () => require("../ui/alert"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/workflows/graph-utils", () => require("./graph-utils"));
mock.module("@/components/workflows/json-tree", () => require("./json-tree"));
mock.module("@/lib/synthetic-step-id", () => require("../../lib/synthetic-step-id"));
mock.module("@/api/hooks/use-agents", () => require("../../api/hooks/use-agents"));
mock.module("@/lib/config", () => require("../../lib/config"));
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
