import { z } from "zod";

export const AriaEngineStageSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    kind: z.enum(["agent", "approval"]),
    objective: z.string().min(1),
    requiredEvidence: z.array(z.string().min(1)),
    tools: z.array(z.string().min(1)),
    next: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    approverRoles: z.array(z.string().min(1)).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((stage, ctx) => {
    if (stage.kind === "approval" && (!stage.approverRoles || stage.approverRoles.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["approverRoles"],
        message: "Approval stages require at least one approver role",
      });
    }
  });
export type AriaEngineStage = z.infer<typeof AriaEngineStageSchema>;

export const AriaEngineContractSchema = z
  .object({
    engineKey: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    objective: z.string().min(1),
    caseType: z.string().min(1),
    triggers: z.array(z.enum(["manual", "slack", "schedule", "webhook", "event"])).min(1),
    stages: z.array(AriaEngineStageSchema).min(1),
    knowledgePolicy: z.object({
      allowedSources: z.array(z.string().min(1)),
      requiredEvidence: z.array(z.string().min(1)),
      conflictPolicy: z.enum(["escalate", "abstain"]),
    }),
    actions: z.array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9-]*$/),
        description: z.string().min(1),
        externalWrite: z.boolean(),
        authority: z.array(z.string().min(1)),
      }),
    ),
    completionCriteria: z.array(z.string().min(1)).min(1),
    openQuestions: z.array(z.string().min(1)),
  })
  .superRefine((contract, ctx) => {
    const ids = new Set(contract.stages.map((stage) => stage.id));
    if (ids.size !== contract.stages.length) {
      ctx.addIssue({ code: "custom", path: ["stages"], message: "Stage ids must be unique" });
    }
    const incoming = new Map<string, number>();
    for (const stage of contract.stages) {
      if (stage.next && !ids.has(stage.next)) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", stage.id, "next"],
          message: `Unknown next stage ${stage.next}`,
        });
      }
      if (stage.next) incoming.set(stage.next, (incoming.get(stage.next) ?? 0) + 1);
    }
    const entries = contract.stages.filter((stage) => !incoming.has(stage.id));
    if (entries.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["stages"],
        message: "Engine contract must have exactly one entry stage",
      });
    }
  });
export type AriaEngineContract = z.infer<typeof AriaEngineContractSchema>;

export const AriaEngineDraftStatusSchema = z.enum(["queued", "running", "ready", "failed"]);
export const AriaEngineDraftSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string(),
  name: z.string(),
  brief: z.string(),
  status: AriaEngineDraftStatusSchema,
  swarmTaskId: z.string().optional(),
  proposedContract: AriaEngineContractSchema.optional(),
  errorMessage: z.string().optional(),
  createdByUserId: z.string(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type AriaEngineDraft = z.infer<typeof AriaEngineDraftSchema>;

export const AriaEngineVersionSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string(),
  draftId: z.string().uuid(),
  engineKey: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["published", "retired"]),
  contract: AriaEngineContractSchema,
  workflowId: z.string().uuid(),
  publishedByUserId: z.string(),
  publishedAt: z.string(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type AriaEngineVersion = z.infer<typeof AriaEngineVersionSchema>;

export const AriaKnowledgeKindSchema = z.enum([
  "source_evidence",
  "canonical_fact",
  "derived_insight",
]);
export const AriaKnowledgeSourceKindSchema = z.enum([
  "slack",
  "google_drive",
  "call_recording",
  "crm",
  "github",
  "manual",
  "ariahq",
]);
export const AriaKnowledgeRecordSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string(),
    kind: AriaKnowledgeKindSchema,
    sourceKind: AriaKnowledgeSourceKindSchema,
    sourceRef: z.string(),
    sourceRevision: z.string(),
    sourceUrl: z.string().optional(),
    audience: z.enum(["internal", "client"]),
    clientKey: z.string().optional(),
    title: z.string(),
    content: z.string(),
    verificationStatus: z.enum(["raw", "verified", "conflicted", "superseded"]),
    effectiveAt: z.string(),
    expiresAt: z.string().optional(),
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
  })
  .superRefine((record, ctx) => {
    if (record.audience === "client" && !record.clientKey) {
      ctx.addIssue({ code: "custom", path: ["clientKey"], message: "Client key is required" });
    }
    if (record.audience === "internal" && record.clientKey) {
      ctx.addIssue({
        code: "custom",
        path: ["clientKey"],
        message: "Internal records cannot carry a client key",
      });
    }
  });
export type AriaKnowledgeRecord = z.infer<typeof AriaKnowledgeRecordSchema>;

export const AriaKnowledgeSourceSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string(),
    key: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    sourceKind: AriaKnowledgeSourceKindSchema,
    audience: z.enum(["internal", "client"]),
    clientKey: z.string().min(1).optional(),
    adapter: z.enum(["openapi", "webhook"]),
    connectionSlug: z.string().min(1).optional(),
    runAsAgentId: z.string().uuid(),
    syncConfig: z.record(z.string(), z.unknown()),
    cursor: z.string().optional(),
    scheduleId: z.string().uuid().optional(),
    enabled: z.boolean(),
    lastSyncStatus: z.enum(["running", "completed", "failed"]).optional(),
    lastSyncAt: z.string().optional(),
    lastErrorMessage: z.string().optional(),
    createdByUserId: z.string(),
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
  })
  .superRefine((source, ctx) => {
    if (source.audience === "client" && !source.clientKey) {
      ctx.addIssue({ code: "custom", path: ["clientKey"], message: "Client key is required" });
    }
    if (source.audience === "internal" && source.clientKey) {
      ctx.addIssue({
        code: "custom",
        path: ["clientKey"],
        message: "Internal sources cannot carry a client key",
      });
    }
    if (source.adapter === "openapi" && !source.connectionSlug) {
      ctx.addIssue({
        code: "custom",
        path: ["connectionSlug"],
        message: "OpenAPI sources require a connection slug",
      });
    }
  });
export type AriaKnowledgeSource = z.infer<typeof AriaKnowledgeSourceSchema>;

export const AriaKnowledgeSyncRunSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  agentId: z.string().uuid(),
  status: z.enum(["running", "completed", "failed"]),
  cursorBefore: z.string().optional(),
  cursorAfter: z.string().optional(),
  recordsSeen: z.number().int().nonnegative(),
  recordsCreated: z.number().int().nonnegative(),
  recordsReused: z.number().int().nonnegative(),
  errorMessage: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type AriaKnowledgeSyncRun = z.infer<typeof AriaKnowledgeSyncRunSchema>;

export const AriaSlackSurfaceSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string(),
    name: z.string(),
    workspaceId: z.string(),
    channelId: z.string(),
    audience: z.enum(["internal", "client"]),
    clientKey: z.string().optional(),
    captureMode: z.enum(["mention_only", "designated_channel"]),
    pmOwnerId: z.string(),
    isActive: z.boolean(),
    verificationStatus: z.enum(["pending", "verified", "failed"]),
    verifiedAt: z.string().optional(),
    verificationError: z.string().optional(),
    createdByUserId: z.string(),
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
  })
  .superRefine((surface, ctx) => {
    if (surface.audience === "client" && !surface.clientKey) {
      ctx.addIssue({ code: "custom", path: ["clientKey"], message: "Client key is required" });
    }
    if (surface.audience === "internal" && surface.clientKey) {
      ctx.addIssue({
        code: "custom",
        path: ["clientKey"],
        message: "Internal surfaces cannot carry a client key",
      });
    }
  });
export type AriaSlackSurface = z.infer<typeof AriaSlackSurfaceSchema>;

export const AriaClientIntakeSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string(),
  slackSurfaceId: z.string().uuid(),
  workItemId: z.string().uuid(),
  messageTs: z.string(),
  threadTs: z.string(),
  externalUserId: z.string(),
  clientStatus: z.enum([
    "captured",
    "reviewing",
    "needs_information",
    "accepted",
    "in_progress",
    "released",
    "resolved",
    "closed",
  ]),
  publicSummary: z.string(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type AriaClientIntake = z.infer<typeof AriaClientIntakeSchema>;

export interface AriaHqContext {
  organizationId: string;
  actorKind: "user" | "agent" | "system" | "external";
  actorId?: string;
  audience: "internal" | "client";
  clientKey?: string;
}
