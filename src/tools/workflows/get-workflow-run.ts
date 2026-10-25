import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflowRun, getWorkflowRunStepsByRunId } from "@/be/db";
import { getWorkflowRunStepsSlimByRunId, getWorkflowRunSummary } from "@/be/db/workflow-runs";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

const STEP_VALUE_CAP = 400;

function stepValuePreview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (!serialized) return undefined;
  return serialized.length > STEP_VALUE_CAP
    ? `${serialized.slice(0, STEP_VALUE_CAP)}…`
    : serialized;
}

function renderSteps(
  steps: Awaited<ReturnType<typeof getWorkflowRunStepsSlimByRunId>>,
): string | undefined {
  if (steps.length === 0) return undefined;
  return steps
    .map((step) => {
      const nodeId = (step as { nodeId?: unknown }).nodeId ?? "?";
      const status = (step as { status?: unknown }).status ?? "?";
      const error = (step as { error?: unknown }).error;
      const errorSuffix = typeof error === "string" && error ? ` — error: ${error}` : "";
      // Step results must reach the text channel — details suppresses the
      // JSON fallback, and text-only harnesses never see structured data.
      const output = errorSuffix
        ? undefined
        : stepValuePreview((step as { output?: unknown }).output);
      const outputSuffix = output ? ` — output: ${output}` : "";
      const diagnostics = stepValuePreview((step as { diagnostics?: unknown }).diagnostics);
      const diagnosticsSuffix = diagnostics ? ` — diagnostics: ${diagnostics}` : "";
      return `- ${String(nodeId)}: ${String(status)}${errorSuffix}${outputSuffix}${diagnosticsSuffix}`;
    })
    .join("\n");
}

export const registerGetWorkflowRunTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-workflow-run",
    {
      title: "Get Workflow Run",
      annotations: { destructiveHint: false },
      description: "Get details of a workflow run by ID, including all steps and their statuses.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow run ID"),
        fields: z
          .enum(["full", "slim"])
          .optional()
          .describe(
            "`slim` omits run.context and each step's input (a context snapshot per step, large in runs with loops). Outputs, errors and retry fields stay. Default: full.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        run: z.unknown().optional(),
        steps: z.array(z.unknown()).optional(),
      }),
    },
    async ({ id, fields }) => {
      try {
        // Display view: the scrubbed context and step outputs, never replay state.
        const slim = fields === "slim";
        const run = slim ? await getWorkflowRunSummary(id) : await getWorkflowRun(id, "display");
        if (!run) {
          return toolErr(`Workflow run not found: ${id}`, { data: { steps: [] } });
        }
        const steps = slim
          ? await getWorkflowRunStepsSlimByRunId(id)
          : await getWorkflowRunStepsByRunId(id, "display");
        return toolOk(`Run ${id} status: ${run.status}.`, {
          details: renderSteps(steps),
          data: { run, steps },
        });
      } catch (err) {
        return toolErr(String(err), { data: { steps: [] } });
      }
    },
  );
};
