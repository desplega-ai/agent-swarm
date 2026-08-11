import { createTaskExtended, getTaskById } from "../../be/db";
import type { AgentTask } from "../../types";
import {
  DEVFLOW_AGENT_CONTRACT_VERSION,
  DEVFLOW_AGENT_OUTPUT_SCHEMAS,
} from "../domain/agent-contracts";
import { DevFlowError } from "../domain/errors";
import type { DevFlowAgentMode, DevFlowAgentRun, DevFlowContext } from "../domain/types";
import { buildDevFlowAgentPrompt, DEVFLOW_PROMPT_VERSION } from "../prompts";
import type { DevFlowRepository } from "../repository";
import type { DevFlowEvidenceService } from "./evidence-service";

export interface SwarmTaskRecord {
  id: string;
  status: string;
  output?: string;
  failureReason?: string;
  finishedAt?: string;
}

export interface SwarmTaskCreateOptions {
  source: "api";
  taskType: string;
  tags: string[];
  priority: number;
  status: "unassigned";
  outputSchema: Record<string, unknown>;
  requestedByUserId?: string;
  contextKey: string;
}

export interface SwarmTaskRuntime {
  create(task: string, options: SwarmTaskCreateOptions): SwarmTaskRecord;
  get(id: string): SwarmTaskRecord | null;
}

export interface DevFlowAgentAdapter {
  startAgentRun(
    context: DevFlowContext,
    workItemId: string,
    mode: DevFlowAgentMode,
  ): DevFlowAgentRun;
  reconcileAgentRun(context: DevFlowContext, agentRunId: string): DevFlowAgentRun;
}

const modeState: Record<DevFlowAgentMode, string> = {
  intake: "captured",
  scope: "triaged",
  spec: "scoped",
};

const activeStatuses = new Set(["queued", "running"]);
const swarmQueuedStatuses = new Set(["backlog", "unassigned", "offered", "reviewing", "pending"]);
const swarmFailedStatuses = new Set(["failed", "cancelled", "superseded"]);

function realRuntime(): SwarmTaskRuntime {
  return {
    create(task, options) {
      return taskRecord(createTaskExtended(task, options));
    },
    get(id) {
      const task = getTaskById(id);
      return task ? taskRecord(task) : null;
    },
  };
}

function taskRecord(task: AgentTask): SwarmTaskRecord {
  return {
    id: task.id,
    status: task.status,
    output: task.output,
    failureReason: task.failureReason,
    finishedAt: task.finishedAt,
  };
}

export function createAgentAdapter(input: {
  repo: DevFlowRepository;
  evidence: DevFlowEvidenceService;
  runtime?: SwarmTaskRuntime;
}): DevFlowAgentAdapter {
  const { repo, evidence } = input;
  const runtime = input.runtime ?? realRuntime();

  return {
    startAgentRun(context, workItemId, mode) {
      const item = repo.getWorkItem(context.organizationId, workItemId);
      if (!item) throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
      if (item.state !== modeState[mode]) {
        throw new DevFlowError(
          409,
          "agent_run_state_mismatch",
          `${mode} assistance requires a ${modeState[mode]} work item.`,
        );
      }

      const active = repo
        .listAgentRuns(context.organizationId, workItemId)
        .find((run) => run.mode === mode && activeStatuses.has(run.status));
      if (active) return active;

      const run = repo.createAgentRun({
        organizationId: context.organizationId,
        workItemId,
        mode,
        contractVersion: DEVFLOW_AGENT_CONTRACT_VERSION,
        promptVersion: DEVFLOW_PROMPT_VERSION,
      });

      try {
        const task = runtime.create(
          buildDevFlowAgentPrompt({
            mode,
            workItem: item,
            scope: mode === "spec" ? repo.getScope(context.organizationId, workItemId) : undefined,
          }),
          {
            source: "api",
            taskType: `devflow-${mode}`,
            tags: ["devflow", `devflow:${mode}`, `organization:${context.organizationId}`],
            priority: item.priority === "p1" ? 90 : item.priority === "p2" ? 60 : 40,
            status: "unassigned",
            outputSchema: DEVFLOW_AGENT_OUTPUT_SCHEMAS[mode],
            requestedByUserId: context.actorKind === "user" ? context.actorId : undefined,
            contextKey: `devflow:${context.organizationId}:${workItemId}:${mode}:${run.id}`,
          },
        );
        const updated = repo.updateAgentRun(context.organizationId, run.id, {
          swarmTaskId: task.id,
        });
        repo.appendAuditEvent({
          context,
          workItemId,
          action: "agent_run.queued",
          metadata: { agentRunId: run.id, swarmTaskId: task.id, mode },
        });
        return updated;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to create Swarm task";
        repo.updateAgentRun(context.organizationId, run.id, {
          status: "failed",
          errorMessage: message,
          finishedAt: new Date().toISOString(),
        });
        throw error;
      }
    },

    reconcileAgentRun(context, agentRunId) {
      const run = repo.getAgentRun(context.organizationId, agentRunId);
      if (!run) throw new DevFlowError(404, "not_found", "DevFlow agent run not found.");
      if (run.evidenceAppliedAt || run.status === "succeeded" || run.status === "failed")
        return run;
      if (!run.swarmTaskId) {
        throw new DevFlowError(409, "agent_run_not_dispatched", "Agent run has no Swarm task.");
      }
      const task = runtime.get(run.swarmTaskId);
      if (!task) {
        throw new DevFlowError(409, "swarm_task_not_found", "The linked Swarm task was not found.");
      }

      if (swarmQueuedStatuses.has(task.status)) return run;
      if (task.status === "in_progress" || task.status === "paused") {
        return repo.updateAgentRun(context.organizationId, run.id, {
          status: "running",
          startedAt: run.startedAt ?? new Date().toISOString(),
        });
      }
      if (swarmFailedStatuses.has(task.status)) {
        const message =
          task.failureReason ??
          (task.status === "cancelled"
            ? "Swarm task was cancelled"
            : task.status === "superseded"
              ? "Swarm task was superseded"
              : "Swarm task failed");
        const failed = repo.updateAgentRun(context.organizationId, run.id, {
          status: "failed",
          errorMessage: message,
          finishedAt: task.finishedAt ?? new Date().toISOString(),
        });
        repo.appendAuditEvent({
          context,
          workItemId: run.workItemId,
          action: "agent_run.failed",
          metadata: {
            agentRunId: run.id,
            swarmTaskId: task.id,
            reason: message,
          },
        });
        return failed;
      }
      if (task.status !== "completed") return run;

      let output: unknown;
      try {
        output = JSON.parse(task.output ?? "");
      } catch {
        const message = "Completed Swarm task did not return valid JSON evidence.";
        return repo.updateAgentRun(context.organizationId, run.id, {
          status: "failed",
          errorMessage: message,
          finishedAt: task.finishedAt ?? new Date().toISOString(),
        });
      }

      evidence.applyAgentEvidence(
        {
          organizationId: context.organizationId,
          actorKind: "agent",
          actorId: `devflow-${run.mode}-agent`,
          correlationId: context.correlationId,
        },
        run.id,
        output,
      );
      return repo.getAgentRun(context.organizationId, run.id)!;
    },
  };
}
