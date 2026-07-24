import { z } from "zod";
import {
  AgentSchema,
  AgentTaskSchema,
  AgentTaskSourceSchema,
  AgentTaskStatusSchema,
  ModelTierSchema,
  RoutingAffinitySchema,
} from "../types";

export const RoutingViaSchema = z.enum(["creation", "delegation", "claim", "resume", "completion"]);
export type RoutingVia = z.infer<typeof RoutingViaSchema>;

export const RoutingTaskSchema = z.object({
  id: AgentTaskSchema.shape.id.optional(),
  description: AgentTaskSchema.shape.task,
  source: AgentTaskSourceSchema,
  taskType: AgentTaskSchema.shape.taskType,
  tags: AgentTaskSchema.shape.tags,
  parentTaskId: AgentTaskSchema.shape.parentTaskId,
  modelTier: ModelTierSchema.optional(),
  priority: AgentTaskSchema.shape.priority,
  routingAffinity: RoutingAffinitySchema.optional(),
  slackChannelId: AgentTaskSchema.shape.slackChannelId,
  slackThreadTs: AgentTaskSchema.shape.slackThreadTs,
  vcsProvider: AgentTaskSchema.shape.vcsProvider,
  vcsRepo: AgentTaskSchema.shape.vcsRepo,
  contextKey: AgentTaskSchema.shape.contextKey,
});
export type RoutingTask = z.infer<typeof RoutingTaskSchema>;

export const RoutingCandidateSchema = z.object({
  id: AgentSchema.shape.id,
  name: AgentSchema.shape.name,
  role: AgentSchema.shape.role,
  capabilities: AgentSchema.shape.capabilities,
  status: AgentSchema.shape.status,
  isLead: AgentSchema.shape.isLead,
  activeTaskCount: z.number().int().nonnegative(),
  maxTasks: AgentSchema.shape.maxTasks,
});
export type RoutingCandidate = z.infer<typeof RoutingCandidateSchema>;

export const RoutingContinuityParentSchema = z.object({
  id: AgentTaskSchema.shape.id,
  agentId: AgentTaskSchema.shape.agentId,
  agentRole: AgentSchema.shape.role,
  description: AgentTaskSchema.shape.task,
  status: AgentTaskStatusSchema,
});
export type RoutingContinuityParent = z.infer<typeof RoutingContinuityParentSchema>;

export const RoutingCtxSchema = z.object({
  via: RoutingViaSchema,
  task: RoutingTaskSchema,
  proposedAgentId: AgentSchema.shape.id.optional(),
  candidates: z.array(RoutingCandidateSchema),
  continuity: z.object({
    parent: RoutingContinuityParentSchema.nullable(),
    chainDepth: z.number().int().nonnegative().max(20),
  }),
});
export type RoutingCtx = z.infer<typeof RoutingCtxSchema>;

export const RoutingResultSchema = z.object({
  assignTo: AgentSchema.shape.id.optional(),
  block: z
    .object({
      reason: z.string().min(1),
    })
    .optional(),
  mutate: z
    .object({
      tags: AgentTaskSchema.shape.tags.optional(),
      routingAffinity: RoutingAffinitySchema.optional(),
      modelTier: ModelTierSchema.optional(),
      priority: AgentTaskSchema.shape.priority.optional(),
    })
    .optional(),
  promptDirectives: z.array(z.string()).optional(),
  note: z.string().optional(),
});
export type RoutingResult = z.infer<typeof RoutingResultSchema>;

export function isDecisive(result: RoutingResult): boolean {
  return result.assignTo !== undefined || result.block !== undefined;
}
