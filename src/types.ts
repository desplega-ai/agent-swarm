import * as z from "zod";
import { normalizeAssetKey } from "./assets/key";
// ─── Asset namespaces ──────────────────────────────────────────────────────

export const AssetKeySchema = z
  .string()
  .min(1)
  .max(255)
  .superRefine((value, ctx) => {
    try {
      normalizeAssetKey(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid asset namespace key",
      });
    }
  })
  .describe(
    "Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form.",
  );

export const AssetEntityTypeSchema = z.enum(["task", "workflow", "schedule", "page", "file"]);
export type AssetEntityType = z.infer<typeof AssetEntityTypeSchema>;

export const AssetProviderRefSchema = z.object({
  providerId: z.string(),
  orgId: z.string().optional(),
  driveId: z.string().optional(),
  providerKey: z.string(),
});
export type AssetProviderRef = z.infer<typeof AssetProviderRefSchema>;

export const AssetKeyMappingSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  providerOrgId: z.string().optional(),
  providerDriveId: z.string().optional(),
  providerKey: z.string(),
  key: AssetKeySchema,
  sourceEntityType: z.enum(["task-attachment", "external"]).optional(),
  sourceEntityId: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type AssetKeyMapping = z.infer<typeof AssetKeyMappingSchema>;

export const AssetSummarySchema = z.object({
  entityType: AssetEntityTypeSchema,
  id: z.string(),
  key: AssetKeySchema,
  label: z.string(),
  updatedAt: z.string(),
  providerRef: AssetProviderRefSchema.optional(),
});
export type AssetSummary = z.infer<typeof AssetSummarySchema>;

// ─── Model Tiers ─────────────────────────────────────────────────────────────
// Merged from the former `src/model-tiers.ts` to dissolve the benign
// `types` ↔ `model-tiers` import cycle (cycle-break #1; prep for the
// `@swarm/types` monorepo package). `ModelTierSchema` is a runtime VALUE that is
// referenced later in this file (e.g. the task/schedule schemas), so this
// section must stay above its first use. `ProviderName` is referenced only as a
// TYPE below; it is declared further down this same module and type references
// are hoisted, so the forward reference is safe.

export const ModelTierSchema = z.enum(["smol", "regular", "smart", "ultra"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const MODEL_TIERS = ModelTierSchema.options;

/**
 * Normalized reasoning/effort levels. Mirrors `REASONING_EFFORT_LEVELS` in
 * `src/providers/reasoning-effort.ts` (the source of truth for capability
 * resolution + per-harness translation) as a literal enum so this
 * foundational, dependency-free module doesn't need a cross-directory import.
 * Keep the two lists in sync — see
 * `thoughts/taras/plans/2026-07-01-agent-reasoning-effort-runtime-control.md`.
 */
export const ReasoningEffortSchema = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const LEGACY_MODEL_TO_TIER: Record<string, ModelTier> = {
  haiku: "smol",
  sonnet: "regular",
  opus: "smart",
  fable: "ultra",
};

export const MODEL_TIER_LABELS: Record<ModelTier, string> = {
  smol: "Smol",
  regular: "Regular",
  smart: "Smart",
  ultra: "Ultra",
};

export const DEFAULT_MODEL_TIER_MAP: Record<ProviderName, Record<ModelTier, string>> = {
  claude: {
    smol: "haiku",
    regular: "sonnet",
    smart: "opus",
    ultra: "fable",
  },
  "claude-managed": {
    smol: "claude-haiku-4-5",
    regular: "claude-sonnet-5",
    smart: "claude-opus-4-8",
    ultra: "claude-fable-5",
  },
  codex: {
    smol: "gpt-5.6-luna",
    regular: "gpt-5.6-terra",
    smart: "gpt-5.6-sol",
    ultra: "gpt-5.6-sol",
  },
  pi: {
    smol: "openrouter/deepseek/deepseek-v4-flash",
    regular: "openrouter/deepseek/deepseek-v4-flash",
    smart: "openrouter/deepseek/deepseek-v4-pro",
    ultra: "openrouter/anthropic/claude-opus-4.8",
  },
  opencode: {
    smol: "openrouter/deepseek/deepseek-v4-flash",
    regular: "openrouter/deepseek/deepseek-v4-flash",
    smart: "openrouter/deepseek/deepseek-v4-pro",
    ultra: "openrouter/anthropic/claude-opus-4.8",
  },
  devin: {
    smol: "devin",
    regular: "devin",
    smart: "devin",
    ultra: "devin",
  },
};

export function parseModelTier(value: string | null | undefined): ModelTier | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return ModelTierSchema.safeParse(normalized).success
    ? (normalized as ModelTier)
    : LEGACY_MODEL_TO_TIER[normalized];
}

export function splitLegacyModelAlias(input: {
  model?: string | null;
  modelTier?: string | null;
}): { model?: string; modelTier?: ModelTier } {
  const explicitTier = parseModelTier(input.modelTier);
  const model = input.model?.trim();
  if (!model) return { modelTier: explicitTier };

  const legacyTier = parseModelTier(model);
  if (legacyTier && !explicitTier) {
    return { modelTier: legacyTier };
  }

  return {
    model,
    modelTier: explicitTier,
  };
}

function parseTierMapJson(value: string | undefined): Partial<Record<ModelTier, string>> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Partial<Record<ModelTier, string>> = {};
    for (const tier of MODEL_TIERS) {
      const model = (parsed as Record<string, unknown>)[tier];
      if (typeof model === "string" && model.trim()) result[tier] = model.trim();
    }
    return result;
  } catch {
    return {};
  }
}

export function resolveModelTier(opts: {
  tier?: string | null;
  harnessProvider: ProviderName;
  env?: Record<string, string | undefined>;
}): string | undefined {
  const tier = parseModelTier(opts.tier);
  if (!tier) return undefined;

  const env = opts.env ?? {};
  const jsonOverrides = parseTierMapJson(env.MODEL_TIER_MAP);
  const envKey = `MODEL_TIER_${tier.toUpperCase()}`;
  const directOverride = env[envKey]?.trim();
  if (directOverride) return directOverride;
  if (jsonOverrides[tier]) return jsonOverrides[tier];

  return DEFAULT_MODEL_TIER_MAP[opts.harnessProvider]?.[tier];
}

export function resolveTaskModelSelection(opts: {
  model?: string | null;
  modelTier?: string | null;
  harnessProvider: ProviderName;
  env?: Record<string, string | undefined>;
}): { model?: string; source: "model" | "modelTier" | "none" } {
  const model = opts.model?.trim();
  if (model) return { model, source: "model" };

  const tierModel = resolveModelTier({
    tier: opts.modelTier,
    harnessProvider: opts.harnessProvider,
    env: opts.env,
  });
  if (tierModel) return { model: tierModel, source: "modelTier" };

  return { source: "none" };
}
// ─── End Model Tiers ─────────────────────────────────────────────────────────

// Task status - includes new unassigned and offered states
export const AgentTaskStatusSchema = z.enum([
  "backlog", // Task is in backlog, not yet ready for pool
  "unassigned", // Task pool - no owner yet
  "offered", // Offered to agent, awaiting accept/reject
  "reviewing", // Agent is reviewing an offered task
  "pending", // Assigned/accepted, waiting to start
  "in_progress",
  "paused", // Interrupted by graceful shutdown (legacy), can resume
  "completed",
  "failed",
  "cancelled", // Task was cancelled by lead or creator
  "superseded", // Original terminated, replaced by a follow-up "resume" task
]);

/**
 * Terminal task statuses — a task in one of these is done. No further state
 * transitions, no re-assignment, no follow-up creation on the same id.
 *
 * Single source of truth for JS-side checks (sync handlers, store-progress,
 * db mutator guards, HTTP cancel guard).
 *
 * **SQL drift watch**: `src/be/db.ts` has ~8 prepared statements that inline
 * these strings — SQL can't import a TS const. When adding a new terminal
 * status, grep across `src/be/db.ts` for:
 *   - `status NOT IN ('completed'` — non-terminal filters (findTaskByVcs,
 *     findRecentSimilarTasks, mutator guards, hasNonTerminalChildTask)
 *   - `status IN ('completed', 'failed'` — intent-terminal lookups
 *   - `status = CASE WHEN status IN ('completed'` — setProgress guard
 * and update every site.
 */
export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled", "superseded"] as const;
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

export function isTerminalTaskStatus(status: string): status is TerminalTaskStatus {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

// ============================================================================
// Lead Inbox Types
// ============================================================================

export const InboxMessageStatusSchema = z.enum([
  "unread",
  "processing",
  "read",
  "responded",
  "delegated",
]);

export const InboxMessageSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(), // Lead agent who received this
  content: z.string().min(1), // The message content
  source: z.enum(["slack", "agentmail"]).default("slack"),
  status: InboxMessageStatusSchema.default("unread"),

  // Slack context (for replying)
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackUserId: z.string().optional(),

  // Routing info
  matchedText: z.string().optional(), // Why it was routed here

  // Delegation tracking
  delegatedToTaskId: z.uuid().optional(), // If delegated, which task
  responseText: z.string().optional(), // If responded directly

  // Timestamps
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
});

export type InboxMessageStatus = z.infer<typeof InboxMessageStatusSchema>;
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

export const AgentTaskSourceSchema = z.enum([
  "mcp",
  "slack",
  "api",
  "ui",
  "github",
  "gitlab",
  "agentmail",
  "system",
  "schedule",
  "workflow",
  "linear",
  "jira",
]);
export type AgentTaskSource = z.infer<typeof AgentTaskSourceSchema>;

// ---------------------------------------------------------------------------
// Harness Provider
// ---------------------------------------------------------------------------
// String identifiers accepted by `HARNESS_PROVIDER` and the
// `createProviderAdapter` factory in `src/providers/index.ts`. Keep this in
// sync with the factory's switch and the unknown-provider error message.
export const ProviderNameSchema = z.enum([
  "claude",
  "codex",
  "pi",
  "devin",
  "claude-managed",
  "opencode",
]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export type DevinProviderMeta = {
  sessionUrl: string;
  maxAcuLimit?: number;
  acuCostUsd?: number;
};

// These providers do not have metadata yet.
type NoProviderMeta = Record<string, never>;

export type ProviderMetaMap = {
  devin: DevinProviderMeta;
  claude: NoProviderMeta;
  codex: NoProviderMeta;
  pi: NoProviderMeta;
  "claude-managed": NoProviderMeta;
  opencode: NoProviderMeta;
};

export const FollowUpConfigSchema = z.object({
  disabled: z.boolean().optional(),
  onCompleted: z.string().max(4000).optional(),
  onFailed: z.string().max(4000).optional(),
});
export type FollowUpConfig = z.infer<typeof FollowUpConfigSchema>;

// Routing-affinity snapshot for interrupted/pooled tasks (routing-affinity
// follow-up to DES-523). Always written/read as a whole JSON blob — never
// three separate scalar columns. `role` is snapshotted from the ORIGINAL
// assignee at interruption time (or omitted for a fresh pool task that only
// declares `capabilities`); `harnessProvider` is informational only (native
// session resume is deprecated, so it is never enforced by the eligibility
// gate). See `isAgentEligibleForTask` in `src/be/db.ts`.
export const RoutingAffinitySchema = z.object({
  sourceAgentId: z.uuid().optional(),
  role: z.string().max(100).optional(),
  harnessProvider: ProviderNameSchema.optional(),
  capabilities: z.array(z.string()).default([]),
});
export type RoutingAffinity = z.infer<typeof RoutingAffinitySchema>;

export const AgentTaskSchema = z.object({
  id: z.uuid(),
  key: AssetKeySchema,
  agentId: z.uuid().nullable(), // Nullable for unassigned tasks
  creatorAgentId: z.uuid().optional(), // Who created this task (optional for Slack/API)
  task: z.string().min(1),
  status: AgentTaskStatusSchema,
  source: AgentTaskSourceSchema.default("mcp"),

  // Task metadata
  taskType: z.string().max(50).optional(), // e.g., "bug", "feature", "chore"
  tags: z.array(z.string()).default([]), // e.g., ["urgent", "frontend"]
  priority: z.number().int().min(0).max(100).default(50),
  dependsOn: z.array(z.uuid()).default([]), // Task IDs this depends on

  // Acceptance tracking
  offeredTo: z.uuid().optional(), // Agent the task was offered to
  offeredAt: z.iso.datetime().optional(),
  acceptedAt: z.iso.datetime().optional(),
  rejectionReason: z.string().optional(),

  // Timestamps
  createdAt: z.iso.datetime().default(() => new Date().toISOString()),
  lastUpdatedAt: z.iso.datetime().default(() => new Date().toISOString()),
  finishedAt: z.iso.datetime().optional(),
  notifiedAt: z.iso.datetime().optional(),

  // Completion data
  failureReason: z.string().optional(),
  output: z.string().optional(),
  progress: z.string().optional(),

  // Slack-specific metadata (optional)
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackUserId: z.string().optional(),
  slackReplySent: z.boolean().default(false),
  slackProgressMessageTs: z.string().optional(),
  slackTreeRootMessageTs: z.string().optional(),

  // VCS metadata (GitHub / GitLab — provider-agnostic)
  vcsProvider: z.enum(["github", "gitlab"]).optional(),
  vcsRepo: z.string().optional(),
  vcsEventType: z.string().optional(),
  vcsNumber: z.number().int().optional(),
  vcsCommentId: z.number().int().optional(),
  vcsAuthor: z.string().optional(),
  vcsUrl: z.string().optional(),
  vcsInstallationId: z.number().int().optional(),
  vcsNodeId: z.string().optional(),

  // AgentMail-specific metadata (optional)
  agentmailInboxId: z.string().optional(),
  agentmailMessageId: z.string().optional(),
  agentmailThreadId: z.string().optional(),

  // Mention-to-task metadata (optional)
  mentionMessageId: z.uuid().optional(),
  mentionChannelId: z.uuid().optional(),

  // Working directory (optional — must be an absolute path for the agent process)
  dir: z.string().min(1).startsWith("/").optional(),

  // Session attachment (optional)
  parentTaskId: z.uuid().optional(),
  claudeSessionId: z.string().optional(),

  // Model selection (optional — provider-specific; can be "opus", "gpt-4o",
  // "openrouter/openai/gpt-5-nano", etc. depending on HARNESS_PROVIDER).
  // Prefer modelTier for portable task intent; model is a concrete override
  // interpreted by the claiming worker's harness and never switches provider.
  model: z.string().optional(),
  modelTier: ModelTierSchema.optional(),
  effort: ReasoningEffortSchema.optional(),

  // Schedule linking (optional — set when task was created by a schedule)
  scheduleId: z.uuid().optional(),

  // Workflow linking (optional — set when task was created by a workflow)
  workflowRunId: z.string().uuid().nullable().optional(),
  workflowRunStepId: z.string().uuid().nullable().optional(),

  // Cross-ingress context key — uniform identifier for the "context entity"
  // (Slack thread, GitHub issue, Linear issue, schedule, workflow run, ...).
  // See src/tasks/context-key.ts. Nullable: legacy rows stay NULL.
  contextKey: z.string().optional(),

  // Structured output schema (optional — JSON Schema that task output must conform to)
  outputSchema: z.record(z.string(), z.unknown()).optional(),

  // Lead follow-up control (optional — null/undefined preserves default behavior)
  followUpConfig: FollowUpConfigSchema.optional(),

  // Pause tracking
  wasPaused: z.boolean().default(false),

  // Context usage aggregates
  compactionCount: z.number().int().min(0).optional(),
  peakContextPercent: z.number().min(0).max(100).optional(),
  // Migration 063: renamed from totalContextTokensUsed. Semantic is now a
  // monotonic max across the task's snapshots — "high water mark" rather than
  // "latest known".
  peakContextTokens: z.number().int().min(0).optional(),
  contextWindowSize: z.number().int().min(0).optional(),

  // Credential tracking
  credentialKeySuffix: z.string().optional(),
  credentialKeyType: z.string().optional(),

  // User identity — canonical user who requested this task
  requestedByUserId: z.string().optional(),

  // agent-swarm package version at task creation time. Enables benchmarking
  // performance across releases. Nullable for rows created before tracking was added.
  swarmVersion: z.string().optional(),

  // Provider tracking — which harness provider ran this task
  provider: ProviderNameSchema.optional(),
  providerMeta: z.record(z.string(), z.unknown()).optional(),

  // Harness variant — sub-variant within a provider (e.g. "bridge" vs "stock" for claude)
  harnessVariant: z.string().optional(),
  harnessVariantMeta: z.record(z.string(), z.unknown()).optional(),

  // Aggregated session cost for task list/read models. Undefined means no
  // session cost rows have been recorded for this task.
  totalCostUsd: z.number().min(0).optional(),

  // Routing-affinity snapshot (nullable) — gates which agents may claim/
  // auto-claim this task via the pool. Undefined = untagged, unchanged
  // behavior. Inherited from parentTaskId when not explicitly set (see
  // `createTaskExtended` in src/be/db.ts). See `isAgentEligibleForTask`.
  routingAffinity: RoutingAffinitySchema.optional(),
});

// ============================================================================
// Task Attachments (Phase 1 — pointer-based artifacts)
// ============================================================================
//
// Pointer-only: no inline blobs. Agents upload artifacts to agent-fs (or
// another addressable surface) first and attach them by path / URL / page id
// via `store-progress`. The `kind` enum here MUST stay in sync with the SQL
// CHECK constraint on `task_attachments.kind` (migration 072).

export const TaskAttachmentKindSchema = z.enum(["agent-fs", "url", "shared-fs", "page"]);
export type TaskAttachmentKind = z.infer<typeof TaskAttachmentKindSchema>;

const attachmentCommonFields = {
  name: z.string().min(1).describe("Display name for the attachment."),
  providerId: z.string().min(1).optional(),
  providerKey: z.string().min(1).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().min(0).optional(),
  sha256: z.string().optional(),
  intent: z
    .string()
    .optional()
    .describe("WHY this attachment exists — the purpose it serves for this task."),
  description: z.string().optional().describe("Optional: what the attachment is."),
  isPrimary: z.boolean().optional(),
};

export const AttachmentInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent-fs"),
    path: z.string().min(1).describe("agent-fs path the attachment points at."),
    orgId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "agent-fs org id — paired with `driveId` lets the renderer build a public live-host URL.",
      ),
    driveId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "agent-fs drive id — paired with `orgId` lets the renderer build a public live-host URL.",
      ),
    ...attachmentCommonFields,
  }),
  z.object({
    kind: z.literal("url"),
    url: z.string().min(1).describe("External URL the attachment points at."),
    ...attachmentCommonFields,
  }),
  z.object({
    kind: z.literal("shared-fs"),
    path: z.string().min(1).describe("Shared-filesystem path the attachment points at."),
    ...attachmentCommonFields,
  }),
  z.object({
    kind: z.literal("page"),
    pageId: z.string().min(1).describe("Swarm Page id the attachment points at."),
    ...attachmentCommonFields,
  }),
]);
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

export const TaskAttachmentSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  agentId: z.uuid().nullable(),
  name: z.string(),
  kind: TaskAttachmentKindSchema,
  url: z.string().optional(),
  path: z.string().optional(),
  pageId: z.string().optional(),
  providerId: z.string().optional(),
  providerKey: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  // agent-fs only — pair with `path` to build a public live-host URL.
  orgId: z.string().optional(),
  driveId: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().min(0).optional(),
  sha256: z.string().optional(),
  intent: z.string().optional(),
  description: z.string().optional(),
  isPrimary: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type TaskAttachment = z.infer<typeof TaskAttachmentSchema>;

// ============================================================================
// User Identity Types
// ============================================================================

export const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  email: z.string().optional(),
  role: z.string().optional(),
  notes: z.string().optional(),
  emailAliases: z.array(z.string()).default([]),
  preferredChannel: z.string().default("slack"),
  timezone: z.string().optional(),
  // Phase 064: free-form JSON for operator notes + integration hints.
  metadata: z.record(z.string(), z.unknown()).optional(),
  // NULL = unlimited (Phase 064).
  dailyBudgetUsd: z.number().nullable().optional(),
  // Lifecycle (Phase 064). CHECK constraint enforces these three values.
  status: z.enum(["invited", "active", "suspended"]).default("active"),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
});

export type User = z.infer<typeof UserSchema>;

/**
 * Identity event types — mirrored in lockstep with the CHECK constraint on
 * `user_identity_events.eventType` in migration 064. Drift breaks helper
 * INSERTs at runtime; update both sides together.
 */
export const IdentityEventTypeSchema = z.enum([
  "auto_merge",
  "manual_merge",
  "identity_added",
  "identity_removed",
  "email_added",
  "email_removed",
  "token_minted",
  "token_revoked",
  "budget_changed",
  "status_changed",
  "profile_changed",
]);
export type IdentityEventType = z.infer<typeof IdentityEventTypeSchema>;

// ============================================================================
// Inbox Item State (per-user dismiss/snooze/done for action-items inbox)
// ============================================================================
//
// Action-items inbox buckets:
//   - approval           — pending approval requests
//   - credential_missing — agents in waiting_for_credentials state
//   - broken_task        — tasks in failed/cancelled status
//   - to_read            — sessions/tasks marked unread for the user
//   - to_start_template  — task-templates the user hasn't dismissed
//
// Statuses:
//   - open      — visible in inbox
//   - snoozed   — hidden until snoozeUntil; reappears as `open`
//   - dismissed — hidden permanently (until item itself reactivates)
//   - done      — user marked complete
export const InboxItemTypeSchema = z.enum([
  "approval",
  "credential_missing",
  "broken_task",
  "to_read",
  "to_start_template",
]);
export type InboxItemType = z.infer<typeof InboxItemTypeSchema>;

export const InboxItemStatusSchema = z.enum(["open", "snoozed", "dismissed", "done"]);
export type InboxItemStatus = z.infer<typeof InboxItemStatusSchema>;

export const InboxItemStateSchema = z.object({
  id: z.string(),
  userId: z.string(),
  itemType: InboxItemTypeSchema,
  itemId: z.string(),
  status: InboxItemStatusSchema,
  snoozeUntil: z.string().optional(),
  dismissedAt: z.string().optional(),
  doneAt: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type InboxItemState = z.infer<typeof InboxItemStateSchema>;

// ============================================================================
// User Favorites (principal-scoped stars for app navigation)
// ============================================================================

export const FavoriteItemTypeSchema = z.enum(["page", "workflow", "schedule"]);
export type FavoriteItemType = z.infer<typeof FavoriteItemTypeSchema>;

export const UserFavoriteSchema = z.object({
  id: z.string(),
  userId: z.string().optional(),
  itemType: FavoriteItemTypeSchema,
  itemId: z.string(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type UserFavorite = z.infer<typeof UserFavoriteSchema>;

// ============================================================================
// Task Templates ("To start" bucket — polymorphic starters registry)
// ============================================================================
//
// kind:
//   - task     — v1 default; payload is `{}` and the task prompt lives in `prompt`
//   - workflow — v2 hook; payload `{ workflowId: string }`, prompt may be empty
//   - schedule — v2 hook; payload `{ cron: string, prompt: string }`
export const TaskTemplateKindSchema = z.enum(["task", "workflow", "schedule"]);
export type TaskTemplateKind = z.infer<typeof TaskTemplateKindSchema>;

export const TaskTemplateSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string(),
  prompt: z.string(),
  kind: TaskTemplateKindSchema.default("task"),
  payload: z.record(z.string(), z.unknown()).default({}),
  category: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;

export const AgentStatusSchema = z.enum(["idle", "busy", "offline", "waiting_for_credentials"]);

export const AgentSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  isLead: z.boolean().default(false),
  status: AgentStatusSchema,

  // Profile fields
  description: z.string().optional(),
  role: z.string().max(100).optional(), // Free-form, e.g., "frontend dev"
  capabilities: z.array(z.string()).default([]), // e.g., ["typescript", "react"]

  // Personal CLAUDE.md content (max 64KB)
  claudeMd: z.string().max(65536).optional(),

  // Soul: Persona, behavioral directives (injected via --append-system-prompt)
  soulMd: z.string().max(65536).optional(),
  // Identity: Expertise, working style, self-evolution notes (injected via --append-system-prompt)
  identityMd: z.string().max(65536).optional(),
  // Setup script: Runs at container start, agent-evolved (synced to /workspace/start-up.sh)
  setupScript: z.string().max(65536).optional(),
  // Tools/environment reference: Operational knowledge (synced to /workspace/TOOLS.md)
  toolsMd: z.string().max(65536).optional(),
  // Heartbeat checklist: Standing orders checked periodically (synced to /workspace/HEARTBEAT.md)
  heartbeatMd: z.string().max(65536).optional(),

  // Concurrency limit (defaults to 1 for backwards compatibility)
  maxTasks: z.number().int().min(1).max(100).optional(),

  // Polling limit tracking (consecutive empty polls)
  emptyPollCount: z.number().int().min(0).optional(),

  // Last session activity timestamp (updated on tool calls, task updates, etc.)
  lastActivityAt: z.iso.datetime().optional(),

  // Harness provider this agent runs (claude, opencode, codex, ...)
  provider: ProviderNameSchema.optional(),

  // Phase 1.5 (cloud-personalization): harness provider pushed by the worker
  // on registration. Mirrors `provider` but lives in its own column so the
  // server can answer "what harnesses are deployed?" without joining
  // anywhere else, and so an operator can re-assign via
  // PATCH /api/agents/:id/harness-provider without restarting the worker.
  // Worker boot path is NOT yet rewritten (DES-359 tracks that) — the
  // PATCH is a planning/forecast mechanism today; on next worker restart,
  // the env-driven value wins.
  harnessProvider: ProviderNameSchema.nullable().optional(),

  // Env-var names the worker is blocked on when status is
  // `waiting_for_credentials`. Null otherwise.
  credentialMissing: z.array(z.string()).nullable().optional(),

  // Worker-self-reported credential snapshot for this agent's harness.
  // Pairs with `harnessProvider`. Null = unreported (worker hasn't booted
  // yet, or CRED_CHECK_DISABLE=1 was set). Migration 055 adds the column.
  credStatus: z
    .lazy(() => AgentCredStatusSchema)
    .nullable()
    .optional(),

  createdAt: z.iso.datetime().default(() => new Date().toISOString()),
  lastUpdatedAt: z.iso.datetime().default(() => new Date().toISOString()),
});

// ---------------------------------------------------------------------------
// Worker-reported credential snapshot
// ---------------------------------------------------------------------------
// `provider` is intentionally absent from the JSON — already on the agent row
// as `harnessProvider`; the status endpoint joins them at read time.
//
// `reportKind` records the trigger that produced the report:
//   - "boot": worker startup, full check (presence + live test).
//   - "post_task": worker finished a task and `harness_provider` differed
//     from its cached value, so it re-ran a full check (presence + live test).
//
// The cache-hit post-task path does NOT produce a new report; the row's
// `reportedAt` deliberately stays at the last actual check.
export const AgentCredStatusLiveTestSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable().default(null),
  latency_ms: z.number(),
  testedAt: z.number(), // unix ms
});
export type AgentCredStatusLiveTest = z.infer<typeof AgentCredStatusLiveTestSchema>;

export const AgentLatestModelSchema = z.object({
  model: z.string().min(1),
  source: z.enum(["task", "agent_config", "adapter_default", "custom"]),
  taskId: z.string().nullable().default(null),
  harnessProvider: ProviderNameSchema.nullable().default(null),
  reportedAt: z.number(), // unix ms
  /** Worker-applied reasoning/effort level for this session, when the adapter honored one. */
  reasoningEffort: ReasoningEffortSchema.optional(),
});
export type AgentLatestModel = z.infer<typeof AgentLatestModelSchema>;

/**
 * Worker-reported Bedrock enumeration block. Only present when the pi harness
 * is in Bedrock SDK mode (`BEDROCK_AUTH_MODE=sdk` or
 * `MODEL_OVERRIDE=amazon-bedrock/*`). Rides inside `cred_status` JSON (no new
 * DB column). `models` is the intersection of the models invocable by this
 * account/region (on-demand/ACTIVE foundation models ∪ inference profiles) with
 * the set the pi-ai Converse harness can actually drive — Converse-incompatible
 * entries (e.g. OpenAI models listed in the account) are excluded. An empty
 * `region` means Bedrock mode with `AWS_REGION` unset (no region fabricated).
 */
export const AgentBedrockStatusSchema = z.object({
  region: z.string(),
  probedAt: z.number(), // unix ms
  ready: z.boolean(),
  models: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  error: z.string().optional(),
});
export type AgentBedrockStatus = z.infer<typeof AgentBedrockStatusSchema>;

export const AgentCredStatusSchema = z.object({
  ready: z.boolean(),
  missing: z.array(z.string()).default([]),
  satisfiedBy: z
    .enum(["env", "file", "side-effect-pending", "sdk-delegated"])
    .nullable()
    .default(null),
  hint: z.string().nullable().default(null),
  liveTest: AgentCredStatusLiveTestSchema.nullable().default(null),
  latestModel: AgentLatestModelSchema.nullable().default(null),
  reportedAt: z.number(), // unix ms
  reportKind: z.enum(["boot", "post_task"]).default("boot"),
  /** Pi-mono Bedrock enumeration block — null when not in Bedrock mode. */
  bedrock: AgentBedrockStatusSchema.nullable().default(null),
});
export type AgentCredStatus = z.infer<typeof AgentCredStatusSchema>;

export const AgentWithTasksSchema = AgentSchema.extend({
  tasks: z.array(AgentTaskSchema).default([]),
});

export type AgentTaskStatus = z.infer<typeof AgentTaskStatusSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type AgentWithTasks = z.infer<typeof AgentWithTasksSchema>;

// ============================================================================
// Context Versioning Types
// ============================================================================

export const ChangeSourceSchema = z.enum([
  "self_edit",
  "lead_coaching",
  "api",
  "system",
  "session_sync",
]);

export const VersionableFieldSchema = z.enum([
  "soulMd",
  "identityMd",
  "toolsMd",
  "claudeMd",
  "setupScript",
  "heartbeatMd",
]);

export const ContextVersionSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  field: VersionableFieldSchema,
  content: z.string(),
  version: z.number().int().min(1),
  changeSource: ChangeSourceSchema,
  changedByAgentId: z.uuid().nullable(),
  changeReason: z.string().nullable(),
  contentHash: z.string(),
  previousVersionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export type ChangeSource = z.infer<typeof ChangeSourceSchema>;
export type VersionableField = z.infer<typeof VersionableFieldSchema>;
export type ContextVersion = z.infer<typeof ContextVersionSchema>;

export type VersionMeta = {
  changeSource?: ChangeSource;
  changedByAgentId?: string | null;
  changeReason?: string | null;
};

// Channel Types
export const ChannelTypeSchema = z.enum(["public", "dm"]);

export const ChannelSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: ChannelTypeSchema.default("public"),
  createdBy: z.uuid().optional(),
  participants: z.array(z.uuid()).default([]), // For DMs
  createdAt: z.iso.datetime(),
});

export const ChannelMessageSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  agentId: z.uuid().nullable(), // Null for human users
  agentName: z.string().optional(), // Denormalized for convenience, "Human" when agentId is null
  content: z.string().min(1).max(4000),
  replyToId: z.uuid().optional(),
  mentions: z.array(z.uuid()).default([]), // Agent IDs mentioned
  createdAt: z.iso.datetime(),
});

export type ChannelType = z.infer<typeof ChannelTypeSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>;

// Service Types (for PM2/background services)
export const ServiceStatusSchema = z.enum(["starting", "healthy", "unhealthy", "stopped"]);

export const ServiceSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  name: z.string().min(1).max(50),
  port: z.number().int().min(1).max(65535).default(3000),
  description: z.string().optional(),
  url: z.string().url().optional(),
  healthCheckPath: z.string().default("/health"),
  status: ServiceStatusSchema.default("starting"),

  // PM2 configuration (required for ecosystem-based restart)
  script: z.string().min(1), // Path to script (required)
  cwd: z.string().optional(), // Working directory (defaults to script dir)
  interpreter: z.string().optional(), // e.g., "node", "bun" (auto-detected if not set)
  args: z.array(z.string()).optional(), // Command line arguments
  env: z.record(z.string(), z.string()).optional(), // Environment variables

  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
});

export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
export type Service = z.infer<typeof ServiceSchema>;

// Agent Log Types
export const AgentLogEventTypeSchema = z.enum([
  "agent_joined",
  "agent_status_change",
  "agent_left",
  "task_created",
  "task_status_change",
  "task_progress",
  // Task pool events
  "task_offered",
  "task_accepted",
  "task_rejected",
  "task_claimed",
  "task_claim_rejected_affinity",
  "task_released",
  "channel_message",
  // Service registry events
  "service_registered",
  "service_unregistered",
  "service_status_change",
  // Phase 6: budget / pricing operator-mutation audit log events
  "budget.upserted",
  "budget.deleted",
  "pricing.inserted",
  "pricing.deleted",
  "pricing.refresh",
  "pricing.refresh.failed",
  // Graceful pause/resume via follow-up
  "task_superseded",
]);

// Reasons a task can be superseded (terminal) and replaced by a "resume" follow-up.
export const ResumeReasonSchema = z.enum([
  "graceful_shutdown", // Worker received SIGTERM / SIGINT
  "context_limits", // Provider session approaching context-window limits (Phase 6)
  "manual_supersede", // Operator-triggered (e.g. dashboard button)
  "crash_recovery", // Heartbeat sweep detected dead/stalled worker (DES-523)
]);
export type ResumeReason = z.infer<typeof ResumeReasonSchema>;

export const AgentLogSchema = z.object({
  id: z.uuid(),
  eventType: AgentLogEventTypeSchema,
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  oldValue: z.string().optional(),
  newValue: z.string().optional(),
  metadata: z.string().optional(),
  createdAt: z.iso.datetime(),
});

export type AgentLogEventType = z.infer<typeof AgentLogEventTypeSchema>;
export type AgentLog = z.infer<typeof AgentLogSchema>;

// Session Log Types (raw CLI output)
export const SessionLogSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid().optional(),
  sessionId: z.string(),
  iteration: z.number().int().min(1),
  cli: z.string().default("claude"),
  content: z.string(), // Raw JSON line
  lineNumber: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});

export type SessionLog = z.infer<typeof SessionLogSchema>;

// Session Cost Types (aggregated cost data per session)
// Migration 063 widened the set to include 'unpriced' for cases where the API
// recompute path couldn't find pricing rows for the (provider, model, token_class).
export const SessionCostSourceSchema = z.enum(["harness", "pricing-table", "unpriced"]);
export type SessionCostSource = z.infer<typeof SessionCostSourceSchema>;

export const SessionCostSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  taskId: z.uuid().optional(),
  agentId: z.uuid(),
  totalCostUsd: z.number().min(0),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  cacheReadTokens: z.number().int().min(0).default(0),
  cacheWriteTokens: z.number().int().min(0).default(0),
  // Migration 063: reasoning_output_tokens from codex turn.completed events.
  reasoningOutputTokens: z.number().int().min(0).default(0),
  // Migration 063: thinking_input_tokens from claude extended-thinking flows.
  thinkingTokens: z.number().int().min(0).default(0),
  durationMs: z.number().int().min(0),
  // numTurns is nullable — some adapters (e.g. Claude when num_turns is absent)
  // can't honestly report a turn count. We prefer null over a faked 1.
  numTurns: z.number().int().min(1).nullable(),
  model: z.string(),
  isError: z.boolean().default(false),
  // Phase 6 (extended by migration 063): where the recorded totalCostUsd came from.
  //   'harness'        — value reported by the harness as-is.
  //   'pricing-table'  — value recomputed by the API from `pricing` rows.
  //   'unpriced'       — the API tried to recompute but the (provider, model)
  //                      had no matching pricing rows; totalCostUsd is whatever
  //                      the worker submitted (often 0).
  costSource: SessionCostSourceSchema.default("harness"),
  createdAt: z.iso.datetime(),
});

export type SessionCost = z.infer<typeof SessionCostSchema>;

// ============================================================================
// Events
// ============================================================================

export const EventCategorySchema = z.enum([
  "tool",
  "skill",
  "session",
  "api",
  "task",
  "workflow",
  "system",
]);

export const EventStatusSchema = z.enum(["ok", "error", "timeout", "skipped"]);

export const EventSourceSchema = z.enum(["worker", "api", "hook", "scheduler", "cli"]);

export const EventNameSchema = z.enum([
  // Tool events
  "tool.start",
  "tool.end",
  // Skill events
  "skill.invoke",
  "skill.complete",
  // Session events
  "session.start",
  "session.end",
  "session.resume",
  "session.cost",
  // API events
  "api.request",
  "api.error",
  // Task events
  "task.poll",
  "task.assign",
  "task.timeout",
  // Workflow events
  "workflow.step.start",
  "workflow.step.end",
  "workflow.run.start",
  "workflow.run.end",
  // System events
  "system.boot",
  "system.migration",
  "system.error",
  // Script catalog events
  "script.global_upsert",
  // Schedule events
  "schedule.deleted",
]);

export const SwarmEventSchema = z.object({
  id: z.uuid(),
  category: EventCategorySchema,
  event: EventNameSchema,
  status: EventStatusSchema,
  source: EventSourceSchema,
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  parentEventId: z.string().optional(),
  numericValue: z.number().optional(),
  durationMs: z.number().int().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.iso.datetime(),
});

export type EventCategory = z.infer<typeof EventCategorySchema>;
export type EventStatus = z.infer<typeof EventStatusSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type EventName = z.infer<typeof EventNameSchema>;
export type SwarmEvent = z.infer<typeof SwarmEventSchema>;

// ============================================================================
// Scheduled Task Types
// ============================================================================

export const ScheduledTaskTargetTypeSchema = z.enum(["agent-task", "workflow", "script"]);
export type ScheduledTaskTargetType = z.infer<typeof ScheduledTaskTargetTypeSchema>;

export const ScheduledTaskSchema = z
  .object({
    id: z.uuid(),
    key: AssetKeySchema,
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    cronExpression: z.string().optional(),
    intervalMs: z.number().int().positive().optional(),
    taskTemplate: z.string().optional(),
    taskType: z.string().max(50).optional(),
    tags: z.array(z.string()).default([]),
    priority: z.number().int().min(0).max(100).default(50),
    targetAgentId: z.uuid().optional(),
    enabled: z.boolean().default(true),
    lastRunAt: z.iso.datetime().optional(),
    nextRunAt: z.iso.datetime().optional(),
    createdByAgentId: z.uuid().optional(),
    timezone: z.string().default("UTC"),
    consecutiveErrors: z.number().int().min(0).default(0),
    lastErrorAt: z.iso.datetime().optional(),
    lastErrorMessage: z.string().optional(),
    model: z.string().optional(),
    modelTier: ModelTierSchema.optional(),
    scheduleType: z.enum(["recurring", "one_time"]).default("recurring"),
    targetType: ScheduledTaskTargetTypeSchema.default("agent-task"),
    workflowId: z.uuid().optional(),
    scriptName: z.string().optional(),
    scriptArgs: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.iso.datetime(),
    lastUpdatedAt: z.iso.datetime(),
    createdBy: z.string().optional(),
    updatedBy: z.string().optional(),
    favorite: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (data.scheduleType === "one_time") return true;
      return data.cronExpression || data.intervalMs;
    },
    {
      message: "Either cronExpression or intervalMs must be provided for recurring schedules",
    },
  )
  .refine(
    (data) => {
      switch (data.targetType) {
        case "agent-task":
          return !!data.taskTemplate;
        case "workflow":
          return !!data.workflowId;
        case "script":
          return !!data.scriptName;
        default:
          return true;
      }
    },
    {
      message: "Target-type specific field is required (taskTemplate, workflowId, or scriptName)",
    },
  );

export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

// ============================================================================
// Swarm Config Types (Centralized Environment/Config Management)
// ============================================================================

export const SwarmConfigScopeSchema = z.enum(["global", "agent", "repo"]);

export const SwarmConfigSchema = z.object({
  id: z.string().uuid(),
  scope: SwarmConfigScopeSchema,
  scopeId: z.string().nullable(), // agentId or repoId, null for global
  key: z.string().min(1).max(255),
  value: z.string(),
  isSecret: z.boolean(),
  envPath: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  // True when the row's value is stored as AES-256-GCM ciphertext in the DB.
  // Plaintext rows return encrypted=false. Legacy isSecret=1 rows are
  // auto-encrypted during initDb; if that fails, boot aborts before normal API
  // reads occur.
  encrypted: z.boolean(),
});

export type SwarmConfigScope = z.infer<typeof SwarmConfigScopeSchema>;
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

// ============================================================================
// Swarm Repos Types (Centralized Repository Management)
// ============================================================================

export const RepoGuidelinesSchema = z.object({
  prChecks: z.array(z.string()),
  mergeChecks: z.array(z.string()),
  allowMerge: z.boolean().optional().default(false),
  review: z.array(z.string()),
});

export type RepoGuidelines = z.infer<typeof RepoGuidelinesSchema>;

export const RepoHooksSchema = z.object({
  enabled: z.boolean().default(false),
});

export type RepoHooks = z.infer<typeof RepoHooksSchema>;

export const SwarmRepoSchema = z.object({
  id: z.string().uuid(),
  url: z.string().min(1),
  name: z.string().min(1).max(100),
  clonePath: z.string().min(1),
  defaultBranch: z.string().default("main"),
  autoClone: z.boolean().default(true),
  hooks: RepoHooksSchema.optional().default({ enabled: false }),
  guidelines: RepoGuidelinesSchema.nullable().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});

export type SwarmRepo = z.infer<typeof SwarmRepoSchema>;

// ============================================================================
// Agent Memory Types (Persistent Memory System)
// ============================================================================

export const AgentMemoryScopeSchema = z.enum(["agent", "swarm"]);
export const AgentMemorySourceSchema = z.enum([
  "manual",
  "file_index",
  "session_summary",
  "task_completion",
]);

export const AgentMemorySchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  scope: AgentMemoryScopeSchema,
  key: z.string().nullable().optional(),
  name: z.string().min(1).max(500),
  content: z.string(),
  summary: z.string().nullable(),
  source: AgentMemorySourceSchema,
  sourceTaskId: z.string().uuid().nullable(),
  sourcePath: z.string().nullable(),
  chunkIndex: z.number().int().min(0).default(0),
  totalChunks: z.number().int().min(1).default(1),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string().nullable().optional(),
  accessedAt: z.string(),
  expiresAt: z.string().nullable().optional(),
  accessCount: z.number().int().min(0).default(0).optional(),
  embeddingModel: z.string().nullable().optional(),
  contentHash: z.string().nullable().optional(),
  version: z.number().int().min(1).default(1).optional(),
});

export type AgentMemoryScope = z.infer<typeof AgentMemoryScopeSchema>;
export type AgentMemorySource = z.infer<typeof AgentMemorySourceSchema>;
export type AgentMemory = z.infer<typeof AgentMemorySchema>;

// ============================================================================
// Active Session Types (runner session tracking)
// ============================================================================

export const ActiveSessionSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  taskId: z.string().nullable(),
  triggerType: z.string(),
  inboxMessageId: z.string().nullable(),
  taskDescription: z.string().nullable(),
  runnerSessionId: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  startedAt: z.iso.datetime(),
  lastHeartbeatAt: z.iso.datetime(),
});

export type ActiveSession = z.infer<typeof ActiveSessionSchema>;

// ============================================================================
// Workflow Engine Types
// ============================================================================

// --- Retry Policy ---

export const RetryPolicySchema = z.object({
  maxRetries: z.number().int().min(0).default(3),
  strategy: z.enum(["exponential", "static", "linear"]).default("exponential"),
  baseDelayMs: z.number().int().min(0).default(1000),
  maxDelayMs: z.number().int().min(0).default(60000),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// --- Executor Metadata ---

export const ExecutorMetaSchema = z.object({
  runId: z.string().uuid(),
  stepId: z.string().uuid(),
  nodeId: z.string(),
  workflowId: z.string().uuid(),
  dryRun: z.boolean().default(false),
  requestedByUserId: z.string().optional(),
});
export type ExecutorMeta = z.infer<typeof ExecutorMetaSchema>;

// --- Validation ---

export const ValidationResultSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const StepValidationConfigSchema = z.object({
  executor: z.string().default("validate"),
  config: z.record(z.string(), z.unknown()),
  mustPass: z.boolean().default(false),
  retry: RetryPolicySchema.optional(),
});
export type StepValidationConfig = z.infer<typeof StepValidationConfigSchema>;

export const SwarmScriptNodeConfigSchema = z.object({
  scriptName: z.string().min(1),
  scope: z.enum(["global", "agent"]).optional(),
  pinHash: z.string().min(1).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  fsMode: z.enum(["none", "workspace-rw"]).optional(),
});
export type SwarmScriptNodeConfig = z.infer<typeof SwarmScriptNodeConfigSchema>;

// --- Workflow Node (nodes-with-next) ---

export const WorkflowNodeSchema = z.object({
  id: z.string().describe("Unique node identifier, used in 'next' and 'inputs' mappings"),
  type: z
    .string()
    .describe(
      "Executor type: 'agent-task', 'script', 'swarm-script', 'raw-llm', 'validate', 'property-match'",
    ),
  label: z.string().optional().describe("Human-readable label for UI display"),
  config: z
    .record(z.string(), z.unknown())
    .describe(
      "Executor-specific config. For agent-task: { template, outputSchema?, agentId?, tags?, priority?, dir?, vcsRepo?, model? }. " +
        "For swarm-script: { scriptName, scope?, pinHash?, args?, fsMode? }. " +
        "Values support {{interpolation}} from the node's inputs context. " +
        "NOTE: config.outputSchema on agent-task nodes validates the AGENT's raw JSON output, " +
        "while node-level outputSchema validates the EXECUTOR's return value ({taskId, taskOutput}).",
    ),
  next: z
    .union([z.string(), z.array(z.string()), z.record(z.string(), z.string())])
    .optional()
    .describe(
      "Next node(s): string for simple chaining, string[] for fan-out to parallel nodes, or record for port-based routing ({pass: 'a', fail: 'b'})",
    ),
  validation: StepValidationConfigSchema.optional(),
  retry: RetryPolicySchema.optional(),
  // REQUIRED for cross-node data access — without this, only 'trigger' and 'input' are available for interpolation.
  inputs: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "REQUIRED for cross-node data access. Maps local names to context paths. " +
        "Without this, upstream step outputs are NOT available for interpolation — only 'trigger' and 'input' are. " +
        'Example: { "cityData": "generate-city" } → use {{cityData.taskOutput.field}} in config templates. ' +
        'For trigger data: { "pr": "trigger.pullRequest" }.',
    ),
  inputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema to validate resolved inputs before execution"),
  outputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "JSON Schema to validate the executor's output (e.g. {taskId, taskOutput} for agent-task). " +
        "Different from config.outputSchema which validates the agent's raw output.",
    ),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

// --- Workflow Edge (derived — for UI rendering) ---

export const WorkflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  sourcePort: z.string(),
  target: z.string(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

// --- Workflow Definition (nodes-only, no explicit edges) ---

export const WorkflowDefinitionSchema = z.object({
  nodes: z.array(WorkflowNodeSchema).min(1),
  onNodeFailure: z
    .enum(["fail", "continue"])
    .default("fail")
    .describe(
      "Behavior when a node's task fails or is cancelled. " +
        "'fail' (default): mark the entire run as failed. " +
        "'continue': treat the failed node as completed with error output and proceed — " +
        "downstream convergence nodes receive '[FAILED: reason]' and can handle partial results.",
    ),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// --- Workflow Patch Schemas ---

/** Partial node update — all fields optional, id is NOT included (comes from path/nodeId) */
export const WorkflowNodePatchSchema = WorkflowNodeSchema.partial().omit({ id: true });
export type WorkflowNodePatch = z.infer<typeof WorkflowNodePatchSchema>;

/** Bulk workflow patch — DAG operations plus optional metadata fields like triggerSchema */
export const WorkflowPatchSchema = z.object({
  update: z
    .array(
      z.object({
        nodeId: z.string().describe("ID of the node to update"),
        node: WorkflowNodePatchSchema.describe("Partial node data to merge"),
      }),
    )
    .optional()
    .describe("Nodes to update (partial merge)"),
  delete: z.array(z.string()).optional().describe("Node IDs to delete"),
  create: z.array(WorkflowNodeSchema).optional().describe("New nodes to add"),
  onNodeFailure: z
    .enum(["fail", "continue"])
    .optional()
    .describe("Update the definition-level onNodeFailure behavior"),
  triggerSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .nullable()
    .describe(
      "Optional JSON-Schema describing the expected trigger payload shape. " +
        "Pass an object to set/replace; pass null to clear; omit to leave unchanged. " +
        "Validator subset: type, required, properties, enum, const, items. " +
        "Other JSON-Schema keywords are silently ignored.",
    ),
});
export type WorkflowPatch = z.infer<typeof WorkflowPatchSchema>;

/** Result of applying a patch — collects all errors instead of throwing on the first */
export interface PatchResult {
  definition: WorkflowDefinition;
  errors: string[];
}

// --- Trigger Configuration ---

// Presets only: Slack-style separate timestamp headers, asymmetric signatures,
// and generic signature-template DSLs are intentionally out of scope for v1.
export const WebhookVerificationSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("hmac-sha256"),
    header: z
      .string()
      .default("X-Hub-Signature-256")
      .describe(
        "Header containing HMAC-SHA256 over the raw request body. Accepts sha256=<hex> or bare hex.",
      ),
  }),
  z.object({
    format: z.literal("timestamped-hmac-sha256"),
    header: z
      .string()
      .min(1)
      .describe(
        "Header containing comma-separated timestamp/signature pairs such as t=<timestamp>,v1=<hex>.",
      ),
    timestampKey: z.string().default("t").describe("Timestamp field key in the signature header"),
    signatureKey: z
      .string()
      .default("v1")
      .describe("Signature field key in the signature header; multiple entries are allowed"),
    toleranceSeconds: z
      .number()
      .int()
      .positive()
      .default(300)
      .describe("Maximum allowed clock skew, in seconds, for replay protection"),
  }),
  z.object({
    format: z.literal("token-equality"),
    header: z.string().min(1).describe("Header containing the shared token to compare"),
  }),
]);
export type WebhookVerification = z.infer<typeof WebhookVerificationSchema>;

export const TriggerConfigSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("webhook"),
      hmacSecret: z.string().optional(),
      hmacHeader: z
        .string()
        .default("X-Hub-Signature-256")
        .describe(
          "Legacy HMAC header for webhook verification. Prefer verification.header for new workflows.",
        ),
      verification: WebhookVerificationSchema.optional().describe(
        "Optional webhook verification format. Omit to keep legacy HMAC-SHA256 behavior with fallback header scanning.",
      ),
    }),
    z.object({
      type: z.literal("schedule"),
      scheduleId: z.string().uuid(),
    }),
  ])
  .superRefine((trigger, ctx) => {
    if (trigger.type === "webhook" && trigger.verification && !trigger.hmacSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hmacSecret is required when verification is configured",
        path: ["hmacSecret"],
      });
    }
  });
export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

// --- Cooldown Configuration ---

export const CooldownConfigSchema = z
  .object({
    hours: z.number().min(0).optional(),
    minutes: z.number().min(0).optional(),
    seconds: z.number().min(0).optional(),
  })
  .refine((v) => v.hours !== undefined || v.minutes !== undefined || v.seconds !== undefined, {
    message: "At least one of hours, minutes, or seconds is required",
  });
export type CooldownConfig = z.infer<typeof CooldownConfigSchema>;

// --- Input Value Resolution ---

export const InputValueSchema = z.union([
  z
    .string()
    .regex(/^\$\{.+\}$/), // env var: ${MY_VAR}
  z
    .string()
    .regex(/^secret\..+$/), // swarm secret: secret.OPENAI_KEY
  z.string(), // literal value
]);
export type InputValue = z.infer<typeof InputValueSchema>;

// --- Workflow Template ---

export const WorkflowTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  variables: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      type: z.enum(["string", "number", "boolean"]),
      default: z.unknown().optional(),
      required: z.boolean().default(true),
    }),
  ),
  definition: WorkflowDefinitionSchema,
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

// --- Workflow Snapshot (for version history) ---

export const WorkflowSnapshotSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  definition: WorkflowDefinitionSchema,
  triggers: z.array(TriggerConfigSchema),
  cooldown: CooldownConfigSchema.optional(),
  input: z.record(z.string(), InputValueSchema).optional(),
  triggerSchema: z.record(z.string(), z.unknown()).optional(),
  dir: z.string().min(1).startsWith("/").optional(),
  vcsRepo: z.string().min(1).optional(),
  enabled: z.boolean(),
});
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;

// --- Workflow ---

export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  key: AssetKeySchema,
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  definition: WorkflowDefinitionSchema,
  triggers: z.array(TriggerConfigSchema).default([]),
  cooldown: CooldownConfigSchema.optional(),
  input: z.record(z.string(), InputValueSchema).optional(),
  triggerSchema: z.record(z.string(), z.unknown()).optional(),
  dir: z.string().min(1).startsWith("/").optional(),
  vcsRepo: z.string().min(1).optional(),
  createdByAgentId: z.string().uuid().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
  favorite: z.boolean().optional(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// --- Workflow Version ---

export const WorkflowVersionSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  version: z.number().int().min(1),
  snapshot: WorkflowSnapshotSchema,
  changedByAgentId: z.string().uuid().optional(),
  createdAt: z.string(),
});
export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>;

// ---------------------------------------------------------------------------
// Pages — DB-backed lightweight artifacts (HTML or JSON spec) stored in
// SQLite and served at /p/:id. See plan: thoughts/taras/plans/2026-05-12-db-backed-pages/.
// PageContentTypeSchema + PageAuthModeSchema MUST stay in sync with the SQL
// CHECK constraints in src/be/migrations/059_pages.sql.
// ---------------------------------------------------------------------------

export const PageContentTypeSchema = z.enum(["text/html", "application/json"]);
export type PageContentType = z.infer<typeof PageContentTypeSchema>;

export const PageAuthModeSchema = z.enum(["public", "authed", "password"]);
export type PageAuthMode = z.infer<typeof PageAuthModeSchema>;

// PageSnapshot captures the mutable content fields frozen per-version in
// page_versions.snapshot. Omits id / agentId / slug / timestamps (these are
// invariant across versions for a given page id; the slug is a parent-only
// identifier).
export const PageSnapshotSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  contentType: PageContentTypeSchema,
  authMode: PageAuthModeSchema,
  passwordHash: z.string().optional(),
  body: z.string(),
  needsCredentials: z.array(z.string()).optional(),
});
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

export const PageSchema = z.object({
  id: z.string(),
  key: AssetKeySchema,
  agentId: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().optional(),
  contentType: PageContentTypeSchema,
  authMode: PageAuthModeSchema,
  passwordHash: z.string().optional(),
  body: z.string(),
  needsCredentials: z.array(z.string()).optional(),
  viewCount: z.number().int().min(0).default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  favorite: z.boolean().optional(),
});
export type Page = z.infer<typeof PageSchema>;

// ---------------------------------------------------------------------------
// Slim list-endpoint variants
// ---------------------------------------------------------------------------
// List endpoints default to these slimmed shapes — heavy fields (`body`,
// `definition`, `taskTemplate`, full task text, …) are stripped because list
// views never render them and they are all available via the get-by-id
// endpoints. Callers that still need the full shape opt in with `?fields=full`
// (HTTP) or `includeFull: true` (MCP). See the PR for per-endpoint sizes.

/** `/api/workflows` list item — drops `definition` + trigger config, keeps a derived `nodeCount`. */
export type WorkflowSummary = Omit<
  Workflow,
  "definition" | "triggers" | "cooldown" | "input" | "triggerSchema"
> & { nodeCount: number };

/** `/api/pages` list item — drops the (potentially huge) `body` and `passwordHash`. */
export type PageSummary = Omit<Page, "body" | "passwordHash">;

/** `/api/schedules` list item — swaps the full `taskTemplate` for a short preview. */
export type ScheduledTaskSummary = Omit<ScheduledTask, "taskTemplate"> & {
  taskTemplatePreview: string;
};

/**
 * `/api/tasks` + `/api/sessions` list item — a strict subset of `AgentTask`.
 * The `task` text is truncated to a bounded preview (~300 chars) and the
 * completion/integration/context blobs (`output`, `failureReason`, `vcs*`,
 * `slack*`, `agentmail*`, `providerMeta`, …) are dropped. Because every field
 * here also exists on `AgentTask` (with the dropped ones optional), an
 * `AgentTaskSummary` value is assignable wherever an `AgentTask` is expected —
 * existing consumers keep compiling. The full brief is on `get-task-details` /
 * `GET /api/tasks/{id}` (or pass `?fields=full`). The MCP `get-tasks` tool
 * re-exposes the truncated text as a distinct `taskPreview` field.
 */
export type AgentTaskSummary = Pick<
  AgentTask,
  | "id"
  | "key"
  | "agentId"
  | "creatorAgentId"
  | "task"
  | "status"
  | "source"
  | "taskType"
  | "tags"
  | "priority"
  | "dependsOn"
  | "offeredTo"
  | "acceptedAt"
  | "parentTaskId"
  | "scheduleId"
  | "model"
  | "modelTier"
  | "effort"
  | "provider"
  | "requestedByUserId"
  | "progress"
  | "createdAt"
  | "lastUpdatedAt"
  | "finishedAt"
  | "peakContextPercent"
  | "totalCostUsd"
>;

export const PageVersionSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  version: z.number().int().min(1),
  snapshot: PageSnapshotSchema,
  changedByAgentId: z.string().optional(),
  createdAt: z.string(),
});
export type PageVersion = z.infer<typeof PageVersionSchema>;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const MetricParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type MetricParam = z.infer<typeof MetricParamSchema>;
const MetricVariableTypeSchema = z.enum(["text", "number", "select"]);

export const MetricFormatSchema = z.enum(["number", "integer", "currency", "percent", "duration"]);
export type MetricFormat = z.infer<typeof MetricFormatSchema>;

export const MetricVisualizationSchema = z.enum([
  "stat",
  "table",
  "bar",
  "line",
  "multi-bar",
  "multi-line",
]);
export type MetricVisualization = z.infer<typeof MetricVisualizationSchema>;

const MetricQuerySchema = z.object({
  sql: z.string().min(1).max(10_000),
  params: z.array(MetricParamSchema).optional(),
  maxRows: z.number().int().min(1).max(500).optional(),
});

export const MetricVariableSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string().min(1).optional(),
  type: MetricVariableTypeSchema.default("text"),
  defaultValue: MetricParamSchema.optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        value: MetricParamSchema,
      }),
    )
    .optional(),
  optionsQuery: z
    .object({
      sql: z.string().min(1).max(10_000),
      valueKey: z.string().min(1),
      labelKey: z.string().min(1).optional(),
    })
    .optional(),
});
export type MetricVariable = z.infer<typeof MetricVariableSchema>;

export const MetricVizConfigSchema = z.object({
  type: MetricVisualizationSchema,
  x: z.string().optional(),
  y: z.string().optional(),
  series: z.array(z.string()).optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  columns: z
    .array(
      z.object({
        key: z.string(),
        label: z.string().optional(),
        format: MetricFormatSchema.optional(),
      }),
    )
    .optional(),
  format: MetricFormatSchema.optional(),
});
export type MetricVizConfig = z.infer<typeof MetricVizConfigSchema>;

export const MetricWidgetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  query: MetricQuerySchema,
  viz: MetricVizConfigSchema,
  colSpan: z.number().int().min(1).max(4).optional(),
  rowSpan: z.number().int().min(1).max(4).optional(),
});
export type MetricWidget = z.infer<typeof MetricWidgetSchema>;

export const MetricDefinitionSchema = z.object({
  version: z.literal(1),
  widgets: z.array(MetricWidgetSchema).min(1).max(24),
  variables: z.array(MetricVariableSchema).max(12).optional(),
  layout: z
    .object({
      columns: z.number().int().min(1).max(4).optional(),
    })
    .optional(),
  refreshSeconds: z.number().int().min(5).max(3600).optional(),
});
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;

export const MetricSnapshotSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  definition: MetricDefinitionSchema,
});
export type MetricSnapshot = z.infer<typeof MetricSnapshotSchema>;

export const MetricSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().optional(),
  definition: MetricDefinitionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Metric = z.infer<typeof MetricSchema>;

export type MetricSummary = Omit<Metric, "definition">;

export const MetricVersionSchema = z.object({
  id: z.string(),
  metricId: z.string(),
  version: z.number().int().min(1),
  snapshot: MetricSnapshotSchema,
  changedByAgentId: z.string().optional(),
  createdAt: z.string(),
});
export type MetricVersion = z.infer<typeof MetricVersionSchema>;

// --- Workflow Run ---

export const WorkflowRunStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  status: WorkflowRunStatusSchema,
  triggerData: z.unknown().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

// --- Script Workflow Runs ---

export const ScriptRunStatusSchema = z.enum([
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "aborted_limit",
]);
export type ScriptRunStatus = z.infer<typeof ScriptRunStatusSchema>;

export const TERMINAL_SCRIPT_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "aborted_limit",
] as const;
export type TerminalScriptRunStatus = (typeof TERMINAL_SCRIPT_RUN_STATUSES)[number];

// `workflow` = durable background run launched via /api/script-runs (has a journal).
// `inline` = synchronous one-off run via /api/scripts/run (no journal).
export const ScriptRunKindSchema = z.enum(["workflow", "inline"]);
export type ScriptRunKind = z.infer<typeof ScriptRunKindSchema>;

export const ScriptRunSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string(),
  scriptName: z.string().optional(),
  source: z.string(),
  args: z.unknown(),
  kind: ScriptRunKindSchema,
  status: ScriptRunStatusSchema,
  pid: z.number().int().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  lastHeartbeatAt: z.string().optional(),
  idempotencyKey: z.string().optional(),
  requestedByUserId: z.string().optional(),
});
export type ScriptRun = z.infer<typeof ScriptRunSchema>;

export const ScriptRunListItemSchema = ScriptRunSchema.omit({
  source: true,
  args: true,
  output: true,
});
export type ScriptRunListItem = z.infer<typeof ScriptRunListItemSchema>;

export const ScriptRunJournalEntrySchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  stepKey: z.string(),
  stepType: z.string(),
  config: z.record(z.string(), z.unknown()),
  status: z.enum(["completed", "failed"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
});
export type ScriptRunJournalEntry = z.infer<typeof ScriptRunJournalEntrySchema>;

// --- Workflow Run Step ---

export const WorkflowRunStepStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
export type WorkflowRunStepStatus = z.infer<typeof WorkflowRunStepStatusSchema>;

export const WorkflowRunStepSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  nodeId: z.string(),
  nodeType: z.string(),
  status: WorkflowRunStepStatusSchema,
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  retryCount: z.number().int().min(0).default(0),
  maxRetries: z.number().int().min(0).default(3),
  nextRetryAt: z.string().optional(),
  idempotencyKey: z.string().optional(),
  diagnostics: z.string().optional(),
  nextPort: z.string().optional(),
});
export type WorkflowRunStep = z.infer<typeof WorkflowRunStepSchema>;

// --- Wait State (workflow `wait` node side table) ---

export const WaitModeSchema = z.enum(["time", "event"]);
export type WaitMode = z.infer<typeof WaitModeSchema>;

export const WaitStateStatusSchema = z.enum(["pending", "fired", "timeout"]);
export type WaitStateStatus = z.infer<typeof WaitStateStatusSchema>;

/**
 * Row shape for `wait_states` table — keep in sync with
 * `src/be/migrations/049_wait_states.sql`.
 *
 * - `mode='time'`: `wakeUpAt` is set; `eventName`/`eventFilter`/`expiresAt` are null.
 * - `mode='event'`: `eventName` is set; `eventFilter` is optional (flat
 *   key/dot-path object OR arrow-fn body string); `expiresAt` is set when the
 *   wait carries a timeout.
 */
export const WaitStateRowSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  workflowRunStepId: z.string(),
  mode: WaitModeSchema,
  wakeUpAt: z.string().nullable(),
  eventName: z.string().nullable(),
  eventFilter: z.union([z.record(z.string(), z.unknown()), z.string()]).nullable(),
  expiresAt: z.string().nullable(),
  status: WaitStateStatusSchema,
  firedPayload: z.unknown().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  eventScope: z.enum(["run", "global"]),
});
export type WaitStateRow = z.infer<typeof WaitStateRowSchema>;

// ============================================================================
// Prompt Template Types
// ============================================================================

export const PromptTemplateScopeSchema = z.enum(["global", "agent", "repo"]);
export const PromptTemplateStateSchema = z.enum([
  "enabled",
  "default_prompt_fallback",
  "skip_event",
]);

export const PromptTemplateSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  scope: PromptTemplateScopeSchema,
  scopeId: z.string().nullable(),
  state: PromptTemplateStateSchema,
  body: z.string(),
  isDefault: z.boolean(),
  version: z.number(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

export const PromptTemplateHistorySchema = z.object({
  id: z.string(),
  templateId: z.string(),
  version: z.number(),
  body: z.string(),
  state: z.string(),
  changedBy: z.string().nullable(),
  changedAt: z.string(),
  changeReason: z.string().nullable(),
});
export type PromptTemplateHistory = z.infer<typeof PromptTemplateHistorySchema>;

// ============================================================================
// Script Types
// ============================================================================

export const ScriptScopeSchema = z.enum(["global", "agent"]);
export type ScriptScope = z.infer<typeof ScriptScopeSchema>;

export const ScriptFsModeSchema = z.enum(["none", "workspace-rw"]);
export type ScriptFsMode = z.infer<typeof ScriptFsModeSchema>;

export const ScriptRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: ScriptScopeSchema,
  scopeId: z.string().nullable(),
  source: z.string(),
  description: z.string(),
  intent: z.string(),
  signatureJson: z.string(),
  argsJsonSchema: z.string().nullable(),
  contentHash: z.string(),
  version: z.number(),
  isScratch: z.boolean(),
  typeChecked: z.boolean(),
  fsMode: ScriptFsModeSchema,
  createdByAgentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScriptRecord = z.infer<typeof ScriptRecordSchema>;

export const ScriptVersionRecordSchema = z.object({
  id: z.string(),
  scriptId: z.string(),
  version: z.number(),
  source: z.string(),
  description: z.string(),
  intent: z.string(),
  signatureJson: z.string(),
  contentHash: z.string(),
  changedByAgentId: z.string().nullable(),
  changedAt: z.string(),
  changeReason: z.string().nullable(),
});
export type ScriptVersionRecord = z.infer<typeof ScriptVersionRecordSchema>;

/** Lean projection served by `GET /api/scripts` — omits `source` (payload size) and raw JSON blobs. */
export type ScriptListItem = Omit<
  ScriptRecord,
  "source" | "signatureJson" | "argsJsonSchema" | "contentHash"
>;

/** Full record served by `GET /api/scripts/{id}` — includes `source` plus parsed `signature`/`argsJsonSchema`. */
export type ScriptDetail = Omit<ScriptRecord, "argsJsonSchema"> & {
  signature: unknown;
  argsJsonSchema: unknown;
};

// ─── External script APIs (POST /api/x/script/<id>) ──────────────────────────

export const ScriptApiAuthModeSchema = z.enum(["none", "bearer"]);
export type ScriptApiAuthMode = z.infer<typeof ScriptApiAuthModeSchema>;

/** A script exposed as an externally-callable HTTP endpoint. Never carries the token. */
export const ScriptApiRecordSchema = z.object({
  id: z.string(),
  scriptId: z.string(),
  agentId: z.string(),
  authMode: ScriptApiAuthModeSchema,
  enabled: z.boolean(),
  label: z.string().nullable(),
  callCount: z.number(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ScriptApiRecord = z.infer<typeof ScriptApiRecordSchema>;

/**
 * Returned once on create / rotate / reveal — includes the plaintext bearer
 * token (`null` for `authMode: 'none'`). The token is stored encrypted and only
 * materialized here for the dashboard's reveal + curl UX.
 */
export type ScriptApiWithSecret = ScriptApiRecord & { token: string | null };

// ============================================================================
// Skill Types
// ============================================================================

export const SkillTypeSchema = z.enum(["remote", "personal"]);
export type SkillType = z.infer<typeof SkillTypeSchema>;

export const SkillScopeSchema = z.enum(["global", "swarm", "agent"]);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  type: SkillTypeSchema,
  scope: SkillScopeSchema,
  ownerAgentId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceRepo: z.string().nullable(),
  sourcePath: z.string().nullable(),
  sourceBranch: z.string(),
  sourceHash: z.string().nullable(),
  isComplex: z.boolean(),
  allowedTools: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  context: z.string().nullable(),
  agent: z.string().nullable(),
  disableModelInvocation: z.boolean(),
  userInvocable: z.boolean(),
  version: z.number(),
  isEnabled: z.boolean(),
  systemDefault: z.boolean(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  lastFetchedAt: z.string().nullable(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const AgentSkillSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  skillId: z.string(),
  isActive: z.boolean(),
  installedAt: z.string(),
});
export type AgentSkill = z.infer<typeof AgentSkillSchema>;

export const SkillWithInstallInfoSchema = SkillSchema.extend({
  isActive: z.boolean(),
  installedAt: z.string(),
});
export type SkillWithInstallInfo = z.infer<typeof SkillWithInstallInfoSchema>;

export const SkillFileSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  path: z.string(),
  content: z.string(),
  mimeType: z.string(),
  isBinary: z.boolean(),
  size: z.number().nullable(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;

// ── MCP Servers ──────────────────────────────────────────────────────────

export const McpServerTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;

export const McpServerScopeSchema = z.enum(["global", "swarm", "agent"]);
export type McpServerScope = z.infer<typeof McpServerScopeSchema>;

export const McpAuthMethodSchema = z.enum(["static", "oauth", "auto"]);
export type McpAuthMethod = z.infer<typeof McpAuthMethodSchema>;

export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scope: McpServerScopeSchema,
  ownerAgentId: z.string().nullable(),
  transport: McpServerTransportSchema,
  command: z.string().nullable(),
  args: z.string().nullable(),
  url: z.string().nullable(),
  headers: z.string().nullable(),
  envConfigKeys: z.string().nullable(),
  headerConfigKeys: z.string().nullable(),
  extraAuthorizeParams: z.string().nullable(),
  authMethod: McpAuthMethodSchema.default("static"),
  isEnabled: z.boolean(),
  version: z.number(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const AgentMcpServerSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  mcpServerId: z.string(),
  isActive: z.boolean(),
  installedAt: z.string(),
});
export type AgentMcpServer = z.infer<typeof AgentMcpServerSchema>;

export const McpServerWithInstallInfoSchema = McpServerSchema.extend({
  isActive: z.boolean(),
  installedAt: z.string(),
});
export type McpServerWithInstallInfo = z.infer<typeof McpServerWithInstallInfoSchema>;

// ============================================================================
// Context Usage Tracking Types
// ============================================================================

export const ContextSnapshotEventTypeSchema = z.enum(["progress", "compaction", "completion"]);
export type ContextSnapshotEventType = z.infer<typeof ContextSnapshotEventTypeSchema>;

// Migration 063: the formula the emitting adapter used to compute
// contextUsedTokens. Lets downstream consumers (UI badges, cross-provider
// comparisons) reason about whether two numbers are commensurable. Values
// match the inline doc in `src/be/migrations/063_cost_context_schema_relax.sql`.
export const ContextFormulaSchema = z.enum([
  "input-cache-output", // unified formula (post-Phase 9)
  "input-cache-no-output", // pre-unification claude formula
  "input-output-no-cache", // pre-unification claude-managed formula
  "peak-proxy", // pre-unification codex formula
  "pi-delegated", // numbers come from the pi-ai SDK
  "harness-reported", // numbers come from a harness API (devin)
  "unknown", // pre-migration backfill or adapter didn't tag
]);
export type ContextFormula = z.infer<typeof ContextFormulaSchema>;

export const ContextSnapshotSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  agentId: z.uuid(),
  sessionId: z.string(),

  // Context window state
  contextUsedTokens: z.number().int().min(0).optional(),
  contextTotalTokens: z.number().int().min(0).optional(),
  contextPercent: z.number().min(0).max(100).optional(),

  // Event metadata
  eventType: ContextSnapshotEventTypeSchema,

  // Compaction-specific (null for non-compaction)
  compactTrigger: z.enum(["auto", "manual", "auto-inferred"]).optional(),
  preCompactTokens: z.number().int().min(0).optional(),

  // Cumulative counters at this point
  cumulativeInputTokens: z.number().int().min(0).default(0),
  cumulativeOutputTokens: z.number().int().min(0).default(0),

  // Migration 063 — adapter stamps the formula it used to compute
  // contextUsedTokens. Optional so old rows / new providers without a tag
  // don't break, but every adapter should populate this going forward.
  contextFormula: ContextFormulaSchema.optional(),

  createdAt: z.iso.datetime(),
});

export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

// ============================================================================
// Budgets + Pricing (per-agent daily cost budget — V1)
// ============================================================================
//
// Timestamp convention for these schemas: number = epoch milliseconds (UTC).
// This is a deliberate divergence from the rest of types.ts (which uses
// `z.iso.datetime()` strings) so that the price-book "largest
// effective_from <= now" lookup is a pure integer comparison. Matches the
// SQL columns in migration 046_budgets_and_pricing.sql verbatim.

export const BudgetScopeSchema = z.enum(["global", "agent", "user"]);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

export const BudgetSchema = z.object({
  scope: BudgetScopeSchema,
  scopeId: z.string(), // '' (empty string) for the global row
  dailyBudgetUsd: z.number().nonnegative(),
  createdAt: z.number(), // epoch ms
  lastUpdatedAt: z.number(), // epoch ms
});
export type Budget = z.infer<typeof BudgetSchema>;

// Migration 063 widened both enums and dropped the SQL CHECKs to match.
// New providers can land without an accompanying schema migration; Zod is now
// the single source of truth for what's a valid (provider, token_class) row.
export const PricingProviderSchema = z.enum([
  "claude",
  "claude-managed",
  "codex",
  "pi",
  "opencode",
  "devin",
  "gemini",
]);
export type PricingProvider = z.infer<typeof PricingProviderSchema>;

export const PricingTokenClassSchema = z.enum([
  "input",
  "cached_input",
  "output",
  // Migration 063 additions:
  "cache_write", // claude / claude-managed cache creation
  "runtime_hour", // claude-managed runtime fee per hour
  "acu", // devin Agent Compute Unit
]);
export type PricingTokenClass = z.infer<typeof PricingTokenClassSchema>;

export const PricingRowSchema = z.object({
  provider: PricingProviderSchema,
  model: z.string(),
  tokenClass: PricingTokenClassSchema,
  effectiveFrom: z.number().nonnegative(), // epoch ms; 0 = seed
  pricePerMillionUsd: z.number().nonnegative(),
  createdAt: z.number(), // epoch ms
  lastUpdatedAt: z.number(), // epoch ms
});
export type PricingRow = z.infer<typeof PricingRowSchema>;

export const BudgetRefusalCauseSchema = z.enum(["agent", "global", "user"]);
export type BudgetRefusalCause = z.infer<typeof BudgetRefusalCauseSchema>;

export const BudgetRefusalNotificationSchema = z.object({
  taskId: z.string(),
  date: z.string(), // 'YYYY-MM-DD' UTC
  agentId: z.string(),
  cause: BudgetRefusalCauseSchema,
  agentSpendUsd: z.number().nullable().optional(),
  agentBudgetUsd: z.number().nullable().optional(),
  globalSpendUsd: z.number().nullable().optional(),
  globalBudgetUsd: z.number().nullable().optional(),
  userSpendUsd: z.number().nullable().optional(),
  userBudgetUsd: z.number().nullable().optional(),
  followUpTaskId: z.string().nullable().optional(),
  createdAt: z.number(), // epoch ms
});
export type BudgetRefusalNotification = z.infer<typeof BudgetRefusalNotificationSchema>;

/**
 * Phase 3 — `budget_refused` is the new variant of the `/api/poll` trigger
 * envelope returned when an admission gate (`canClaim`) refuses to let the
 * agent take a task. Older workers receiving this discriminator fall through
 * to default polling without back-off (degrades gracefully); Phase 4 teaches
 * the runner to recognize it.
 */
export const BudgetRefusedTriggerSchema = z.object({
  type: z.literal("budget_refused"),
  cause: BudgetRefusalCauseSchema,
  agentSpend: z.number().optional(),
  agentBudget: z.number().optional(),
  globalSpend: z.number().optional(),
  globalBudget: z.number().optional(),
  userSpend: z.number().optional(),
  userBudget: z.number().optional(),
  resetAt: z.string(), // ISO 8601, next UTC midnight
});
export type BudgetRefusedTrigger = z.infer<typeof BudgetRefusedTriggerSchema>;

// ─── KV store ────────────────────────────────────────────────────────────────

/**
 * `value_type` of a KV entry.
 *
 *  - `'json'`    — `value` is JSON-encoded; default.
 *  - `'string'`  — `value` is the raw UTF-8 string verbatim.
 *  - `'integer'` — `value` is the decimal-string form of a JS-safe integer.
 *                  Required by INCR; mixing with 'json'/'string' returns 409.
 */
export const KvValueTypeSchema = z.enum(["json", "string", "integer"]);
export type KvValueType = z.infer<typeof KvValueTypeSchema>;

/** Shared regex for both namespace and key — keeps colons/slashes welcome for
 * sub-namespacing inside a single key. Matches the `contextKey` schema in
 * `src/tasks/context-key.ts`; we don't enforce it parses as a known family.
 *
 * `%` is accepted because path-segment params arrive percent-encoded on the
 * REST surface (e.g. `:` → `%3A` after `encodeURIComponent`); the kv handler
 * decodes the segment before persisting, and the decoded form is itself a
 * subset of this regex (no `%` chars in legal contextKeys).
 */
export const KV_NAME_REGEX = /^[a-zA-Z0-9._:/%-]{1,512}$/;

export const KvNamespaceSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(KV_NAME_REGEX, "namespace must match [a-zA-Z0-9._:/%-]{1,512}");

export const KvKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(KV_NAME_REGEX, "key must match [a-zA-Z0-9._:/%-]{1,512}");

/**
 * A single KV row, as returned by the API. `value` is decoded per
 * `valueType`: `'json'` returns the parsed JS value, `'string'` returns the
 * raw string, `'integer'` returns a number.
 */
export const KvEntrySchema = z.object({
  namespace: z.string(),
  key: z.string(),
  value: z.unknown(),
  valueType: KvValueTypeSchema,
  expiresAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type KvEntry = z.infer<typeof KvEntrySchema>;

// ── Event subscriptions (extension system, Layer 1) ─────────────────────────
// Keep in sync with src/be/migrations/117_swarm_events_subscriptions.sql
// CHECK constraints (targetType ∈ {script, workflow}; delivery status ∈
// {pending, running, succeeded, failed}).

export const SubscriptionTargetTypeSchema = z.enum(["script", "workflow"]);
export type SubscriptionTargetType = z.infer<typeof SubscriptionTargetTypeSchema>;

export const SubscriptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /**
   * Glob over dot-separated event names: `*` matches one segment,
   * `**` (last segment only) matches the rest. e.g. "task.*", "github.**".
   */
  eventPattern: z.string(),
  /**
   * Optional payload filter using the wait-node filter language: either an
   * object of dot-path → expected value, or a string expression compiled by
   * src/workflows/wait-filter.ts.
   */
  filter: z.unknown().optional(),
  targetType: SubscriptionTargetTypeSchema,
  scriptName: z.string().optional(),
  scriptArgs: z.record(z.string(), z.unknown()).optional(),
  workflowId: z.string().optional(),
  enabled: z.boolean(),
  createdByAgentId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const SwarmBusEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  data: z.unknown().optional(),
  emittedAt: z.string(),
});
export type SwarmBusEvent = z.infer<typeof SwarmBusEventSchema>;

export const SubscriptionDeliveryStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export type SubscriptionDeliveryStatus = z.infer<typeof SubscriptionDeliveryStatusSchema>;

export const SubscriptionDeliverySchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  eventId: z.string(),
  status: SubscriptionDeliveryStatusSchema,
  attempts: z.number().int(),
  claimedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  result: z.unknown().optional(),
  createdAt: z.string(),
});
export type SubscriptionDelivery = z.infer<typeof SubscriptionDeliverySchema>;
