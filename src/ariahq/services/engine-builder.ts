import { z } from "zod";
import {
  type CreateTaskOptions,
  createTaskExtended,
  createWorkflow,
  getTaskById,
} from "../../be/db";
import type { AgentTask, Workflow, WorkflowDefinition } from "../../types";
import { getExecutorRegistry } from "../../workflows";
import { validateDefinition } from "../../workflows/definition";
import {
  AriaEngineContractSchema,
  type AriaEngineDraft,
  type AriaEngineVersion,
  type AriaHqContext,
} from "../domain/types";
import { buildEngineDraftPrompt } from "../prompts";
import type { AriaHqRepository } from "../repository";
import { compileEngineContract } from "./engine-compiler";

export interface EngineDraftTaskRuntime {
  create(prompt: string, options: CreateTaskOptions): AgentTask;
  get(id: string): AgentTask | null;
}

export interface EngineWorkflowRuntime {
  create(input: {
    name: string;
    description: string;
    definition: WorkflowDefinition;
    createdBy: string;
  }): Workflow;
}

export interface EngineBuilder {
  startDraft(context: AriaHqContext, input: { name: string; brief: string }): AriaEngineDraft;
  reconcileDraft(context: AriaHqContext, draftId: string): AriaEngineDraft;
  publishDraft(context: AriaHqContext, draftId: string): AriaEngineVersion;
}

function requireInternalUser(context: AriaHqContext): string {
  if (context.audience !== "internal" || context.actorKind !== "user" || !context.actorId) {
    throw new Error("AriaHQ engine authoring requires an authenticated internal user");
  }
  return context.actorId;
}

function parseContract(output: string | undefined) {
  if (!output) throw new Error("Engine task completed without a contract");
  let candidate: unknown;
  try {
    candidate = JSON.parse(output);
  } catch {
    throw new Error("Engine task returned a contract that is not valid JSON");
  }
  const result = AriaEngineContractSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Engine task returned an invalid contract: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

const defaultTaskRuntime: EngineDraftTaskRuntime = {
  create: createTaskExtended,
  get: getTaskById,
};

const defaultWorkflowRuntime: EngineWorkflowRuntime = {
  create(input) {
    return createWorkflow(input, "api");
  },
};

export function createEngineBuilder(input: {
  repo: AriaHqRepository;
  taskRuntime?: EngineDraftTaskRuntime;
  workflowRuntime?: EngineWorkflowRuntime;
}): EngineBuilder {
  const { repo } = input;
  const taskRuntime = input.taskRuntime ?? defaultTaskRuntime;
  const workflowRuntime = input.workflowRuntime ?? defaultWorkflowRuntime;

  return {
    startDraft(context, draftInput) {
      const userId = requireInternalUser(context);
      if (!draftInput.name.trim() || !draftInput.brief.trim()) {
        throw new Error("Engine name and brief are required");
      }
      const draft = repo.createEngineDraft({
        organizationId: context.organizationId,
        name: draftInput.name.trim(),
        brief: draftInput.brief.trim(),
        createdByUserId: userId,
      });
      try {
        const task = taskRuntime.create(buildEngineDraftPrompt(draftInput), {
          source: "api",
          taskType: "ariahq-engine-draft",
          tags: ["ariahq", "engine-builder", `organization:${context.organizationId}`],
          priority: 3,
          status: "unassigned",
          outputSchema: z.toJSONSchema(AriaEngineContractSchema) as Record<string, unknown>,
          requestedByUserId: userId,
          contextKey: `ariahq:engine-draft:${draft.id}`,
        });
        return repo.updateEngineDraft(context.organizationId, draft.id, {
          status: "running",
          swarmTaskId: task.id,
        });
      } catch (error) {
        repo.updateEngineDraft(context.organizationId, draft.id, {
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    reconcileDraft(context, draftId) {
      requireInternalUser(context);
      const draft = repo.getEngineDraft(context.organizationId, draftId);
      if (!draft) throw new Error("AriaHQ engine draft not found");
      if (draft.status === "ready" || draft.status === "failed") return draft;
      if (!draft.swarmTaskId) {
        return repo.updateEngineDraft(context.organizationId, draft.id, {
          status: "failed",
          errorMessage: "Engine draft has no contract task",
        });
      }
      const task = taskRuntime.get(draft.swarmTaskId);
      if (!task) {
        return repo.updateEngineDraft(context.organizationId, draft.id, {
          status: "failed",
          errorMessage: "Engine contract task was not found",
        });
      }
      if (["failed", "cancelled", "superseded"].includes(task.status)) {
        return repo.updateEngineDraft(context.organizationId, draft.id, {
          status: "failed",
          errorMessage: `Engine contract task ended with status ${task.status}`,
        });
      }
      if (task.status !== "completed") return draft;
      try {
        const contract = parseContract(task.output);
        return repo.updateEngineDraft(context.organizationId, draft.id, {
          status: "ready",
          proposedContract: contract,
        });
      } catch (error) {
        return repo.updateEngineDraft(context.organizationId, draft.id, {
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    },

    publishDraft(context, draftId) {
      const userId = requireInternalUser(context);
      const existing = repo.getEngineVersionByDraft(context.organizationId, draftId);
      if (existing) return existing;
      const draft = repo.getEngineDraft(context.organizationId, draftId);
      if (!draft) throw new Error("AriaHQ engine draft not found");
      if (draft.status !== "ready" || !draft.proposedContract) {
        throw new Error("AriaHQ engine draft is not ready to publish");
      }
      if (draft.proposedContract.openQuestions.length > 0) {
        throw new Error("AriaHQ engine draft has unresolved open questions");
      }
      const definition = compileEngineContract(draft.proposedContract);
      const validation = validateDefinition(definition, getExecutorRegistry());
      if (!validation.valid) {
        throw new Error(`Compiled AriaHQ workflow is invalid: ${validation.errors.join("; ")}`);
      }
      return repo.transaction(() => {
        const duplicate = repo.getEngineVersionByDraft(context.organizationId, draftId);
        if (duplicate) return duplicate;
        const workflow = workflowRuntime.create({
          name: `${draft.proposedContract!.name} (AriaHQ)`,
          description: draft.proposedContract!.objective,
          definition,
          createdBy: userId,
        });
        return repo.createEngineVersion({
          organizationId: context.organizationId,
          draftId: draft.id,
          contract: draft.proposedContract!,
          workflowId: workflow.id,
          publishedByUserId: userId,
        });
      });
    },
  };
}
