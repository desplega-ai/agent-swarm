import { createTaskExtended, getTaskById } from "../../be/db";
import type { AgentTask } from "../../types";
import { DevFlowError } from "../domain/errors";
import {
  FACTORY_TASK_OUTPUT_SCHEMA,
  FactoryTaskCandidateSchema,
} from "../domain/factory-contracts";
import type { DevFlowContext, DevFlowFactoryExecution } from "../domain/types";
import { buildDevFlowFactoryPrompt } from "../prompts";
import type { DevFlowRepository } from "../repository";
import {
  createGitFactoryArtifactRuntime,
  type FactoryArtifactRuntime,
} from "./factory-artifact-runtime";

export interface FactoryTaskRecord {
  id: string;
  status: string;
  output?: string;
  failureReason?: string;
  finishedAt?: string;
}

export interface FactoryTaskCreateOptions {
  source: "api";
  taskType: "devflow-factory-intake";
  tags: string[];
  priority: number;
  status: "unassigned";
  outputSchema: Record<string, unknown>;
  requestedByUserId?: string;
  contextKey: string;
  vcsProvider: "github";
  vcsRepo: string;
  modelTier: "smart";
  effort: "high";
}

export interface FactoryTaskRuntime {
  create(task: string, options: FactoryTaskCreateOptions): FactoryTaskRecord;
  get(id: string): FactoryTaskRecord | null;
}

export interface DevFlowFactoryAdapter {
  startExecution(context: DevFlowContext, implementationIntentId: string): DevFlowFactoryExecution;
  reconcileExecution(context: DevFlowContext, executionId: string): DevFlowFactoryExecution;
}

const queuedStatuses = new Set(["backlog", "unassigned", "offered", "pending", "reviewing"]);
const failedStatuses = new Set(["failed", "cancelled", "superseded"]);

function taskRecord(task: AgentTask): FactoryTaskRecord {
  return {
    id: task.id,
    status: task.status,
    output: task.output,
    failureReason: task.failureReason,
    finishedAt: task.finishedAt,
  };
}

function realTaskRuntime(): FactoryTaskRuntime {
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

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Factory execution failed.";
}

export function createFactoryAdapter(input: {
  repo: DevFlowRepository;
  taskRuntime?: FactoryTaskRuntime;
  artifactRuntime?: FactoryArtifactRuntime;
}): DevFlowFactoryAdapter {
  const { repo } = input;
  const taskRuntime = input.taskRuntime ?? realTaskRuntime();
  const artifactRuntime = input.artifactRuntime ?? createGitFactoryArtifactRuntime();

  return {
    startExecution(context, implementationIntentId) {
      const intent = repo.getImplementationIntent(context.organizationId, implementationIntentId);
      if (!intent) {
        throw new DevFlowError(
          404,
          "implementation_intent_not_found",
          "Implementation intent not found.",
        );
      }
      const target = repo.getRepositoryTarget(context.organizationId, intent.repositoryTargetId);
      if (!target || !target.isActive) {
        throw new DevFlowError(
          404,
          "repository_target_not_found",
          "Active repository target not found.",
        );
      }
      const existing = repo.listFactoryExecutions(context.organizationId, intent.id)[0];
      if (existing) return existing;

      const execution = repo.createFactoryExecution({
        organizationId: context.organizationId,
        implementationIntentId: intent.id,
      });
      try {
        const task = taskRuntime.create(buildDevFlowFactoryPrompt(intent), {
          source: "api",
          taskType: "devflow-factory-intake",
          tags: [
            "devflow",
            "devflow:factory",
            `organization:${context.organizationId}`,
            `implementation-intent:${intent.id}`,
          ],
          priority: intent.priority === "p1" ? 90 : intent.priority === "p2" ? 60 : 40,
          status: "unassigned",
          outputSchema: FACTORY_TASK_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
          requestedByUserId: context.actorKind === "user" ? context.actorId : undefined,
          contextKey: `devflow:${context.organizationId}:factory:${intent.id}`,
          vcsProvider: "github",
          vcsRepo: target.repositoryFullName,
          modelTier: "smart",
          effort: "high",
        });
        const updated = repo.updateFactoryExecution(context.organizationId, execution.id, {
          swarmTaskId: task.id,
        });
        repo.appendAuditEvent({
          context,
          workItemId: intent.workItemId,
          action: "factory_execution.queued",
          metadata: {
            factoryExecutionId: execution.id,
            implementationIntentId: intent.id,
            swarmTaskId: task.id,
            repositoryFullName: target.repositoryFullName,
          },
        });
        return updated;
      } catch (error) {
        repo.updateFactoryExecution(context.organizationId, execution.id, {
          status: "failed",
          failureCode: "factory_task_create_failed",
          failureDetail: failureMessage(error),
        });
        throw error;
      }
    },

    reconcileExecution(context, executionId) {
      const execution = repo.getFactoryExecution(context.organizationId, executionId);
      if (!execution) {
        throw new DevFlowError(404, "factory_execution_not_found", "Factory execution not found.");
      }
      if (["failed", "cancelled", "merged"].includes(execution.status)) return execution;
      const intent = repo.getImplementationIntent(
        context.organizationId,
        execution.implementationIntentId,
      );
      if (!intent) {
        throw new DevFlowError(
          409,
          "implementation_intent_not_found",
          "Implementation intent not found.",
        );
      }
      const target = repo.getRepositoryTarget(context.organizationId, intent.repositoryTargetId);
      if (!target) {
        throw new DevFlowError(409, "repository_target_not_found", "Repository target not found.");
      }
      if (!execution.swarmTaskId) {
        throw new DevFlowError(
          409,
          "factory_task_not_dispatched",
          "Factory execution has no Swarm task.",
        );
      }
      const task = taskRuntime.get(execution.swarmTaskId);
      if (!task) {
        throw new DevFlowError(409, "factory_task_not_found", "Linked Factory task was not found.");
      }
      if (queuedStatuses.has(task.status)) return execution;
      if (task.status === "in_progress" || task.status === "paused") {
        return repo.updateFactoryExecution(context.organizationId, execution.id, {
          status: "factory_intake",
        });
      }
      if (failedStatuses.has(task.status)) {
        return repo.updateFactoryExecution(context.organizationId, execution.id, {
          status: task.status === "cancelled" ? "cancelled" : "failed",
          failureCode: `factory_task_${task.status}`,
          failureDetail: task.failureReason ?? `Factory task ${task.status}.`,
        });
      }
      if (task.status !== "completed") return execution;

      try {
        const candidate = FactoryTaskCandidateSchema.parse(JSON.parse(task.output ?? ""));
        const snapshot = artifactRuntime.inspect({ target, intent, candidate });
        const updated = repo.updateFactoryExecution(context.organizationId, execution.id, {
          status: snapshot.status,
          headSha: snapshot.headSha,
          queueItemId: snapshot.queueItemId,
          queueItemRevision: snapshot.queueItemRevision,
          contractId: snapshot.contractId,
          canonicalContractPath: snapshot.canonicalContractPath,
          factoryStatus: snapshot.factoryStatus,
          surfaces: snapshot.surfaces,
          impactedSurfaces: snapshot.impactedSurfaces,
          architectureUnits: snapshot.architectureUnits,
          signoffs: snapshot.signoffs,
          artifacts: snapshot.artifacts,
          finalizerReceipt: snapshot.finalizerReceipt,
          mergedCommitSha: snapshot.mergedCommitSha,
          lastObservedAt: new Date().toISOString(),
          failureCode: undefined,
          failureDetail: undefined,
        });
        repo.appendAuditEvent({
          context,
          workItemId: intent.workItemId,
          action: "factory_execution.reconciled",
          metadata: {
            factoryExecutionId: execution.id,
            implementationIntentId: intent.id,
            headSha: snapshot.headSha,
            contractId: snapshot.contractId,
            status: snapshot.status,
          },
        });
        return updated;
      } catch (error) {
        const errorCode =
          error instanceof DevFlowError ? error.errorCode : "factory_evidence_invalid";
        return repo.updateFactoryExecution(context.organizationId, execution.id, {
          status: "failed",
          failureCode: errorCode,
          failureDetail: failureMessage(error),
        });
      }
    },
  };
}
