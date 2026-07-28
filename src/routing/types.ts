import { z } from "zod";
import {
  AgentSchema,
  AgentTaskSchema,
  AgentTaskSourceSchema,
  AgentTaskStatusSchema,
  ModelTierSchema,
  RoutingAffinitySchema,
} from "../types";

export const RoutingViaSchema = z.enum([
  "creation",
  "delegation",
  "claim",
  "resume",
  "completion",
  "prompt",
]);
export type RoutingVia = z.infer<typeof RoutingViaSchema>;

/**
 * Caps on handler-authored prompt text. Sized so even a fully saturated
 * directive set (20 × 2000 ≈ 40 KB) stays well inside base-prompt's
 * BOOTSTRAP_TOTAL_MAX_CHARS (120 KB) alongside the rest of the prompt.
 */
export const MAX_PROMPT_DIRECTIVE_CHARS = 2_000;
export const MAX_PROMPT_DIRECTIVES = 20;
export const MAX_ROUTING_NOTE_CHARS = 2_000;

// Id fields are plain strings, not z.uuid(): agents/tasks created through
// tests and some ingresses carry non-UUID ids, and the routing contract must
// accept whatever the DB actually holds.
export const RoutingTaskSchema = z.object({
  id: z.string().min(1).optional(),
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
  id: z.string().min(1),
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
  id: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  agentRole: AgentSchema.shape.role,
  description: AgentTaskSchema.shape.task,
  status: AgentTaskStatusSchema,
});
export type RoutingContinuityParent = z.infer<typeof RoutingContinuityParentSchema>;

export const RoutingCtxSchema = z.object({
  via: RoutingViaSchema,
  task: RoutingTaskSchema,
  proposedAgentId: z.string().min(1).optional(),
  candidates: z.array(RoutingCandidateSchema),
  continuity: z.object({
    parent: RoutingContinuityParentSchema.nullable(),
    chainDepth: z.number().int().nonnegative().max(20),
  }),
});
export type RoutingCtx = z.infer<typeof RoutingCtxSchema>;

export const RoutingResultSchema = z
  .object({
    assignTo: z.string().min(1).optional(),
    /**
     * Drop any inherited/proposed pin and send the task to the unassigned pool.
     *
     * `assignTo` alone cannot express "not this agent": callers default
     * `agentId` to the parent's worker BEFORE routing runs, and the engine only
     * ever overwrites that value. Without this, a handler that decides a
     * follow-up is a different kind of work could only emit advice — which then
     * reaches the very worker it wanted to route away from.
     *
     * Honoured at creation/delegation/resume. Ignored at via=claim, where the
     * task is already pooled and there is no pin to drop.
     */
    unassign: z.boolean().optional(),
    block: z
      .object({
        // Bounded for the same reason as promptDirectives: a SOFT block is
        // stored as a routing suggestion and later interpolated into the
        // protected routing-guidance section of the system prompt.
        reason: z.string().min(1).max(MAX_ROUTING_NOTE_CHARS),
      })
      .strict()
      .optional(),
    mutate: z
      .object({
        tags: AgentTaskSchema.shape.tags.optional(),
        routingAffinity: RoutingAffinitySchema.optional(),
        modelTier: ModelTierSchema.optional(),
        priority: AgentTaskSchema.shape.priority.optional(),
      })
      .strict()
      .optional(),
    /**
     * Bounded on purpose. `base-prompt.ts` renders these verbatim into the
     * system prompt BEFORE the 120k budget is computed, so an unbounded
     * directive from a misconfigured handler becomes protected prompt text —
     * a multi-megabyte prompt that blows provider context limits (and
     * MAX_ARG_STRLEN) and stops every matching task from starting. Rejecting
     * at the schema fails the handler open instead, which is recoverable.
     */
    promptDirectives: z
      .array(z.string().max(MAX_PROMPT_DIRECTIVE_CHARS))
      .max(MAX_PROMPT_DIRECTIVES)
      .optional(),
    note: z.string().max(MAX_ROUTING_NOTE_CHARS).optional(),
  })
  .strict()
  .refine((result) => !(result.unassign && result.assignTo), {
    message: "`unassign` and `assignTo` are mutually exclusive",
    path: ["unassign"],
  });
export type RoutingResult = z.infer<typeof RoutingResultSchema>;

export function isDecisive(result: RoutingResult): boolean {
  return result.assignTo !== undefined || result.block !== undefined || result.unassign === true;
}

export interface RoutingSuggestion {
  handlerName: string;
  assignTo?: string;
  unassign?: boolean;
  block?: { reason: string };
}

export interface RoutingDecisionTrace {
  handlerId: string;
  handlerName: string;
  flavor: "route" | "guard";
  mode: "soft" | "hard";
  result?: RoutingResult;
  decisive: boolean;
  suggestion?: string;
  error?: string;
  durationMs: number;
}

export interface RoutingDecision {
  final?: RoutingResult;
  suggestions: RoutingSuggestion[];
  mutations: NonNullable<RoutingResult["mutate"]>;
  promptDirectives: string[];
  notes: string[];
  routingRunId: string;
  trace: RoutingDecisionTrace[];
}
