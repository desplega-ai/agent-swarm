import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getActivePricingRow, getTaskById, insertSessionCost } from "@/be/db";
import { recomputeSessionCost } from "@/http/session-cost-recompute";
import {
  createToolRegistrar,
  type RequestInfo,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import type { AgentTask } from "@/types";
import { getExecutorRegistry } from "@/workflows";
import {
  SYSTEM_ONE_DECISION_NODE_TYPE,
  SystemOneDecisionConfigSchema,
  SystemOneDecisionExecutor,
} from "@/workflows/executors/system-one-decision";
import {
  SYSTEM_ONE_PROVIDER_IDS,
  type SystemOneProviderId,
} from "@/workflows/executors/system-one-providers";

/**
 * The task a decision's cost lands on: the explicit `taskId`, else the caller's
 * X-Source-Task-Id. A caller may charge only its own task; an extension (its
 * origin is token-verified) may charge the task whose event it is handling.
 */
async function costTask(
  taskId: string | undefined,
  requestInfo: RequestInfo,
): Promise<{ task?: AgentTask; error?: string }> {
  const id = taskId ?? requestInfo.sourceTaskId;
  if (!id) return {};
  const task = await getTaskById(id);
  const allowed =
    !!task && (requestInfo.callOrigin === "extension" || task.agentId === requestInfo.agentId);
  if (allowed) return { task };
  // A header-derived id with no matching task (a taskless trigger) records nothing.
  return taskId ? { error: `taskId ${taskId} is not a task this caller can charge` } : {};
}

/**
 * One `session_costs` row of kind `system-one` on the task, priced from the
 * `pricing` table under provider `system-one`, model `<host>/<model>`. With no
 * rate row it is recorded `unpriced` at $0, tokens kept.
 */
async function recordDecisionCost(
  task: AgentTask,
  callerAgentId: string,
  provider: SystemOneProviderId,
  output: { model: string; usage: { input_tokens: number; output_tokens: number } },
  durationMs: number,
) {
  const model = `${provider}/${output.model}`;
  const priced = await recomputeSessionCost(
    {
      provider: "system-one",
      model,
      harnessCostUsd: 0,
      inputTokens: output.usage.input_tokens,
      outputTokens: output.usage.output_tokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      atEpochMs: Date.now(),
    },
    async (pricingProvider, lookupModel, tokenClass, atEpochMs) =>
      (await getActivePricingRow(pricingProvider, lookupModel, tokenClass, atEpochMs))
        ?.pricePerMillionUsd ?? null,
  );
  const { cost } = await insertSessionCost({
    sessionId: `system-one:${crypto.randomUUID()}`,
    taskId: task.id,
    agentId: task.agentId ?? callerAgentId,
    totalCostUsd: priced.totalCostUsd,
    inputTokens: output.usage.input_tokens,
    outputTokens: output.usage.output_tokens,
    durationMs,
    numTurns: null,
    model,
    costSource: priced.costSource,
    kind: "system-one",
  });
  return { taskId: task.id, costUsd: cost.totalCostUsd, costSource: cost.costSource };
}

/**
 * One typed decision (Jev, Clef and the other SystemOne hosts) made in the API
 * process, the same way a `system-one-decision` workflow node makes it. The
 * provider credential is read and sent here and never reaches the caller, so a
 * script can ask for a decision without a credential binding in its own realm.
 */
export const registerSystemOneDecideTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "system-one-decide",
    {
      title: "Ask a SystemOne decision model",
      annotations: { destructiveHint: false, openWorldHint: true },
      description:
        "Send a state and typed questions (noul, choice, score) to a SystemOne decision host such as Jev or Clef, and return the validated answers. " +
        "Same request, provider list, credentials and validation as the `system-one-decision` workflow node, without its human review band. " +
        "The provider credential is a global secret that stays on the server; this tool never returns it.",
      inputSchema: z.object({
        provider: z
          .enum(SYSTEM_ONE_PROVIDER_IDS)
          .optional()
          .describe(
            "Decision host (default: the SYSTEM_ONE_DEFAULT_PROVIDER global config, typesafe when unset)",
          ),
        model: z.string().min(1).optional().describe("Provider model id (default: the provider's)"),
        state: z
          .union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())])
          .describe("The state to decide on"),
        questions: z
          .record(z.string(), z.record(z.string(), z.unknown()))
          .describe(
            "Questions by id, each `{ type: 'noul' | 'choice' | 'score', instructions, criteria }`",
          ),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe("Time budget for the call, retries included (default 30000)"),
        maxRetries: z
          .number()
          .int()
          .optional()
          .describe("Retries on transient failures inside the time budget (default 2)"),
        taskId: z
          .uuid()
          .optional()
          .describe(
            "Task this decision serves; its cost is recorded on that task's session costs (default: the caller's X-Source-Task-Id). Must be the caller's own task, or, from an extension, the task of the event it handles",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        model: z.string().optional(),
        answers: z.record(z.string(), z.unknown()).optional(),
        usage: z.record(z.string(), z.unknown()).optional(),
        requestId: z.string().optional(),
        cost: z
          .looseObject({
            taskId: z.string().optional(),
            costUsd: z.number().optional(),
            costSource: z.string().optional(),
          })
          .optional()
          .describe("The session-cost row recorded on the task, when a task was in scope"),
        providerUnavailable: z
          .boolean()
          .optional()
          .describe(
            "On an error: true when this deployment refuses the provider (e.g. OpenRouter behind a gateway) and no request was sent, so a caller choosing automatically can try its next provider",
          ),
      }),
    },
    async ({ provider, model, state, questions, timeoutMs, maxRetries, taskId }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. The MCP client should define the "X-Agent-ID" header.');
      }
      const scope = await costTask(taskId, requestInfo);
      if (scope.error) return toolErr(scope.error);

      // `returns` mirrors the questions: the caller reads answers directly, so
      // there is no downstream port to declare.
      const returns = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [id, { type: question.type }]),
      );
      const parsed = SystemOneDecisionConfigSchema.safeParse({
        provider,
        model,
        state,
        questions,
        returns,
        timeoutMs,
        maxRetries,
      });
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return toolErr(`Invalid decision request: ${issues}`.slice(0, 1000));
      }

      const executor = getExecutorRegistry().get(SYSTEM_ONE_DECISION_NODE_TYPE);
      if (!(executor instanceof SystemOneDecisionExecutor)) {
        return toolErr("The system-one-decision executor is not available");
      }
      const startedAt = Date.now();
      const decided = await executor.decide(parsed.data);
      if (!decided.ok) {
        return toolErr(
          decided.error,
          decided.deploymentRefused ? { data: { providerUnavailable: true } } : {},
        );
      }

      const { output } = decided;
      let cost: Awaited<ReturnType<typeof recordDecisionCost>> | undefined;
      if (scope.task) {
        try {
          cost = await recordDecisionCost(
            scope.task,
            requestInfo.agentId,
            decided.provider,
            output,
            Date.now() - startedAt,
          );
        } catch (err) {
          // The decision was made and paid for; a failed cost write must not hide it.
          console.warn(
            `[system-one-decide] cost not recorded on task ${scope.task.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return toolOk(`Decision from ${output.model}`, {
        data: {
          model: output.model,
          answers: output.answers,
          usage: output.usage,
          requestId: output.requestId,
          ...(cost ? { cost } : {}),
        },
      });
    },
  );
};
