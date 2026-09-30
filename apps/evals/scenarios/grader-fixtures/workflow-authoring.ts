import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";
import { workflowAuthoring } from "../workflow-authoring.ts";

/**
 * Reference: what a correct run of the workflow-authoring task leaves behind.
 * The worker searches the script catalog, finds the seeded `pr-checks` script,
 * and creates exactly one workflow with `create-workflow`: a `swarm-script` node
 * running `pr-checks` (reusable script, not an inline one), an `agent-task` node
 * that reads the script result through an explicit `inputs` mapping and returns
 * structured JSON (summary, passed, nextAction), and a final `notify` node. The
 * trigger schema accepts a PR webhook payload (repository, pullRequest, requester)
 * using only supported JSON-Schema keywords. It then reports through
 * `store-progress`.
 *
 * The workflows list also returns rows the worker did not create: two workflows
 * from another agent and one anonymous workflow that predates the task, which a
 * real sandbox can carry. Only the worker's own workflow may count.
 *
 * The null agent completes its task and creates nothing, so `workflow-exists`
 * must fail against the same foreign workflows.
 */

const WORKER = "worker-0";
const TASK_CREATED_AT = "2026-09-30T10:00:00.000Z";

const triggerSchema = {
  type: "object",
  required: ["repository", "pullRequest", "requester"],
  properties: {
    repository: { type: "string" },
    pullRequest: { type: "number" },
    requester: { type: "string" },
  },
};

const definition = {
  nodes: [
    {
      id: "run-checks",
      type: "swarm-script",
      next: "review-pr",
      config: {
        scriptName: "pr-checks",
        args: {
          repository: "{{trigger.repository}}",
          pullRequest: "{{trigger.pullRequest}}",
        },
      },
    },
    {
      id: "review-pr",
      type: "agent-task",
      next: "notify-requester",
      // The agent-task only sees the script result through this mapping.
      inputs: { checks: "run-checks" },
      config: {
        template: [
          "Review pull request #{{trigger.pullRequest}} in {{trigger.repository}}",
          "(requested by {{trigger.requester}}).",
          "Deterministic check result: {{checks.result}}",
          "Reply with JSON: a summary, whether the PR passed, and the next action.",
        ].join(" "),
        outputSchema: {
          type: "object",
          required: ["summary", "passed", "nextAction"],
          properties: {
            summary: { type: "string" },
            passed: { type: "boolean" },
            nextAction: { type: "string" },
          },
        },
      },
    },
    {
      id: "notify-requester",
      type: "notify",
      inputs: { review: "review-pr" },
      config: {
        channel: "swarm",
        template:
          "PR #{{trigger.pullRequest}} review: {{review.taskOutput.summary}} (next: {{review.taskOutput.nextAction}})",
      },
    },
  ],
};

const createInput = {
  name: "pr-review-pipeline",
  description: "Deterministic PR checks, then an agent review with structured output, then notify.",
  definition,
  triggerSchema,
};

const myWorkflow = {
  id: "8d3f2b1c-5a7e-4c19-9f60-2b4e7a1d3c58",
  name: createInput.name,
  description: createInput.description,
  enabled: true,
  createdByAgentId: WORKER,
  createdAt: "2026-09-30T10:04:12.000Z",
  triggerSchema,
  definition: { ...definition, onNodeFailure: "fail" },
};

/** Rows the worker did not create; a real API returns them in the same list. */
const foreignWorkflows = [
  {
    id: "1a6c0e44-2f0b-4d8e-8c1f-7e9b5d2a4f01",
    name: "daily-standup-digest",
    enabled: true,
    createdByAgentId: "lead",
    createdAt: "2026-09-12T08:00:00.000Z",
    definition: {
      nodes: [{ id: "post", type: "notify", config: { channel: "swarm", template: "hi" } }],
    },
  },
  {
    id: "5b9e7d02-6c3a-4f15-b2d8-0a1c4e6f8b93",
    name: "stale-issue-sweeper",
    enabled: false,
    createdByAgentId: "lead",
    createdAt: "2026-09-15T14:30:00.000Z",
    definition: { nodes: [{ id: "sweep", type: "agent-task", config: { template: "sweep" } }] },
  },
  {
    // Leaked from an earlier attempt: no creator recorded, created before this task.
    id: "c47a1f90-3e5d-4b2c-a6f8-9d0e2b7c1a35",
    name: "old-review-draft",
    enabled: true,
    createdAt: "2026-09-29T17:20:00.000Z",
    definition: { nodes: [{ id: "only", type: "agent-task", config: { template: "draft" } }] },
  },
];

const workflowTasks = () =>
  nullTasks(workflowAuthoring).map((t) => ({
    ...t,
    agentId: WORKER,
    createdAt: TASK_CREATED_AT,
  }));

export const fixture: GraderFixture = {
  reference: () =>
    makeContext(workflowAuthoring, {
      tasks: workflowTasks().map((t) => ({
        ...t,
        result: "Created workflow pr-review-pipeline (script -> agent-task -> notify).",
      })),
      api: { "/api/workflows?fields=full": [...foreignWorkflows, myWorkflow] },
      logs: {
        "task-0": [
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__script-search",
            { query: "pull request lint check" },
            {
              success: true,
              data: {
                scripts: [
                  {
                    name: "pr-checks",
                    scope: "global",
                    description:
                      "Deterministic lint/check gate for a pull request: validates the repository and PR number and returns a pass/fail verdict with findings.",
                  },
                  { name: "gh-pr-snapshot", scope: "global", description: "Snapshot of a PR." },
                ],
              },
            },
            "toolu_search1",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__create-workflow",
            createInput,
            {
              success: true,
              message: `Workflow "${myWorkflow.name}" created.`,
              workflow: { id: myWorkflow.id, name: myWorkflow.name, enabled: true },
            },
            "toolu_create1",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__store-progress",
            {
              status: "completed",
              output: `Created workflow ${myWorkflow.name} (${myWorkflow.id}) with 3 nodes.`,
            },
            { success: true, message: "Progress stored." },
            "toolu_progress1",
          ),
        ],
      },
    }),
  nullContext: () =>
    makeContext(workflowAuthoring, {
      tasks: workflowTasks(),
      // The seeded/foreign rows are still there; the worker just did nothing.
      api: { "/api/workflows?fields=full": foreignWorkflows },
    }),
  notes:
    "The reference stores the same definition it passes to create-workflow. Foreign and leaked " +
    "workflows are in both contexts so the ownership filter in workflows() is exercised.",
};
