import { z } from "zod";

export const FactoryTaskCandidateSchema = z.strictObject({
  headSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  headRef: z.string().min(1).max(240),
  queueItemId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
  contractId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
  canonicalContractPath: z
    .string()
    .regex(/^\.dev_harness\/contracts\/[a-z0-9][a-z0-9_-]{0,127}\.json$/),
});
export type FactoryTaskCandidate = z.infer<typeof FactoryTaskCandidateSchema>;

export const FACTORY_TASK_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headSha", "headRef", "queueItemId", "contractId", "canonicalContractPath"],
  properties: {
    headSha: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
    headRef: { type: "string", minLength: 1, maxLength: 240 },
    queueItemId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,127}$" },
    contractId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,127}$" },
    canonicalContractPath: {
      type: "string",
      pattern: "^\\.dev_harness/contracts/[a-z0-9][a-z0-9_-]{0,127}\\.json$",
    },
  },
} as const;

export const FactoryUpstreamAuthoritySchema = z.strictObject({
  system: z.literal("devflow"),
  work_item_id: z.string().uuid(),
  artifact_type: z.literal("implementation_intent"),
  artifact_id: z.string().uuid(),
  artifact_version: z.number().int().positive(),
  artifact_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const FactoryContractSnapshotSchema = z.object({
  task: z.string(),
  contract_id: z.string(),
  canonical_contract_path: z.string(),
  queue_item_id: z.string(),
  owner: z.string(),
  surfaces: z.array(z.string()).min(1),
  impacted_surfaces: z.array(z.string()).default([]),
  architecture_units: z.record(z.string(), z.unknown()).default({}),
  upstream_authority: FactoryUpstreamAuthoritySchema,
  surface_signoffs: z.array(z.unknown()).default([]),
  artifacts: z.record(z.string(), z.unknown()).default({}),
  finalizer_admission: z.record(z.string(), z.unknown()).optional(),
  factory_status: z.string(),
});

export const FactoryQueueSnapshotSchema = z.object({
  item_id: z.string(),
  revision: z.string(),
  item: z.object({
    id: z.string(),
    status: z.string(),
    surfaces: z.array(z.string()).default([]),
    impacted_surfaces: z.array(z.string()).default([]),
  }),
});

export interface VerifiedFactorySnapshot {
  headSha: string;
  queueItemId: string;
  queueItemRevision: string;
  contractId: string;
  canonicalContractPath: string;
  factoryStatus: string;
  status:
    | "factory_intake"
    | "signoff_pending"
    | "ready"
    | "implementing"
    | "pr_open"
    | "finalizer_admitted"
    | "merged";
  surfaces: string[];
  impactedSurfaces: string[];
  architectureUnits: Record<string, unknown>;
  signoffs: unknown[];
  artifacts: Record<string, unknown>;
  finalizerReceipt?: Record<string, unknown>;
  mergedCommitSha?: string;
}
