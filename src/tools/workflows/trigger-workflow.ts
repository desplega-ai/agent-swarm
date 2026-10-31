import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import { getWorkflow, getWorkflowRun } from "@/be/db";
import {
  findAcceptedWorkflowOperation,
  IdempotencyKeyTakenError,
  recordAcceptedWorkflowOperation,
  type WorkflowIdempotencyClaim,
  workflowRequestFingerprint,
} from "@/be/db/workflow-idempotency";
import { IDEMPOTENCY_KEY_PATTERN } from "@/http/idempotency-key";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { getExecutorRegistry, startWorkflowExecution } from "@/workflows";
import { TriggerSchemaError } from "@/workflows/engine";

/**
 * Answer from the run already accepted under this key, or null when there is
 * none. Same record and rules as the HTTP trigger's `Idempotency-Key`.
 */
async function replayAcceptedTrigger(claim: WorkflowIdempotencyClaim) {
  const accepted = await findAcceptedWorkflowOperation(claim);
  if (!accepted) return null;
  if (accepted.fingerprint !== claim.fingerprint) {
    return toolErr("idempotencyKey was already used to trigger this workflow with other data.", {
      data: { idempotencyConflict: true },
    });
  }
  if (accepted.resourceDeletedAt !== null) {
    return toolErr(
      "The workflow this idempotencyKey triggered was deleted; send a new key to start over.",
    );
  }
  const { runId, skipped } = accepted.body as { runId: string; skipped: boolean };
  return toolOk("Run already accepted under this idempotencyKey; nothing new was started.", {
    details: `Replayed the run accepted under this idempotencyKey — run ID: ${runId}.`,
    data: { runId, skipped, replayed: true },
  });
}

export const registerTriggerWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "trigger-workflow",
    {
      title: "Trigger Workflow",
      annotations: { destructiveHint: false },
      description:
        "Manually trigger a workflow execution, optionally passing trigger data as context. Respects cooldown configuration. " +
        "If the workflow has a triggerSchema, the payload is validated first; on failure, the response includes structured validationErrors plus the workflow's triggerSchema for self-correction.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID to trigger"),
        triggerData: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional data to pass as trigger context to the workflow"),
        wait: z
          .boolean()
          .optional()
          .describe(
            "Default true: return after the run's instant steps ran, when it finishes or parks at its first async step. " +
              "false: return as soon as the run is created and walk it in the background. Use false from a script or step that only needs the runId.",
          ),
        idempotencyKey: z
          .string()
          .regex(IDEMPOTENCY_KEY_PATTERN)
          .optional()
          .describe(
            "Optional, 1-255 visible ASCII characters, scoped to the calling agent and this workflow. " +
              "The first trigger accepted under a key starts one run; the key is recorded in the run's own transaction and never expires. " +
              "A retry with the same key and triggerData starts nothing and returns that run (replayed: true), even if the earlier call was killed before it saw the answer. " +
              "The same key with other triggerData is an error with idempotencyConflict: true.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        runId: z.string().optional(),
        skipped: z.boolean().optional(),
        replayed: z.boolean().optional(),
        idempotencyConflict: z.boolean().optional(),
        validationErrors: z.array(z.string()).optional(),
        triggerSchema: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async ({ id, triggerData, wait, idempotencyKey }, requestInfo) => {
      try {
        if (idempotencyKey !== undefined && !requestInfo.agentId) {
          return toolErr("idempotencyKey needs an identified caller (X-Agent-ID).");
        }
        const claim: WorkflowIdempotencyClaim | undefined =
          idempotencyKey === undefined
            ? undefined
            : {
                principal: `agent:${requestInfo.agentId}`,
                key: idempotencyKey,
                operation: "workflow.trigger",
                targetId: id,
                fingerprint: workflowRequestFingerprint("workflow.trigger", triggerData ?? {}),
              };
        if (claim) {
          // Before the enabled, cooldown and trigger-schema checks: an
          // accepted trigger replays even after the workflow changed.
          const replayed = await replayAcceptedTrigger(claim);
          if (replayed) return replayed;
        }

        const workflow = await getWorkflow(id);
        if (!workflow) {
          return toolErr(`Workflow not found: ${id}`);
        }
        if (!workflow.enabled) {
          return toolErr(`Workflow "${workflow.name}" is disabled.`);
        }
        let accepted: { runId: string; skipped: boolean } | undefined;
        let runId: string;
        try {
          runId = await startWorkflowExecution(workflow, triggerData ?? {}, getExecutorRegistry(), {
            triggerType: "manual",
            triggeredByAgentId: requestInfo.agentId,
            requestedByUserId:
              (await resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId)) ??
              undefined,
            detach: wait === false,
            // Recorded in the run's own transaction: the key exists if and
            // only if the run committed.
            accept: claim
              ? async (run) => {
                  const response = { runId: run.runId, skipped: run.skipped };
                  await recordAcceptedWorkflowOperation(claim, {
                    workflowId: workflow.id,
                    runId: run.runId,
                    status: 201,
                    body: response,
                  });
                  accepted = response;
                }
              : undefined,
          });
        } catch (err) {
          // A concurrent call with this key committed its run first; this one
          // created none.
          if (claim && err instanceof IdempotencyKeyTakenError) {
            const replayed = await replayAcceptedTrigger(claim);
            if (replayed) return replayed;
          }
          throw err;
        }

        // Check if the run was skipped due to cooldown
        const skipped = accepted
          ? accepted.skipped
          : (await getWorkflowRun(runId))?.status === "skipped";

        if (skipped) {
          return toolOk(`Workflow "${workflow.name}" skipped (cooldown).`, {
            details: `Workflow "${workflow.name}" skipped (cooldown active) — run ID: ${runId}.`,
            data: { runId, skipped: true },
          });
        }

        return toolOk(`Triggered workflow "${workflow.name}".`, {
          details: `Triggered workflow "${workflow.name}" — run ID: ${runId}.`,
          data: { runId, skipped: false },
        });
      } catch (err) {
        if (err instanceof TriggerSchemaError) {
          // Re-fetch workflow so we can echo its triggerSchema for self-correction.
          // (Workflow existence was already proven above; this is best-effort.)
          const workflow = await getWorkflow(id);
          const bulleted = err.validationErrors.map((e) => `- ${e}`).join("\n");
          const schemaBlock = workflow?.triggerSchema
            ? `\n\nExpected triggerSchema:\n\`\`\`json\n${JSON.stringify(workflow.triggerSchema, null, 2)}\n\`\`\``
            : "";
          return toolErr(
            `Trigger payload did not match the workflow's triggerSchema (${err.validationErrors.length} error${err.validationErrors.length === 1 ? "" : "s"}).`,
            {
              details: `Trigger payload did not match the workflow's triggerSchema:\n${bulleted}${schemaBlock}`,
              data: {
                validationErrors: err.validationErrors,
                triggerSchema: workflow?.triggerSchema,
              },
            },
          );
        }
        return toolErr(String(err));
      }
    },
  );
};
