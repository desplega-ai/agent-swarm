import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { WorkflowRunStep } from "../../api/types";

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file.
// Factories use require, not `() => import()`: Bun hangs when a later test
// file in the same run re-registers an alias with an async factory.
mock.module("@/lib/status-labels", () => require("../../lib/status-labels"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/kibo-ui/spinner", () => require("../kibo-ui/spinner"));
mock.module("@/components/ui/spinner", () => require("../ui/spinner"));

mock.module("@/components/shared/agent-link", () => require("../shared/agent-link"));
mock.module("@/components/shared/status-badge", () => require("../shared/status-badge"));
mock.module("@/components/shared/task-status-icon", () => require("../shared/task-status-icon"));
mock.module("@/components/ui/alert", () => require("../ui/alert"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/workflows/graph-utils", () => require("./graph-utils"));
mock.module("@/hooks/use-copy-to-clipboard", () => require("../../hooks/use-copy-to-clipboard"));
mock.module("@/lib/json-output", () => require("../../lib/json-output"));
mock.module("@/components/shared/json-tree", () => require("../shared/json-tree"));
mock.module("@/lib/synthetic-step-id", () => require("../../lib/synthetic-step-id"));
mock.module("@/api/hooks/use-agents", () => require("../../api/hooks/use-agents"));
mock.module("@/api/hooks/use-workflows", () => require("../../api/hooks/use-workflows"));
mock.module("@/api/hooks/use-approval-requests", () =>
  require("../../api/hooks/use-approval-requests"),
);
mock.module("@/lib/config", () => require("../../lib/config"));
const {
  AttemptHistory,
  HitlOutput,
  StepCard,
  SubWorkflowOutput,
  SystemOneExtractionOutput,
  SystemOneOutput,
} = await import("./step-card");

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

/** Hooks stay pending under static rendering, so these render the step output alone. */
function renderWithQuery(node: ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function systemOneStep(output: unknown, status = "completed"): WorkflowRunStep {
  return {
    id: "step-2",
    runId: "run-1",
    nodeId: "classify",
    nodeType: "system-one-decision",
    status,
    output,
    startedAt: "2026-09-28T10:00:00.000Z",
  } as WorkflowRunStep;
}

const decision = {
  model: "laya-rl-agent",
  answers: {
    sentiment: {
      type: "choice",
      choice: "negative",
      probabilities: { negative: 0.9494 },
      confidence: 0.9494,
    },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};

describe("SystemOneOutput", () => {
  test("shows each answer, its confidence and who decided", () => {
    const html = renderWithQuery(
      <SystemOneOutput
        step={systemOneStep({
          ...decision,
          review: {
            status: "not_required",
            questions: { sentiment: { confidence: 0.9494, inBand: false, decidedBy: "model" } },
          },
        })}
      />,
    );
    expect(html).toContain("sentiment");
    expect(html).toContain("negative");
    expect(html).toContain("95%");
    expect(html).toContain("decided by model");
    expect(html).toContain("No review needed");
    expect(html).toContain("laya-rl-agent");
  });

  test("a person's override keeps the model's answer visible", () => {
    const html = renderWithQuery(
      <SystemOneOutput
        step={systemOneStep({
          ...decision,
          answers: { sentiment: { ...decision.answers.sentiment, choice: "neutral" } },
          review: {
            status: "approved",
            approvalRequestId: "00000000-0000-4000-8000-000000000002",
            questions: {
              sentiment: {
                confidence: 0.5,
                inBand: true,
                decidedBy: "human",
                modelAnswer: "negative",
              },
            },
          },
        })}
      />,
    );
    expect(html).toContain("decided by human");
    expect(html).toContain("model said negative");
    expect(html).toContain("Review approved");
    expect(html).toContain("/approval-requests/00000000-0000-4000-8000-000000000002");
  });

  test("a parked review shows that it waits for a person", () => {
    const html = renderWithQuery(
      <SystemOneOutput
        step={systemOneStep(
          {
            ...decision,
            review: {
              status: "pending",
              questions: { sentiment: { confidence: 0.5, inBand: true, decidedBy: "model" } },
            },
          },
          "waiting",
        )}
        node={{
          id: "classify",
          type: "system-one-decision",
          config: { humanReview: { band: { min: 0.4, max: 0.8 } } },
        }}
      />,
    );
    expect(html).toContain("Awaiting review");
    expect(html).toContain("Awaiting approval");
    expect(html).toContain("review band 0.4–0.8");
    expect(html).toContain("in review band");
  });
});

describe("SubWorkflowOutput", () => {
  test("links the child run and lists each child node result", () => {
    const html = renderWithQuery(
      <SubWorkflowOutput
        step={{
          id: "step-3",
          runId: "run-1",
          nodeId: "call",
          nodeType: "sub-workflow",
          status: "completed",
          output: {
            runId: "61a5d1a2-0000-4000-8000-000000000003",
            outputs: { run: { id: "61a5d1a2" }, check: { passed: true }, summarize: "done" },
          },
          startedAt: "2026-09-28T10:00:00.000Z",
        }}
      />,
    );
    expect(html).toContain("/workflow-runs/61a5d1a2-0000-4000-8000-000000000003");
    expect(html).toContain("Node results (2)");
    expect(html).toContain("check");
    expect(html).toContain("summarize");
  });

  test("reads the child run from the slim query, not the full one", () => {
    const childRunId = "61a5d1a2-0000-4000-8000-000000000004";
    const subWorkflowStep: WorkflowRunStep = {
      id: "step-3",
      runId: "run-1",
      nodeId: "call",
      nodeType: "sub-workflow",
      status: "completed",
      output: { runId: childRunId, outputs: { check: { passed: false } } },
      startedAt: "2026-09-28T10:00:00.000Z",
    };
    const childRun = {
      id: childRunId,
      workflowId: "wf-child",
      status: "failed",
      startedAt: "2026-09-28T10:00:00.000Z",
      lastUpdatedAt: "2026-09-28T10:01:00.000Z",
      steps: [{ id: "child-step", runId: childRunId, nodeId: "check", status: "failed" }],
    };
    const renderSeeded = (key: unknown[]) => {
      const client = new QueryClient();
      client.setQueryData(key, childRun);
      return renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <SubWorkflowOutput step={subWorkflowStep} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    };

    const slim = renderSeeded(["workflow-run", childRunId, "slim"]);
    const full = renderSeeded(["workflow-run", childRunId]);
    // Two badges from the slim entry (the child run and its `check` step), none from the full one.
    const failedBadges = (html: string) => html.split('data-variant="failed"').length - 1;
    expect(failedBadges(slim)).toBe(2);
    expect(failedBadges(full)).toBe(0);
  });

  test("a waiting step says it waits for the child run", () => {
    const html = renderWithQuery(
      <SubWorkflowOutput
        step={{
          id: "step-3",
          runId: "run-1",
          nodeId: "call",
          nodeType: "sub-workflow",
          status: "waiting",
          startedAt: "2026-09-28T10:00:00.000Z",
        }}
      />,
    );
    expect(html).toContain("Waiting for the child run");
  });
});

describe("SystemOneExtractionOutput", () => {
  const extractionStep = (output: unknown): WorkflowRunStep =>
    ({
      id: "step-3",
      runId: "run-1",
      nodeId: "claim",
      nodeType: "system-one-extraction",
      status: "completed",
      output,
      startedAt: "2026-10-20T10:00:00.000Z",
    }) as WorkflowRunStep;

  test("shows values, a missing field with its guess, and an estimate range", () => {
    const html = renderWithQuery(
      <SystemOneExtractionOutput
        step={extractionStep({
          model: "clairic",
          answers: {
            order_id: { type: "text", value: "A-88412", confidence: 0.99 },
            damage: { type: "list", value: ["cracked screen", "dented corner"] },
            tracking_number: { type: "text", value: null, guess: "$52.10", p_null: 1 },
            repair_cost: { type: "estimate", value: 236, median: 213, p10: 122, p90: 370 },
          },
          usage: { input_tokens: 655, output_tokens: 0 },
        })}
      />,
    );
    expect(html).toContain("A-88412");
    expect(html).toContain("99%");
    expect(html).toContain("cracked screen, dented corner");
    expect(html).toContain("not in the input");
    expect(html).toContain("best guess $52.10");
    expect(html).toContain("236 · median 213 (p10 122 – p90 370)");
    expect(html).toContain("655 in");
  });
});

describe("foreach attempt history", () => {
  const failedAttempt: WorkflowRunStep = {
    id: "attempt-0",
    runId: "run-1",
    nodeId: "fan#beta",
    nodeType: "agent-task",
    status: "failed",
    error: "e2e: first attempt failed",
    input: { itemKey: "beta", index: 1, attempt: 0 },
    output: { taskId: "00000000-0000-4000-8000-0000000000aa" },
    startedAt: "2026-10-21T10:00:00.000Z",
    finishedAt: "2026-10-21T10:05:00.000Z",
  };

  test("the disclosure starts closed and names the attempt count", () => {
    const html = renderWithQuery(<AttemptHistory attempts={[failedAttempt]} />);
    expect(html).toContain("Earlier attempts (1)");
    expect(html).not.toContain("e2e: first attempt failed");
  });

  test("an open disclosure lists each attempt with status, error and task link", () => {
    const html = renderWithQuery(<AttemptHistory attempts={[failedAttempt]} defaultOpen />);
    expect(html).toContain("attempt 1");
    expect(html).toContain("FAILED");
    expect(html).toContain("e2e: first attempt failed");
    expect(html).toContain("/tasks/00000000-0000-4000-8000-0000000000aa");
  });

  test("an item card badges its body type and index, and its latest attempt number", () => {
    const latest: WorkflowRunStep = {
      ...failedAttempt,
      id: "attempt-1",
      nodeType: "sub-workflow",
      status: "running",
      error: undefined,
      input: { itemKey: "beta", index: 1, attempt: 1 },
    };
    const html = renderWithQuery(
      <StepCard
        step={latest}
        earlierAttempts={[failedAttempt]}
        workflowNodes={[{ id: "fan", type: "foreach", config: {} }]}
        isSelected={false}
        isExpanded={false}
        onClick={() => {}}
        onToggleExpand={() => {}}
        inGroup
      />,
    );
    expect(html).toContain("sub-workflow · #1");
    expect(html).not.toContain("foreach #1");
    expect(html).toContain("attempt 2");
  });
});
