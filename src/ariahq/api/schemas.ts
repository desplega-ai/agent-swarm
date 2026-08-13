import { z } from "zod";
import { ScheduledTaskSchema } from "../../types";
import {
  AriaClientIntakeSchema,
  AriaEngineDraftSchema,
  AriaEngineVersionSchema,
  AriaKnowledgeKindSchema,
  AriaKnowledgeRecordSchema,
  AriaKnowledgeSourceKindSchema,
  AriaKnowledgeSourceSchema,
  AriaKnowledgeSyncRunSchema,
  AriaSlackSurfaceSchema,
} from "../domain/types";

export const AriaHqErrorResponseSchema = z.object({
  error: z.string(),
  error_code: z.string(),
});

export const CreateEngineDraftBodySchema = z.object({
  name: z.string().min(1).max(120),
  brief: z.string().min(1).max(20_000),
});
export const EngineDraftResponseSchema = z.object({ draft: AriaEngineDraftSchema });
export const EngineCatalogResponseSchema = z.object({
  drafts: z.array(AriaEngineDraftSchema),
  engines: z.array(AriaEngineVersionSchema),
});
export const EngineVersionResponseSchema = z.object({ engine: AriaEngineVersionSchema });

export const IngestKnowledgeBodySchema = z.object({
  kind: AriaKnowledgeKindSchema,
  sourceKind: AriaKnowledgeSourceKindSchema,
  sourceRef: z.string().min(1),
  sourceRevision: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  audience: z.enum(["internal", "client"]),
  clientKey: z.string().min(1).optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  verificationStatus: z.enum(["raw", "verified", "conflicted"]),
  effectiveAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export const KnowledgeRecordResponseSchema = z.object({ record: AriaKnowledgeRecordSchema });
export const KnowledgeSearchBodySchema = z.object({
  question: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});
export const EvidenceItemSchema = z.object({
  recordId: z.string().uuid(),
  kind: AriaKnowledgeKindSchema,
  content: z.string(),
  verificationStatus: z.enum(["raw", "verified", "conflicted", "superseded"]),
  effectiveAt: z.string(),
  citation: z.string(),
});
export const KnowledgeAnswerResponseSchema = z.object({
  status: z.enum(["dispatched", "abstained"]),
  bundle: z.object({
    question: z.string(),
    audience: z.enum(["internal", "client"]),
    clientKey: z.string().optional(),
    evidence: z.array(EvidenceItemSchema),
    hasConflict: z.boolean(),
  }),
  taskId: z.string().uuid().optional(),
  message: z.string().optional(),
});

const KnowledgeSourceScheduleSchema = z
  .object({
    cronExpression: z.string().min(1).optional(),
    intervalMs: z.number().int().min(60_000).optional(),
    timezone: z.string().min(1).default("UTC"),
    enabled: z.boolean().default(true),
  })
  .superRefine((schedule, ctx) => {
    if (Boolean(schedule.cronExpression) === Boolean(schedule.intervalMs)) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of cronExpression or intervalMs",
      });
    }
  });

export const CreateKnowledgeSourceBodySchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(160),
    sourceKind: AriaKnowledgeSourceKindSchema,
    audience: z.enum(["internal", "client"]),
    clientKey: z.string().min(1).optional(),
    adapter: z.enum(["openapi", "webhook"]),
    connectionSlug: z.string().min(1).optional(),
    runAsAgentId: z.string().uuid(),
    syncConfig: z.record(z.string(), z.unknown()),
    schedule: KnowledgeSourceScheduleSchema.optional(),
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
    if (source.adapter === "webhook" && source.schedule) {
      ctx.addIssue({
        code: "custom",
        path: ["schedule"],
        message: "Webhook sources cannot have polling schedules",
      });
    }
  });
export const KnowledgeSourcesResponseSchema = z.object({
  sources: z.array(AriaKnowledgeSourceSchema),
});
export const KnowledgeSourceProvisionResponseSchema = z.object({
  source: AriaKnowledgeSourceSchema,
  schedule: ScheduledTaskSchema.optional(),
  webhookSecret: z.string().optional(),
});
export const KnowledgeSourceWebhookBodySchema = z.object({
  nextCursor: z.string().optional(),
  records: z
    .array(
      z.object({
        sourceRef: z.string().min(1),
        sourceRevision: z.string().min(1),
        sourceUrl: z.string().url().optional(),
        title: z.string().min(1),
        content: z.string().min(1),
        effectiveAt: z.string().datetime(),
        metadata: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .max(10_000),
});
export const KnowledgeSourceWebhookResponseSchema = z.object({
  run: AriaKnowledgeSyncRunSchema,
});

export const CreateSlackSurfaceBodySchema = AriaSlackSurfaceSchema.pick({
  name: true,
  workspaceId: true,
  channelId: true,
  audience: true,
  clientKey: true,
  captureMode: true,
  pmOwnerId: true,
});
export const SlackSurfacesResponseSchema = z.object({
  surfaces: z.array(AriaSlackSurfaceSchema),
});
export const ClientIntakesResponseSchema = z.object({
  intakes: z.array(AriaClientIntakeSchema),
});
