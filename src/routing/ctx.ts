import {
  type CreateTaskOptions,
  getActiveTaskCount,
  getAgentById,
  getAllAgents,
  getTaskById,
} from "../be/db";
import type { AgentTask } from "../types";
import { type RoutingCtx, RoutingCtxSchema, type RoutingTask, type RoutingVia } from "./types";

const MAX_CONTINUITY_DEPTH = 20;

export type EffectiveTaskOptions = {
  description: string;
  options?: CreateTaskOptions;
};

export interface BuildRoutingCtxOptions {
  /** The agent the current caller would select, such as a claim candidate. */
  proposedAgentId?: string;
}

function isTaskRow(input: EffectiveTaskOptions | AgentTask): input is AgentTask {
  return "task" in input && "status" in input && "createdAt" in input;
}

function routingTaskFromInput(input: EffectiveTaskOptions | AgentTask): RoutingTask {
  if (isTaskRow(input)) {
    return {
      id: input.id,
      description: input.task,
      source: input.source,
      taskType: input.taskType,
      tags: input.tags,
      parentTaskId: input.parentTaskId,
      modelTier: input.modelTier,
      priority: input.priority,
      routingAffinity: input.routingAffinity,
      slackChannelId: input.slackChannelId,
      slackThreadTs: input.slackThreadTs,
      vcsProvider: input.vcsProvider,
      vcsRepo: input.vcsRepo,
      contextKey: input.contextKey,
    };
  }

  const options = input.options;
  return {
    description: input.description,
    source: options?.source ?? "mcp",
    taskType: options?.taskType,
    tags: options?.tags ?? [],
    parentTaskId: options?.parentTaskId,
    modelTier: options?.modelTier,
    priority: options?.priority ?? 50,
    routingAffinity: options?.routingAffinity,
    slackChannelId: options?.slackChannelId,
    slackThreadTs: options?.slackThreadTs,
    vcsProvider: options?.vcsProvider,
    vcsRepo: options?.vcsRepo,
    contextKey: options?.contextKey,
  };
}

function proposedAgentFromInput(input: EffectiveTaskOptions | AgentTask): string | undefined {
  if (isTaskRow(input)) return input.agentId ?? undefined;
  return input.options?.agentId ?? undefined;
}

function buildContinuity(parentTaskId: string | undefined): RoutingCtx["continuity"] {
  const immediateParent = parentTaskId ? getTaskById(parentTaskId) : null;
  const parentAgent =
    immediateParent?.agentId != null ? getAgentById(immediateParent.agentId) : null;

  let chainDepth = 0;
  let nextParentTaskId = parentTaskId;
  const visited = new Set<string>();
  while (nextParentTaskId && chainDepth < MAX_CONTINUITY_DEPTH && !visited.has(nextParentTaskId)) {
    visited.add(nextParentTaskId);
    const ancestor = getTaskById(nextParentTaskId);
    if (!ancestor) break;
    chainDepth += 1;
    nextParentTaskId = ancestor.parentTaskId;
  }

  return {
    parent: immediateParent
      ? {
          id: immediateParent.id,
          agentId: immediateParent.agentId,
          agentRole: parentAgent?.role ?? immediateParent.routingAffinity?.role,
          description: immediateParent.task,
          status: immediateParent.status,
        }
      : null,
    chainDepth,
  };
}

export function buildRoutingCtx(
  via: RoutingVia,
  effectiveOptionsOrTaskRow: EffectiveTaskOptions | AgentTask,
  opts: BuildRoutingCtxOptions = {},
): RoutingCtx {
  const task = routingTaskFromInput(effectiveOptionsOrTaskRow);
  const ctx: RoutingCtx = {
    via,
    task,
    proposedAgentId: opts.proposedAgentId ?? proposedAgentFromInput(effectiveOptionsOrTaskRow),
    candidates: getAllAgents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      capabilities: agent.capabilities,
      status: agent.status,
      isLead: agent.isLead,
      activeTaskCount: getActiveTaskCount(agent.id),
      maxTasks: agent.maxTasks,
    })),
    continuity: buildContinuity(task.parentTaskId),
  };

  return RoutingCtxSchema.parse(ctx);
}
