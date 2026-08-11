import { z } from "zod";

export const DevFlowRoleSchema = z.enum([
  "admin",
  "pm_director",
  "pm",
  "engineering_lead",
  "architect",
  "senior_developer",
  "execution_lead",
  "qa",
  "viewer",
]);
export type DevFlowRole = z.infer<typeof DevFlowRoleSchema>;

export const DevFlowStateSchema = z.enum([
  "captured",
  "triaged",
  "scoped",
  "specced",
  "sized",
  "planned",
  "building",
  "in_review",
  "deployed",
  "monitoring",
  "done",
  "blocked",
  "archived",
]);
export type DevFlowState = z.infer<typeof DevFlowStateSchema>;

export const DevFlowWorkItemTypeSchema = z.enum([
  "idea",
  "feature",
  "bug",
  "task",
  "architecture",
  "ops",
]);
export type DevFlowWorkItemType = z.infer<typeof DevFlowWorkItemTypeSchema>;

export const DevFlowPrioritySchema = z.enum(["p1", "p2", "p3"]);
export type DevFlowPriority = z.infer<typeof DevFlowPrioritySchema>;
export const DevFlowBlastRadiusSchema = z.enum(["low", "medium", "high"]);
export type DevFlowBlastRadius = z.infer<typeof DevFlowBlastRadiusSchema>;
export const DevFlowCreatedViaSchema = z.enum([
  "manual",
  "slack",
  "fathom",
  "github",
  "email",
  "api",
]);
export type DevFlowCreatedVia = z.infer<typeof DevFlowCreatedViaSchema>;

export const DevFlowOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  settings: z.record(z.string(), z.unknown()),
  isActive: z.boolean(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type DevFlowOrganization = z.infer<typeof DevFlowOrganizationSchema>;

export const DevFlowMembershipSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
  role: DevFlowRoleSchema,
  isActive: z.boolean(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type DevFlowMembership = z.infer<typeof DevFlowMembershipSchema>;

export const DevFlowWorkItemSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: DevFlowWorkItemTypeSchema,
  state: DevFlowStateSchema,
  previousState: DevFlowStateSchema.optional(),
  blockerReason: z.string().optional(),
  archiveReason: z.string().optional(),
  title: z.string(),
  description: z.string(),
  priority: DevFlowPrioritySchema.optional(),
  storyPoints: z.number().int().optional(),
  sprintId: z.string().optional(),
  sprintProbability: z.number().optional(),
  blastRadius: DevFlowBlastRadiusSchema.optional(),
  isSecuritySensitive: z.boolean(),
  duplicateOf: z.string().optional(),
  duplicateConfidence: z.number().optional(),
  classificationRationale: z.string().optional(),
  pmOwnerId: z.string(),
  engineeringOwnerId: z.string().optional(),
  assignedToUserId: z.string().optional(),
  createdVia: DevFlowCreatedViaSchema,
  sourceMetadata: z.record(z.string(), z.unknown()),
  capturedAt: z.string(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type DevFlowWorkItem = z.infer<typeof DevFlowWorkItemSchema>;

export const DevFlowEffortBandSchema = z.enum(["xs", "s", "m", "l", "xl"]);
export const DevFlowScopeSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  workItemId: z.string(),
  problemStatement: z.string(),
  targetUsers: z.array(z.string()),
  successCriteria: z.array(z.string()),
  effortBand: DevFlowEffortBandSchema,
  openQuestions: z.array(z.string()),
  confidence: z.number(),
  rationale: z.string(),
  agentRunId: z.string().optional(),
  pmSignedOffAt: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type DevFlowScope = z.infer<typeof DevFlowScopeSchema>;

export const NFR_CATEGORIES = [
  "supportability",
  "testability",
  "security",
  "scalability",
  "usability",
  "maintainability",
  "reliability",
  "observability",
  "performance",
] as const;
export const DevFlowNfrCategorySchema = z.enum(NFR_CATEGORIES);
export type DevFlowNfrCategory = z.infer<typeof DevFlowNfrCategorySchema>;
export const DevFlowNfrStatusSchema = z.enum(["addressed", "not_applicable", "pending"]);

export const DevFlowAcceptanceCriterionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  specId: z.string(),
  given: z.string(),
  when: z.string(),
  // biome-ignore lint/suspicious/noThenProperty: Acceptance criteria deliberately use Given/When/Then terminology.
  then: z.string(),
  isTestable: z.boolean(),
  testHint: z.string(),
  testStatus: z.enum(["unverified", "passing", "failing", "skipped"]),
  linkedTestId: z.string().optional(),
});
export type DevFlowAcceptanceCriterion = z.infer<typeof DevFlowAcceptanceCriterionSchema>;

export const DevFlowNfrDeclarationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  specId: z.string(),
  category: DevFlowNfrCategorySchema,
  status: DevFlowNfrStatusSchema,
  statement: z.string(),
  reviewedAt: z.string().optional(),
});
export type DevFlowNfrDeclaration = z.infer<typeof DevFlowNfrDeclarationSchema>;

export const DevFlowSpecSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  workItemId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "approved"]),
  problemStatement: z.string(),
  userStories: z.string(),
  outOfScope: z.string(),
  uxBehavior: z.string(),
  dataModelChanges: z.string(),
  integrationPoints: z.string(),
  threatModel: z.string().optional(),
  rollbackPlan: z.string().optional(),
  dependencyMap: z.array(z.string()),
  openQuestions: z.array(z.string()),
  draftedByAgentRunId: z.string().optional(),
  approvedAt: z.string().optional(),
  acceptanceCriteria: z.array(DevFlowAcceptanceCriterionSchema),
  nfrDeclarations: z.array(DevFlowNfrDeclarationSchema),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type DevFlowSpec = z.infer<typeof DevFlowSpecSchema>;

export const DevFlowAgentModeSchema = z.enum(["intake", "scope", "spec"]);
export type DevFlowAgentMode = z.infer<typeof DevFlowAgentModeSchema>;
export const DevFlowAgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
]);
export const DevFlowAgentRunSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  workItemId: z.string(),
  mode: DevFlowAgentModeSchema,
  status: DevFlowAgentRunStatusSchema,
  swarmTaskId: z.string().optional(),
  workflowRunId: z.string().optional(),
  contractVersion: z.string(),
  promptVersion: z.string(),
  evidence: z.unknown().optional(),
  evidenceAppliedAt: z.string().optional(),
  latencyMs: z.number().int().optional(),
  costUsd: z.number().optional(),
  errorMessage: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type DevFlowAgentRun = z.infer<typeof DevFlowAgentRunSchema>;

export const DevFlowRepositoryTargetSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  repositoryFullName: z.string(),
  defaultBranch: z.string(),
  executionProfile: z.literal("command_center_factory"),
  checkoutPath: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type DevFlowRepositoryTarget = z.infer<typeof DevFlowRepositoryTargetSchema>;

export const DevFlowImplementationIntentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  workItemId: z.string(),
  specId: z.string(),
  specVersion: z.number().int().positive(),
  specDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  repositoryTargetId: z.string(),
  desiredOutcome: z.string(),
  priority: DevFlowPrioritySchema,
  riskSummary: z.string(),
  intentSnapshot: z.record(z.string(), z.unknown()),
  createdByUserId: z.string(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type DevFlowImplementationIntent = z.infer<typeof DevFlowImplementationIntentSchema>;

export const DevFlowFactoryExecutionStatusSchema = z.enum([
  "queued",
  "factory_intake",
  "signoff_pending",
  "ready",
  "implementing",
  "pr_open",
  "finalizer_admitted",
  "merged",
  "failed",
  "cancelled",
]);
export type DevFlowFactoryExecutionStatus = z.infer<typeof DevFlowFactoryExecutionStatusSchema>;

export const DevFlowFactoryExecutionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  implementationIntentId: z.string(),
  status: DevFlowFactoryExecutionStatusSchema,
  swarmTaskId: z.string().optional(),
  headSha: z.string().optional(),
  queueItemId: z.string().optional(),
  queueItemRevision: z.string().optional(),
  contractId: z.string().optional(),
  canonicalContractPath: z.string().optional(),
  factoryStatus: z.string().optional(),
  surfaces: z.array(z.string()),
  impactedSurfaces: z.array(z.string()),
  architectureUnits: z.record(z.string(), z.unknown()),
  signoffs: z.array(z.unknown()),
  artifacts: z.unknown(),
  pullRequest: z.record(z.string(), z.unknown()).optional(),
  finalizerReceipt: z.record(z.string(), z.unknown()).optional(),
  mergedCommitSha: z.string().optional(),
  lastObservedAt: z.string().optional(),
  failureCode: z.string().optional(),
  failureDetail: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type DevFlowFactoryExecution = z.infer<typeof DevFlowFactoryExecutionSchema>;

export interface DevFlowContext {
  organizationId: string;
  actorKind: "user" | "agent" | "system";
  actorId?: string;
  correlationId?: string;
}
