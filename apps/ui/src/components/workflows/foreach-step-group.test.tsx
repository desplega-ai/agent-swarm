import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { WorkflowDefinition, WorkflowNode, WorkflowRunStep } from "../../api/types";

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file. Factories use require (see
// step-card.test.tsx).
mock.module("@/lib/status-labels", () => require("../../lib/status-labels"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/kibo-ui/spinner", () => require("../kibo-ui/spinner"));
mock.module("@/components/ui/spinner", () => require("../ui/spinner"));
mock.module("@/components/shared/agent-link", () => require("../shared/agent-link"));
mock.module("@/components/shared/status-badge", () => require("../shared/status-badge"));
mock.module("@/components/shared/task-status-icon", () => require("../shared/task-status-icon"));
mock.module("@/components/ui/alert", () => require("../ui/alert"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/workflows/graph-utils", () => require("./graph-utils"));
mock.module("@/components/workflows/step-card", () => require("./step-card"));
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
  ForeachStepGroup,
  foreachChildSummary,
  foreachConcurrencyCap,
  foreachDefaultOpen,
  foreachFailurePolicy,
  groupForeachAttempts,
} = await import("./foreach-step-group");
const { toReactFlowGraph } = await import("./graph-utils");

let rowId = 0;

function child(
  itemKey: string,
  index: number,
  status: WorkflowRunStep["status"],
  extra: Partial<WorkflowRunStep> & { attempt?: number } = {},
): WorkflowRunStep {
  const { attempt, ...rest } = extra;
  rowId++;
  return {
    id: `row-${rowId}`,
    runId: "run-1",
    nodeId: `fan#${itemKey}`,
    nodeType: "sub-workflow",
    status,
    input: { itemKey, index, ...(attempt === undefined ? {} : { attempt }) },
    startedAt: "2026-10-21T10:00:00.000Z",
    ...rest,
  };
}

const parent: WorkflowRunStep = {
  id: "parent",
  runId: "run-1",
  nodeId: "fan",
  nodeType: "foreach",
  status: "waiting",
  startedAt: "2026-10-21T10:00:00.000Z",
};

function fanNode(config: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "fan",
    type: "foreach",
    config: { items: "{{list.items}}", body: { type: "sub-workflow", config: {} }, ...config },
  };
}

/** The seeded shape: a fail-fast run retried, so beta has a failed then a completed attempt. */
function retriedRun(): WorkflowRunStep[] {
  return [
    child("alpha", 0, "completed", { attempt: 0 }),
    child("beta", 1, "failed", { attempt: 0, error: "child run failed" }),
    child("gamma", 2, "cancelled", { attempt: 0 }),
    child("delta", 3, "cancelled", { attempt: 0 }),
    child("beta", 1, "completed", { attempt: 1 }),
    child("gamma", 2, "waiting", { attempt: 1 }),
    child("delta", 3, "pending", { attempt: 1 }),
  ];
}

describe("groupForeachAttempts", () => {
  test("splits each item into its latest attempt and earlier ones, in item order", () => {
    const items = groupForeachAttempts(retriedRun());
    expect(items.map((item) => item.latest.nodeId)).toEqual([
      "fan#alpha",
      "fan#beta",
      "fan#gamma",
      "fan#delta",
    ]);
    const beta = items[1]!;
    expect(beta.latest.status).toBe("completed");
    expect(beta.earlier.map((step) => step.status)).toEqual(["failed"]);
    expect(items[0]!.earlier).toEqual([]);
  });

  test("orders attempts by input.attempt, not by row order", () => {
    const later = child("beta", 1, "completed", { attempt: 1 });
    const earlier = child("beta", 1, "failed", { attempt: 0 });
    const [item] = groupForeachAttempts([later, earlier]);
    expect(item!.latest).toBe(later);
    expect(item!.earlier).toEqual([earlier]);
  });

  test("a legacy row without input.attempt counts as the first attempt", () => {
    const legacy = child("beta", 1, "failed");
    const retry = child("beta", 1, "running", { attempt: 1 });
    const [item] = groupForeachAttempts([legacy, retry]);
    expect(item!.latest).toBe(retry);
    expect(item!.earlier).toEqual([legacy]);
  });
});

describe("foreachChildSummary", () => {
  test("counts latest attempts only, with queued and in-flight items", () => {
    expect(foreachChildSummary(retriedRun())).toEqual({
      total: 4,
      ok: 2,
      failed: 0,
      queued: 1,
      running: 1,
      hasPending: true,
    });
  });

  test("a superseded failure no longer opens the group", () => {
    const steps = [
      child("alpha", 0, "completed", { attempt: 0 }),
      child("beta", 1, "failed", { attempt: 0 }),
      child("beta", 1, "completed", { attempt: 1 }),
    ];
    expect(foreachDefaultOpen(steps)).toBe(false);
  });

  test("completed with an error still counts as failed", () => {
    const steps = [child("alpha", 0, "completed", { error: "continue-mode failure" })];
    expect(foreachChildSummary(steps).failed).toBe(1);
  });
});

describe("foreach policy and cap", () => {
  test("config.failurePolicy wins over onNodeFailure", () => {
    expect(foreachFailurePolicy(fanNode({ failurePolicy: "collect-outcomes" }), "fail")).toBe(
      "collect-outcomes",
    );
  });

  test("without config.failurePolicy the policy follows onNodeFailure", () => {
    expect(foreachFailurePolicy(fanNode(), undefined)).toBe("fail-fast");
    expect(foreachFailurePolicy(fanNode(), "continue")).toBe("collect-outcomes");
  });

  test("the cap is undefined unless concurrency is a positive integer", () => {
    expect(foreachConcurrencyCap(fanNode({ concurrency: 2 }))).toBe(2);
    expect(foreachConcurrencyCap(fanNode())).toBeUndefined();
    expect(foreachConcurrencyCap(fanNode({ concurrency: 0 }))).toBeUndefined();
  });
});

function renderGroup(
  config: Record<string, unknown>,
  childSteps: WorkflowRunStep[],
  onNodeFailure?: WorkflowDefinition["onNodeFailure"],
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ForeachStepGroup
          parent={parent}
          childSteps={childSteps}
          workflowNodes={[fanNode(config)]}
          onNodeFailure={onNodeFailure}
          selectedNodeId={null}
          isOpen
          onToggleOpen={() => {}}
          expandedStepIds={new Set()}
          onStepClick={() => {}}
          onToggleStepExpand={() => {}}
          registerStepRef={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ForeachStepGroup", () => {
  test("shows queued and running against the cap, the policy, and the attempt badge", () => {
    const html = renderGroup({ concurrency: 2 }, retriedRun());
    expect(html).toContain("4 items");
    expect(html).toContain("· 2 ok");
    expect(html).toContain("· 1 queued");
    expect(html).toContain("· 1 running / 2");
    expect(html).toContain("fail-fast");
    expect(html).not.toContain("failed</span>");
    // One card per item, not per attempt row.
    expect(html.match(/sub-workflow · #/g)?.length).toBe(4);
    expect(html).toContain("sub-workflow · #1");
    expect(html.match(/attempt 2/g)?.length).toBe(3);
  });

  test("an unbounded fan-out shows no running / cap text", () => {
    const html = renderGroup({}, retriedRun(), "continue");
    expect(html).not.toContain("running /");
    expect(html).toContain("collect-outcomes");
  });
});

describe("toReactFlowGraph", () => {
  test("a retried item's superseded failure does not fail the foreach node", () => {
    const definition: WorkflowDefinition = { nodes: [fanNode()], edges: [] };
    const steps = [
      { ...parent, status: "completed" as const },
      child("alpha", 0, "completed", { attempt: 0 }),
      child("beta", 1, "failed", { attempt: 0 }),
      child("beta", 1, "completed", { attempt: 1 }),
    ];
    const { nodes } = toReactFlowGraph(definition, steps);
    expect(nodes.find((node) => node.id === "fan")?.data.stepStatus).toBe("completed");
  });
});
