import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listWorkflowRunsPage } from "@/be/db";
import {
  createToolRegistrar,
  type SwarmToolResult,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import { WorkflowRunStatusSchema } from "@/types";

const DEFAULT_RUN_LIMIT = 20;
const TRIGGER_DATA_SUMMARY_CAP = 400;

function triggerDataSummary(triggerData: unknown): string | undefined {
  if (triggerData === undefined || triggerData === null) return undefined;
  const serialized = typeof triggerData === "string" ? triggerData : JSON.stringify(triggerData);
  if (!serialized) return undefined;
  return serialized.length > TRIGGER_DATA_SUMMARY_CAP
    ? `${serialized.slice(0, TRIGGER_DATA_SUMMARY_CAP)}…`
    : serialized;
}

function slimRun(run: ReturnType<typeof listWorkflowRunsPage>["runs"][number]) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastUpdatedAt: run.lastUpdatedAt,
    triggerDataSummary: triggerDataSummary(run.triggerData),
  };
}

function renderRuns(runs: ReturnType<typeof listWorkflowRunsPage>["runs"]): string | undefined {
  if (runs.length === 0) return undefined;
  return runs
    .map((run) => {
      const error = (run as { error?: unknown }).error;
      const errorSuffix = typeof error === "string" && error ? ` — error: ${error}` : "";
      return `- ${run.id} [${run.workflowId}]: ${run.status}${errorSuffix}`;
    })
    .join("\n");
}

export const listWorkflowRunsInputSchema = z.object({
  workflowId: z.string().uuid().describe("Workflow ID to list runs for"),
  status: WorkflowRunStatusSchema.optional().describe(
    "Filter by run status (running, waiting, completed, failed, skipped, cancelled)",
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Runs per page (default: 20, max: 100)"),
  offset: z.number().int().min(0).optional().default(0).describe("Zero-based page offset"),
  includeContext: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Return the full run `context` + trigger data instead of slim rows. Default false — prefer `get-workflow-run` to fetch a single run in full.",
    ),
});

type ListWorkflowRunsArgs = z.infer<typeof listWorkflowRunsInputSchema>;

export function listWorkflowRunsHandler({
  workflowId,
  status,
  limit = DEFAULT_RUN_LIMIT,
  offset = 0,
  includeContext = false,
}: ListWorkflowRunsArgs): SwarmToolResult {
  try {
    const { runs, page } = listWorkflowRunsPage(workflowId, {
      status,
      limit,
      offset,
    });
    const resultRuns = includeContext ? runs : runs.map(slimRun);
    return toolOk(`Found ${runs.length} run(s) at offset ${page.offset} (${page.total} total).`, {
      details: renderRuns(runs) ?? "No workflow runs matched this page.",
      data: { runs: resultRuns, page },
    });
  } catch (err) {
    return toolErr(String(err), { data: { runs: [] } });
  }
}

export const registerListWorkflowRunsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-workflow-runs",
    {
      title: "List Workflow Runs",
      annotations: { destructiveHint: false },
      description:
        "List execution runs for a workflow with offset pagination (default 20, max 100), optionally filtered by status. Returns SLIM rows WITHOUT the full `context` or trigger data — each row carries a bounded `triggerDataSummary` instead. To inspect a run's context and steps, call `get-workflow-run` by id, or pass `includeContext: true` here.",
      inputSchema: listWorkflowRunsInputSchema,
      outputSchema: swarmToolOutputSchema({
        runs: z.array(z.unknown()).optional(),
        page: z
          .looseObject({
            limit: z.number().optional(),
            offset: z.number().optional(),
            total: z.number().optional(),
            hasMore: z.boolean().optional(),
            nextOffset: z.number().optional(),
          })
          .optional(),
      }),
    },
    async (args) => listWorkflowRunsHandler(args),
  );
};
