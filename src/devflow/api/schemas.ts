import { z } from "zod";
import {
  DevFlowAcceptanceCriterionSchema,
  DevFlowAgentModeSchema,
  DevFlowAgentRunSchema,
  DevFlowBlastRadiusSchema,
  DevFlowCreatedViaSchema,
  DevFlowEffortBandSchema,
  DevFlowMembershipSchema,
  DevFlowNfrDeclarationSchema,
  DevFlowNfrStatusSchema,
  DevFlowOrganizationSchema,
  DevFlowPrioritySchema,
  DevFlowScopeSchema,
  DevFlowSpecSchema,
  DevFlowStateSchema,
  DevFlowWorkItemSchema,
  DevFlowWorkItemTypeSchema,
} from "../domain/types";

export const DevFlowErrorResponseSchema = z.object({
  error: z.string(),
  error_code: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const CurrentOrganizationResponseSchema = z.object({
  organization: DevFlowOrganizationSchema,
  membership: DevFlowMembershipSchema,
});

export const WorkItemListResponseSchema = z.object({
  items: z.array(DevFlowWorkItemSchema),
  total: z.number().int(),
  nextOffset: z.number().int().optional(),
});

export const WorkItemDetailResponseSchema = z.object({
  item: DevFlowWorkItemSchema,
  scope: DevFlowScopeSchema.nullable(),
  spec: DevFlowSpecSchema.nullable(),
  agentRuns: z.array(DevFlowAgentRunSchema),
  audit: z.array(
    z.object({
      id: z.string(),
      organizationId: z.string(),
      workItemId: z.string().optional(),
      actorKind: z.enum(["user", "agent", "system"]),
      actorId: z.string().optional(),
      action: z.string(),
      beforeState: DevFlowStateSchema.optional(),
      afterState: DevFlowStateSchema.optional(),
      metadata: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
    }),
  ),
});

export const GateDecisionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  workItemId: z.string(),
  gate: z.number().int(),
  decision: z.enum(["approved", "rejected", "timeout"]),
  actorUserId: z.string(),
  actorRole: z.string(),
  rationale: z.string(),
  preconditionSnapshot: z.record(z.string(), z.unknown()),
  approvalRequestId: z.string().optional(),
  decidedAt: z.string(),
});

export const CreateWorkItemBodySchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1),
  type: DevFlowWorkItemTypeSchema.optional(),
  priority: DevFlowPrioritySchema.optional(),
  createdVia: DevFlowCreatedViaSchema.default("manual"),
  sourceMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateWorkItemBodySchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    description: z.string().min(1).optional(),
    type: DevFlowWorkItemTypeSchema.optional(),
    priority: DevFlowPrioritySchema.optional(),
    blastRadius: DevFlowBlastRadiusSchema.optional(),
    isSecuritySensitive: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );

export const TransitionBodySchema = z.object({
  toState: DevFlowStateSchema,
  rationale: z.string().min(1),
  blockerReason: z.string().min(1).optional(),
  archiveReason: z.string().min(1).optional(),
});

export const ScopeBodySchema = z.object({
  problemStatement: z.string().min(1),
  targetUsers: z.array(z.string().min(1)).min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
  effortBand: DevFlowEffortBandSchema,
  openQuestions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

export const AcceptanceCriterionInputSchema =
  DevFlowAcceptanceCriterionSchema.pick({
    given: true,
    when: true,
    then: true,
    isTestable: true,
    testHint: true,
  });

export const NfrDeclarationInputSchema = z.object({
  category: DevFlowNfrDeclarationSchema.shape.category,
  status: DevFlowNfrStatusSchema,
  statement: z.string().min(1),
});

export const SpecBodySchema = z.object({
  problemStatement: z.string().min(1),
  outOfScope: z.string(),
  uxBehavior: z.string().min(1),
  dataModelChanges: z.string().min(1),
  integrationPoints: z.string().min(1),
  threatModel: z.string().min(1).optional(),
  rollbackPlan: z.string().optional(),
  dependencyMap: z.array(z.string()),
  openQuestions: z.array(z.string()),
  acceptanceCriteria: z.array(AcceptanceCriterionInputSchema).min(1),
  nfrDeclarations: z.array(NfrDeclarationInputSchema),
  blastRadius: DevFlowBlastRadiusSchema,
});

export const StartAgentRunBodySchema = z.object({
  mode: DevFlowAgentModeSchema,
});

export const ScopeResponseSchema = z.object({
  scope: DevFlowScopeSchema.nullable(),
});
export const SpecResponseSchema = z.object({
  spec: DevFlowSpecSchema.nullable(),
});
export const AgentRunsResponseSchema = z.object({
  runs: z.array(DevFlowAgentRunSchema),
});
export const AuditResponseSchema = WorkItemDetailResponseSchema.pick({
  audit: true,
});
