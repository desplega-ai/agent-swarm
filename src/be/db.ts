import {
  type CreateSessionCostInput,
  insertSessionCost,
  rowToSessionCost,
} from "./db/session-costs";

export {
  type CreateSessionCostInput,
  insertSessionCost,
  SessionCostConflictError,
} from "./db/session-costs";

import type { Database } from "bun:sqlite";
import type {
  ApiKeyRef,
  ApiKeyStatusRow,
  AppVersionRow,
  AssetKeyMappingRow,
  BudgetRefusalNotificationRow as BudgetRefusalNotificationRowDb,
  BudgetRow as BudgetRowDb,
  ChannelActivityCursorRow,
  ContextSnapshotRow,
  InboxItemStateRow,
  KvJsonFieldFilter,
  KvKeyRange,
  McpServerRow,
  McpServerWithInstallRow,
  MetricColumnUpdate,
  MetricRow,
  MetricVersionRow,
  PageColumnUpdate,
  PageRow,
  PageVersionRow,
  PricingRowDb,
  RoutingCandidateMatch,
  ScheduledTaskColumnUpdate,
  ScheduledTaskRow,
  ScriptRunColumnUpdate,
  ScriptRunJournalRow,
  ScriptRunListRow,
  ScriptRunRow,
  SessionCostSummaryFilter,
  SessionLogRow,
  SkillFileRow,
  SkillRow,
  SkillWithInstallRow,
  SlackMessageRow,
  SwarmConfigRow,
  SwarmRepoColumnUpdate,
  SwarmRepoRow,
  TaskAttachmentRow,
  TaskSteeringMessageRow,
  TaskTemplateRow,
} from "@desplega/storage";
import { type AttributionWindow, SKILL_SLIM_COLUMNS } from "@desplega/storage";
import pkg from "../../package.json";
import { defaultAssetKey, normalizeAssetKey } from "../assets/key";
import { sessionSourceKey, sessionThreadGroupKey } from "../assets/source-key";
import {
  generateDefaultClaudeMd,
  generateDefaultIdentityMd,
  matchesDefaultClaudeMd,
  matchesDefaultIdentityMd,
} from "../prompts/defaults";
import { realtimeBus } from "../realtime/bus";
import { TaskRoutingAuthorizationError } from "../tasks/errors";
import { slackChannelFromContextKey } from "../tasks/slack-routing";
import { _resolveIntegrationType, emitIntegrationConnected, telemetry } from "../telemetry";
import { invalidateTelemetryUserRole, scheduleOrgDomainRecompute } from "../telemetry-identity";
import {
  emitTaskTelemetry,
  type TaskTelemetryEvent,
  type TaskTelemetryInput,
} from "../telemetry-trigger";
import type {
  ActiveSession,
  Agent,
  AgentAvatar,
  AgentLog,
  AgentLogEventType,
  AgentMcpServer,
  AgentSkill,
  AgentSlackIcon,
  AgentStatus,
  AgentTask,
  AgentTaskStatus,
  AgentTaskSummary,
  AgentWithTasks,
  AssetEntityType,
  AssetKeyMapping,
  AssetSummary,
  AutomationIntegrationId,
  Budget,
  BudgetRefusalCause,
  BudgetRefusalNotification,
  BudgetScope,
  Channel,
  ChannelMessage,
  ChannelType,
  ContextSnapshot,
  ContextSnapshotEventType,
  CooldownConfig,
  FavoriteItemType,
  InboxItemState,
  InboxItemStatus,
  InboxItemType,
  InboxMessage,
  InboxMessageStatus,
  InputValue,
  KvEntry,
  KvValueType,
  McpServer,
  McpServerScope,
  McpServerTransport,
  McpServerWithInstallInfo,
  Metric,
  MetricDefinition,
  MetricSnapshot,
  MetricSummary,
  MetricVersion,
  Page,
  PageAuthMode,
  PageContentType,
  PageSnapshot,
  PageSummary,
  PageVersion,
  PricingProvider,
  PricingRow,
  PricingTokenClass,
  ProfileExpectedHashes,
  ProfileSyncConflict,
  PromptTemplate,
  PromptTemplateHistory,
  ProviderName,
  RepoGuidelines,
  ScheduledTask,
  ScheduledTaskSummary,
  ScriptRun,
  ScriptRunJournalEntry,
  ScriptRunKind,
  ScriptRunListItem,
  ScriptRunStatus,
  Service,
  ServiceStatus,
  SessionCost,
  SessionLog,
  Skill,
  SkillFile,
  SkillScope,
  SkillType,
  SkillWithInstallInfo,
  SteeringMessage,
  SteeringSource,
  SteeringStatus,
  SteerMode,
  SwarmConfig,
  SwarmRepo,
  TaskAttachment,
  TaskTemplate,
  TaskTemplateKind,
  TriggerConfig,
  User,
  UserFavorite,
  VersionableField,
  VersionMeta,
  WaitMode,
  WaitStateRow,
  WaitStateStatus,
  Workflow,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowRunStepStatus,
  WorkflowSnapshot,
  WorkflowSummary,
  WorkflowVersion,
} from "../types";
import {
  type CreateTaskOptions,
  CreateTaskOptionsSchema,
  isTerminalTaskStatus,
  type ModelTier,
  OPEN_TASK_STATUSES,
  parseModelTier,
  SERVER_GENERATED_ATTACHMENT_CAPABILITY,
  type UserAvatar,
} from "../types";
import {
  CODEX_AUTH_FAILURE_BENCH_MS,
  CODEX_AUTH_FAILURE_BENCH_THRESHOLD,
  CODEX_AUTH_WATCH_NAMESPACE,
  codexAuthBenchMarkerKey,
} from "../utils/codex-auth-failure";
import {
  defaultExportToEnv,
  effectiveExportToEnv,
  envExportRestrictedError,
  isEnvExportRestrictedKey,
} from "../utils/config-env-export";
import { MASKED_SECRET_VALUE } from "../utils/config-secrets";
import { deriveProviderFromKeyType } from "../utils/credentials";
import type { RateLimitWindowTelemetry, SpendCap } from "../utils/error-tracker";
import { getGitHubHostForSql } from "../utils/github-host";
import { extractGitHubPullRequestUrls } from "../utils/github-pull-request";
import { validateHeartbeatExpiry } from "../utils/heartbeat-expiry";
import {
  type BudgetedIdentityField,
  checkIdentityFieldBudget,
  IdentityFieldBudgetError,
} from "../utils/identity-field-budget";
import { keyPaceFromWindows, keyUsageFromWindows } from "../utils/key-usage";
import { activeModelBlock, type ModelFamily } from "../utils/model-rate-limit-windows";
import { isEffectiveOutputSchema } from "../utils/output-schema";
import {
  applyProviderQuotaReport,
  assertProviderQuotaCapacity,
  type ProviderAccountTelemetry,
  parseProviderAccount,
  type RateLimitReplacement,
  scrubProviderQuotaReport,
} from "../utils/provider-account-telemetry";
import { extractReasoning } from "../utils/reasoning-events";
import { getCurrentRequestUserId, getCurrentRunProvenance } from "../utils/request-auth-context";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import {
  registerSensitiveKeyName,
  type ScrubbedText,
  scrubSecrets,
} from "../utils/secret-scrubber";
import {
  codexPlanFromClaim,
  planAllowsModelFamily,
  SUBSCRIPTION_KEY_TYPES,
} from "../utils/subscription-plans";
import { auditAssetKeys, auditAssetKeysAsync } from "./asset-key-audit";
import { decryptSecret, encryptSecret, getEncryptionKey } from "./crypto";
import { normalizeDate, normalizeDateRequired } from "./date-utils";
import {
  type AgentRow,
  configureAgentDependencies,
  ExtensionAgentAssignmentError,
  getActiveTaskCount,
  getAgentById,
  getAllAgents,
  isAgentEligibleForTask,
  isExtensionAgent,
  ReservedAgentRoleError,
  reservedRoleViolation,
  rowToAgent,
} from "./db/agents";
import {
  type ApprovalRequestListFilters,
  type ApprovalVote,
  approvalListFilter,
  scheduleApprovalCardUpdates,
  scrubApprovalVotesJson,
} from "./db/approvals";
import {
  computeContentHash,
  createContextVersion,
  getLatestContextVersion,
} from "./db/context-versions";
import { clearAgentModelProfileOnOverrideChange } from "./db/model-profiles";
import { pageFilter } from "./db/page-search";
import { parsePageThemeTokens } from "./db/page-theme-tokens";
import {
  newPromptTemplateRows,
  type PromptTemplateUpsert,
  resetPromptTemplateRows,
  rowToPromptTemplate,
} from "./db/prompt-templates";
import { isPostgresEngine } from "./db/runtime";
import { storeScriptRunSource } from "./db/script-run-sources";
import { classifyClaudeUpdate } from "./db/session-log-reasoning";
import {
  assertAssetKeyMovesAllowed,
  configureSessionMoveDependencies,
  moveTaskChainKeyInTx,
} from "./db/session-moves";
import {
  countSessionRoots,
  listSessionPageRows,
  type SessionFilters,
  type SessionReadState,
  type SessionRowFields,
  sessionPageFields,
} from "./db/session-tree";
import { searchSkillRowsRanked } from "./db/skill-search";
import { taskAttachmentWrite } from "./db/tasks/attachment-write";
import { getEligibilityScanCap } from "./db/tasks/eligibility-scan";
import { classifyTaskHumanFree, reclassifyTaskHumanFree } from "./db/tasks/human-free";
import {
  type AgentTaskRow,
  configureTaskReadDependencies,
  type ExistingTrackerContextWork,
  findExistingLinearTrackerContextWork,
  getTaskById,
  getTasksByAgentId,
  isLinearTrackerContextKey,
  rowToAgentTask,
  rowToAgentTaskSummary,
} from "./db/tasks/read";
import { configureTaskWriteDependencies, failTask } from "./db/tasks/write";
import { parseUserAvatar } from "./db/users/avatar";
import { tombstoneWorkflowIdempotencyKeys } from "./db/workflow-idempotency";
import { deleteOrphanedRunDefinitions } from "./db/workflow-run-definitions";
import {
  emitChildRunFinished,
  emitRunFinished,
  getRunLineageBlock,
  getStepExecutionBlock,
  isTerminalWorkflowRunStatus,
  rowToWorkflowRun,
  rowToWorkflowRunStep,
  WorkflowStepNotExecutableError,
  wakeParentsOfDeletedRuns,
} from "./db/workflow-runs";
import { rowToWorkflow, type WorkflowRow } from "./db/workflows/read";
import { scrubJsonValue } from "./scrub-json";
import { openSealedJson, sealedJsonForDisplay, sealJson } from "./sealed-json";
import { configSecretName, registerStoredSecret } from "./secret-registry";
import { promotePendingSteeringForTask } from "./steering";
import { getStorage } from "./storage";
import {
  currentEngineHandle,
  listPlaintextSecretConfigs,
  storeEncryptedSecretConfigs,
} from "./storage-root";
import {
  invalidConfigKeyError,
  isApiProcessControlEnvKey,
  isInternalConfigKey,
  isReservedConfigKey,
  reservedKeyError,
  TEAMS_SDK_ENV_KEYS,
} from "./swarm-config-guard";
import { emitTaskStarted } from "./task-lifecycle-events";
import { publishWorkerConfigNudge, publishWorkerNudge } from "./worker-nudges";
import type { WorkflowPayloadView } from "./workflow-replay";

export {
  refreshActiveSessionOnActivity,
  SESSION_ACTIVITY_REFRESH_MIN_INTERVAL_MS,
} from "./db/active-sessions";
export {
  AgentDeletedError,
  buildRoutingAffinityFromAgent,
  createAgent,
  deleteAgent,
  EXTENSION_AGENT_ROLE,
  ExtensionAgentAssignmentError,
  extensionAgentAssignmentError,
  getActiveTaskCount,
  getAgentById,
  getAgentDailyTaskCounts,
  getAgentHarnessProviders,
  getAgentStatusCounts,
  getAllAgents,
  getLeadAgent,
  getRemainingCapacity,
  hasCapacity,
  incrementEmptyPollCount,
  isAgentDeleted,
  isAgentEligibleForTask,
  isExtensionAgent,
  isPoolAffinityEnforcementEnabled,
  listAgentsWithCredStatusByProvider,
  MAX_EMPTY_POLLS,
  NOT_EXTENSION_AGENT_SQL,
  ReservedAgentRoleError,
  reservedRoleViolation,
  resetEmptyPollCount,
  setAgentHarnessProvider,
  shouldBlockPolling,
  updateAgentActivity,
  updateAgentCredentialMissing,
  updateAgentCredentialState,
  updateAgentCredStatus,
  updateAgentMaxTasks,
  updateAgentProvider,
  updateAgentStatus,
  updateAgentStatusFromCapacity,
} from "./db/agents";
export { recordKeySeatMismatch, recordKeyValidation } from "./db/api-keys";
export {
  type ApprovalRequestSummary,
  type ApprovalVote,
  getPendingApprovalsForTasks,
  getPendingApprovalVoteState,
  listApprovalRequestSummaries,
  recordApprovalVotes,
} from "./db/approvals";
export {
  computeContentHash,
  createContextVersion,
  getContextVersion,
  getContextVersionHistory,
  getLatestContextVersion,
} from "./db/context-versions";
export {
  getScriptRunExecutionArgs,
  getScriptRunFollowUpGuard,
  setScriptRunFollowUpGuard,
} from "./db/script-runs";

import type { ScriptRunFilter } from "./db/script-runs";

export {
  AssetKeyMovesBlockedError,
  assertAssetKeyMovesAllowed,
  moveTaskChainKeyInTx,
} from "./db/session-moves";
export { setSkillUpdatedBy } from "./db/skill-audit";
export {
  getRunWorkflow,
  PINNED_WORKFLOW_KEYS,
  type PinnedWorkflowDefinition,
  pinWorkflowDefinition,
  toPinnedDefinition,
} from "./db/workflow-run-definitions";
export { getWorkflowsByEventName } from "./db/workflows/read";

configureAgentDependencies({
  createLogEntry: (entry) => createLogEntry(entry),
  installSystemDefaultSkillsForAgent: (agentId) => installSystemDefaultSkillsForAgent(agentId),
  // Lazy: the importer imports this facade.
  resolvePendingImportAssignments: async (agent) =>
    (await import("./import/pending")).resolvePendingImportAssignments(agent),
});

export {
  __resetSqliteVecExtensionPathCacheForTests,
  closeDatabase,
  closeDb,
  getDb,
  getDbClient,
  initDb,
  isPostgresEngine,
  isSqliteVecAvailable,
  isVectorSearchAvailable,
  resolveSqliteVecExtensionPath,
  startPostgres,
} from "./db/runtime";

export {
  countAgentDispatchesInThread,
  type ExistingTrackerContextWork,
  type ExistingTrackerContextWorkReason,
  findActiveTasksByVcs,
  findCompletedTasksInThread,
  findExistingLinearTrackerContextWork,
  findRecentCancelledTaskInThread,
  findRecentFailedTaskInThread,
  findTaskByGitHub,
  findTaskByVcs,
  getAgentCurrentTask,
  getAgentWorkingOnContextKey,
  getAgentWorkingOnThread,
  getAllTasks,
  getChildTasks,
  getCompletedSlackTasks,
  getFirstTaskInThread,
  getInProgressSlackTasks,
  getInProgressTasksByContextKey,
  getLatestActiveTaskByContextKey,
  getLatestActiveTaskInThread,
  getLatestLeadTaskByContextKey,
  getLatestLeadTaskInThread,
  getLatestScriptRunStepTaskByContextKey,
  getLatestTaskByContextKey,
  getLatestTaskByContextKeyPrefix,
  getMostRecentTaskInThread,
  getPendingChatRelayTasks,
  getPendingSlackRelayTasks,
  getRecentlyFinishedWorkerTasks,
  getSlackTasksMissingTree,
  getSupersededTasksWithoutResume,
  getSupersededTasksWithUnsettledDependents,
  getTaskById,
  getTaskLineage,
  getTaskStats,
  getTasksByAgentId,
  getTasksByStatus,
  getTasksCount,
  getTasksDispatchedFrom,
  giveUpStaleChatRelays,
  hasNonTerminalRerouteDecisionChild,
  hasNonTerminalResumeChild,
  isLinearTrackerContextKey,
  markChatRelayAttempted,
  markChatRelayDelivered,
  markChatRelayGivenUp,
  markFinalizedSlackRelaysDelivered,
  markSlackRelayAttempted,
  markSlackRelayDelivered,
  markTasksNotified,
  type PendingChatRelay,
  recordChatRelayError,
  resetTasksNotified,
  SUPERSEDED_RESUME_REPAIR_WINDOW_MS,
  TASK_LINEAGE_LIMITS,
  type TaskFilters,
} from "./db/tasks/read";

export {
  assignUnassignedTaskPending,
  backfillSupersedeTaskResumeTaskId,
  cancelTask,
  completeTask,
  createTask,
  deleteTask,
  failTask,
  getOrphanedInProgressTasksForAgent,
  getPausedTasksForAgent,
  getPendingTaskForAgent,
  getRecentlyCancelledTasksForAgent,
  markWorkflowStepTaskSuperseded,
  overwriteTerminalTaskResultText,
  pauseTask,
  recordTaskProviderIfUnset,
  resetOrphanedInProgressTasksForAgent,
  resumeTask,
  setTaskTitleIfUnset,
  settleSupersededTaskDependents,
  skipTask,
  startTask,
  supersedeTask,
  updateTaskClaudeSessionId,
  updateTaskProgress,
  updateTaskTags,
  updateTaskTitle,
} from "./db/tasks/write";

configureTaskWriteDependencies({
  createLogEntry: (...args) => createLogEntry(...args),
  checkDependencies: (...args) => checkDependencies(...args),
  reconcileTaskPullRequestAttachments: (...args) => reconcileTaskPullRequestAttachments(...args),
  emitTaskLifecycleTelemetryAfterCommit: (...args) =>
    emitTaskLifecycleTelemetryAfterCommit(...args),
  taskContextForTelemetry: (...args) => taskContextForTelemetry(...args),
  promotePendingSteeringForTask: (...args) => promotePendingSteeringForTask(...args),
  cascadeFailDependents: (...args) => cascadeFailDependents(...args),
});

configureSessionMoveDependencies({
  auditAssetKeys: () =>
    isPostgresEngine()
      ? auditAssetKeysAsync()
      : auditAssetKeys(currentEngineHandle() as Parameters<typeof auditAssetKeys>[0]),
  insertAssetKeyHistory: (...args) => insertAssetKeyHistory(...args),
});

configureTaskReadDependencies({
  checkDependencies: (taskId) => checkDependencies(taskId),
  assetKeyPrefixPattern: (input) => assetKeyPrefixPattern(input),
  previewText: (text, maxChars) => previewText(text, maxChars),
});

type TaskTelemetryContext = {
  provider?: ProviderName;
  harnessVariant?: string;
  harnessVersion?: string;
};

/** LIKE pattern matching strings that start with `prefix` literally (use with `ESCAPE '\\'`). */
export function literalPrefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
}

function assetKeyPrefixPattern(input: string): string {
  return literalPrefixPattern(normalizeAssetKey(input));
}

function emitTaskLifecycleTelemetryAfterCommit<S extends TaskTelemetryEvent>(
  event: S,
  props: TaskTelemetryInput<S>,
  verify?: (task: AgentTask | null) => boolean,
  actorUserId?: string | null,
): void {
  // afterCommit (not queueMicrotask): under an async client transaction,
  // microtasks drain before COMMIT, so the verify read could observe
  // uncommitted state. afterCommit runs strictly post-COMMIT/ROLLBACK.
  getStorage().afterCommit(() => {
    // `trigger_surface` is resolved (one read up the parent chain) and
    // `source` renamed to `task_source` inside emitTaskTelemetry, so every
    // lifecycle event of a task reports the same root surface.
    if (!verify) {
      void emitTaskTelemetry(event, props, actorUserId);
      return;
    }
    getTaskById((props as { taskId: string }).taskId)
      .then((task) => {
        if (!verify(task)) return;
        return emitTaskTelemetry(event, props, actorUserId);
      })
      .catch((err) =>
        console.error(
          "[db] emitTaskLifecycleTelemetryAfterCommit verify read failed:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        ),
      );
  });
}

function taskContextForTelemetry(task: AgentTask): TaskTelemetryContext {
  const harnessVersion = task.harnessVariantMeta?.version;
  const context: TaskTelemetryContext = {};
  if (task.provider) context.provider = task.provider;
  if (task.harnessVariant) context.harnessVariant = task.harnessVariant;
  if (typeof harnessVersion === "string" || typeof harnessVersion === "number") {
    context.harnessVersion = String(harnessVersion);
  }
  return context;
}

// ============================================================================
// Context Versioning
// ============================================================================

const VERSIONABLE_FIELDS: VersionableField[] = [
  "soulMd",
  "identityMd",
  "toolsMd",
  "claudeMd",
  "setupScript",
  "heartbeatMd",
];

const BUDGETED_IDENTITY_FIELDS: BudgetedIdentityField[] = [
  "soulMd",
  "identityMd",
  "claudeMd",
  "toolsMd",
];

// ============================================================================
// AgentTask Queries
// ============================================================================

export async function getSlackRenderV2ActivatedAt(): Promise<string | null> {
  const row = await getStorage().repos.slack.getRenderV2State();
  return row?.activated_at ?? null;
}

export async function ensureSlackRenderV2Activation(): Promise<string> {
  const activatedAt = new Date().toISOString();
  await getStorage().repos.slack.ensureRenderV2Activation(activatedAt);
  const persisted = await getSlackRenderV2ActivatedAt();
  if (!persisted) throw new Error("Failed to persist Slack render v2 activation");
  return persisted;
}

export async function getSlackDelegationActivatedAt(): Promise<string | null> {
  const row = await getStorage().repos.slack.getRenderV2State();
  return row?.delegation_activated_at ?? null;
}

export async function ensureSlackDelegationActivation(): Promise<string> {
  const activatedAt = new Date().toISOString();
  await getStorage().repos.slack.ensureDelegationActivation(activatedAt);
  const persisted = await getSlackDelegationActivatedAt();
  if (!persisted) throw new Error("Failed to persist Slack render v2 delegation activation");
  return persisted;
}

export type SlackMessageKind = "tree" | "outcome" | "agent";
export type SlackConclusionKind = "complete" | "timeout";

export interface SlackMessageRecord {
  id: string;
  contextKey: string;
  channelId: string;
  threadTs: string;
  ts: string;
  kind: SlackMessageKind;
  taskId?: string;
  permalink?: string;
  finalizedAt?: string;
  streamChunksAppended: number;
  conclusionKind?: SlackConclusionKind;
  /** Set once a deferral card has been rewritten into its resolved state. */
  deferralResolvedAt?: string;
  /** Set with `deferralResolvedAt` when the rewrite was given up on. */
  deferralAbandonedAt?: string;
  /** Failed delivery attempts for this outcome card, across restarts. */
  deliveryAttempts: number;
  /** Set once the renderer gave up on delivering this outcome card. */
  deliveryAbandonedAt?: string;
  /** Last Slack verdict for the card, "<code>: <messages>", 500 chars max. */
  deliveryLastError?: string;
  /** Tree rows only: set once the thread has no render work left. */
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

const PENDING_SLACK_MESSAGE_TS_PREFIX = "pending:";

export function isPendingSlackMessage(record: SlackMessageRecord): boolean {
  return record.ts.startsWith(PENDING_SLACK_MESSAGE_TS_PREFIX);
}

/** True when the renderer must not touch this card again: delivered, or given up on. */
export function isSettledSlackMessage(record: SlackMessageRecord): boolean {
  return !!record.finalizedAt || !!record.deliveryAbandonedAt;
}

function rowToSlackMessage(row: SlackMessageRow): SlackMessageRecord {
  return {
    id: row.id,
    contextKey: row.context_key,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    ts: row.ts,
    kind: row.kind as SlackMessageKind,
    taskId: row.task_id ?? undefined,
    permalink: row.permalink ?? undefined,
    finalizedAt: row.finalized_at ?? undefined,
    streamChunksAppended: row.stream_chunks_appended,
    conclusionKind: (row.conclusion_kind as SlackConclusionKind | null) ?? undefined,
    deferralResolvedAt: row.deferral_resolved_at ?? undefined,
    deferralAbandonedAt: row.deferral_abandoned_at ?? undefined,
    deliveryAttempts: row.delivery_attempts,
    deliveryAbandonedAt: row.delivery_abandoned_at ?? undefined,
    deliveryLastError: row.delivery_last_error ?? undefined,
    closedAt: row.closed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordSlackMessage(input: {
  contextKey: string;
  channelId: string;
  threadTs: string;
  ts: string;
  kind: SlackMessageKind;
  taskId?: string;
  permalink?: string;
  finalized?: boolean;
  streamChunksAppended?: number;
  conclusionKind?: SlackConclusionKind;
  actorId?: string;
}): Promise<SlackMessageRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = await getStorage().repos.slack.recordSlackMessage({
    id,
    context_key: input.contextKey,
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    ts: input.ts,
    kind: input.kind,
    task_id: input.taskId ?? null,
    permalink: input.permalink ?? null,
    finalized_at: input.finalized ? now : null,
    stream_chunks_appended: input.streamChunksAppended ?? 0,
    conclusion_kind: input.conclusionKind ?? null,
    now,
    actor: input.actorId ?? null,
  });
  if (!row) throw new Error("Failed to record Slack message");
  return rowToSlackMessage(row);
}

export async function reserveSlackMessage(input: {
  contextKey: string;
  channelId: string;
  threadTs: string;
  kind: "tree" | "outcome";
  taskId?: string;
  actorId?: string;
}): Promise<{ record: SlackMessageRecord; created: boolean }> {
  if (input.kind === "outcome" && !input.taskId) {
    throw new Error("Outcome Slack message reservations require a task ID");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const pendingTs = `${PENDING_SLACK_MESSAGE_TS_PREFIX}${id}`;
  const inserted = await getStorage().repos.slack.reserveSlackMessage({
    id,
    context_key: input.contextKey,
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    ts: pendingTs,
    kind: input.kind,
    task_id: input.taskId ?? null,
    now,
    actor: input.actorId ?? null,
  });
  if (inserted) return { record: rowToSlackMessage(inserted), created: true };

  const existing =
    input.kind === "tree"
      ? await getSlackTreeMessageByThread(input.channelId, input.threadTs)
      : await getSlackOutcomeMessage(input.taskId!);
  if (!existing) throw new Error("Failed to reserve Slack message");
  return { record: existing, created: false };
}

export async function bindSlackMessageTimestamp(
  id: string,
  ts: string,
  options: { streamChunksAppended?: number; renderedThrough?: string } = {},
): Promise<SlackMessageRecord | null> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.slack.bindSlackMessageTimestamp(
    id,
    ts,
    options.streamChunksAppended ?? 0,
    options.renderedThrough ?? now,
  );
  return row ? rowToSlackMessage(row) : null;
}

export async function updateSlackMessageRecord(
  id: string,
  updates: {
    permalink?: string;
    finalized?: boolean;
    streamChunksAppended?: number;
    conclusionKind?: SlackConclusionKind;
    actorId?: string;
    touchUpdatedAt?: boolean;
  },
): Promise<SlackMessageRecord | null> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.slack.updateSlackMessageRecord(id, {
    permalink: updates.permalink ?? null,
    finalize: !!updates.finalized,
    streamChunksAppended: updates.streamChunksAppended ?? null,
    conclusionKind: updates.conclusionKind ?? null,
    touch: updates.touchUpdatedAt !== false,
    actor: updates.actorId ?? null,
    now,
  });
  return row ? rowToSlackMessage(row) : null;
}

export async function markSlackTreeRendered(
  id: string,
  renderedThrough: string,
): Promise<SlackMessageRecord | null> {
  const row = await getStorage().repos.slack.markSlackTreeRendered(id, renderedThrough);
  return row ? rowToSlackMessage(row) : null;
}

export async function deleteSlackMessageRecord(id: string): Promise<boolean> {
  return (await getStorage().repos.slack.deleteSlackMessage(id)) > 0;
}

export async function getSlackTreeMessage(contextKey: string): Promise<SlackMessageRecord | null> {
  const row = await getStorage().repos.slack.findSlackTreeByContextKey(contextKey);
  return row ? rowToSlackMessage(row) : null;
}

export async function getSlackTreeMessageByThread(
  channelId: string,
  threadTs: string,
): Promise<SlackMessageRecord | null> {
  const row = await getStorage().repos.slack.findSlackTreeByThread(channelId, threadTs);
  return row ? rowToSlackMessage(row) : null;
}

export async function getSlackOutcomeMessage(taskId: string): Promise<SlackMessageRecord | null> {
  const row = await getStorage().repos.slack.findSlackOutcomeByTask(taskId);
  return row ? rowToSlackMessage(row) : null;
}

/**
 * Deferral outcome cards whose wake-up task has since reached a terminal
 * state, and which have not been rewritten into that resolved state yet.
 *
 * The join is `agent_tasks.parentTaskId` — `defer-task` sets it on the
 * schedule and `createStandaloneScheduleTask` passes it through, so the
 * wake-up task points back at the task whose card announced the wait. Follow
 * subsequent re-defers to the latest wake, keeping the original card open.
 * `deferredAt` (not the `deferred` tag) identifies the deferring task,
 * because the wake-up task inherits the tag.
 *
 * CROSS JOIN and `+wake.taskType` pin the join order to the small chain. Without
 * them the planner drives the outer join from every terminal task (~1s at 150k tasks).
 * The anchor drives from the partial index idx_agent_tasks_deferred (tasks
 * that ever deferred), not from every outcome card: `deferral_resolved_at IS
 * NULL` stays true forever on cards of tasks that never deferred.
 * `+child.taskType` does the same for the NOT EXISTS: without it the planner
 * walks every deferred-type task through idx_agent_tasks_list_filter per row.
 */
export async function getResolvableDeferralOutcomes(
  limit = 50,
): Promise<{ card: SlackMessageRecord; deferredTaskId: string; wakeTaskId: string }[]> {
  const rows = await getStorage().repos.slack.listResolvableDeferralOutcomes(limit);
  return rows.map((row) => ({
    card: rowToSlackMessage(row),
    deferredTaskId: row.task_id!,
    wakeTaskId: row.wake_task_id,
  }));
}

/**
 * Mark a deferral card as resolved, so the resolution pass skips it after.
 * `abandoned` records that the rewrite was given up on, which hands the
 * answer back to the wake-up's own outcome card.
 */
export async function markSlackDeferralResolved(
  id: string,
  options: { abandoned?: boolean } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await getStorage().repos.slack.markSlackDeferralResolved(id, now, !!options.abandoned);
}

export async function noteSlackOutcomeDeliveryFailure(
  taskId: string,
  lastError: string,
): Promise<SlackMessageRecord | null> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.slack.noteSlackOutcomeDeliveryFailure(
    taskId,
    lastError.slice(0, 500),
    now,
  );
  return row ? rowToSlackMessage(row) : null;
}

/**
 * Give up on the card. Returns the row only on the NULL -> set transition, so
 * exactly one caller (one process, one tick) sees a non-null result and may
 * post the "Couldn't deliver" warning.
 */
export async function abandonSlackOutcomeDelivery(
  taskId: string,
  lastError: string,
): Promise<SlackMessageRecord | null> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.slack.abandonSlackOutcomeDelivery(
    taskId,
    lastError.slice(0, 500),
    now,
  );
  return row ? rowToSlackMessage(row) : null;
}

/**
 * Trees with pending render work. Reads only open trees (closed_at IS NULL,
 * idx_slack_messages_open_trees): a settled thread is closed after its render
 * pass and reopened by migration 278's triggers on any task or outcome write
 * in the thread. `thread` scopes the sweep to one thread (event-driven render).
 */
export async function getSlackTreeMessages(
  options: { thread?: { channelId: string; threadTs: string } } = {},
): Promise<SlackMessageRecord[]> {
  const rows = await getStorage().repos.slack.listTreesNeedingRender(options.thread);
  return rows.map(rowToSlackMessage);
}

export async function getSlackMessageByChannelTs(
  channelId: string,
  ts: string,
): Promise<SlackMessageRecord | null> {
  const row = await getStorage().repos.slack.findSlackMessageByChannelTs(channelId, ts);
  return row ? rowToSlackMessage(row) : null;
}

export async function getSlackTasksInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask[]> {
  const rows = await getStorage().repos.tasks.listTasksInSlackThread(channelId, threadTs);
  return rows.map((row) => rowToAgentTask(row as AgentTaskRow));
}

/**
 * Slack threads with an open human request raised by one of their own tasks
 * (`request-human-input`): the swarm cannot go on until a person answers.
 * A request past its `expiresAt` is about to become a timeout follow-up, so
 * it no longer counts as waiting.
 */
export async function listSlackThreadsAwaitingHuman(): Promise<
  Array<{ channelId: string; threadTs: string }>
> {
  return getStorage().repos.workflows.listSlackThreadsAwaitingHuman();
}

export async function isSlackThreadAwaitingHuman(
  channelId: string,
  threadTs: string,
): Promise<boolean> {
  return await getStorage().repos.workflows.isSlackThreadAwaitingHuman(channelId, threadTs);
}

export async function markTaskSlackReplySent(taskId: string): Promise<void> {
  await getStorage().repos.tasks.markTaskSlackReplySent(taskId);
}

export async function setSlackMessageTracking(
  taskId: string,
  fields: {
    slackProgressMessageTs?: string | null;
    slackTreeRootMessageTs?: string | null;
  },
): Promise<void> {
  await getStorage().repos.tasks.setTaskSlackTracking(taskId, fields);
}

export async function updateTaskVcs(
  taskId: string,
  vcs: {
    vcsProvider: "github" | "gitlab" | "azure-devops" | "bitbucket";
    vcsRepo: string;
    vcsNumber: number;
    vcsUrl: string;
  },
): Promise<AgentTask | null> {
  const row = await getStorage().transaction(async () => {
    const updated = (await getStorage().repos.tasks.setTaskVcs(
      taskId,
      vcs,
      new Date().toISOString(),
    )) as AgentTaskRow | null;
    if (updated) {
      await reconcileTaskPullRequestAttachments(taskId, updated.agentId, [
        updated.output,
        vcs.vcsProvider === "github" ? vcs.vcsUrl : null,
      ]);
    }
    return updated;
  });
  return row ? rowToAgentTask(row) : null;
}

// ============================================================================
// Task Attachments (Phase 1 — pointer-based artifacts)
// ============================================================================
//
// Pointer-only attachments live in their own table; `agent_tasks` is
// untouched. Append-only in Phase 1 — `insertTaskAttachment` silently no-ops
// on a duplicate (sha256 match, or kind+pointer+name tuple match) so
// idempotent re-calls don't fan out duplicate rows. The `kind` enum here
// MUST stay in sync with the SQL CHECK constraint (migration 072) and the
// `TaskAttachmentKindSchema` zod enum.

function rowToTaskAttachment(row: TaskAttachmentRow): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    name: row.name,
    kind: row.kind as TaskAttachment["kind"],
    url: row.url ?? undefined,
    path: row.path ?? undefined,
    pageId: row.page_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    providerKey: row.provider_key ?? undefined,
    capabilities: parseAttachmentCapabilities(row.capabilities),
    orgId: row.agent_fs_org_id ?? undefined,
    driveId: row.agent_fs_drive_id ?? undefined,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    sha256: row.sha256 ?? undefined,
    intent: row.intent ?? undefined,
    description: row.description ?? undefined,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

function parseAttachmentCapabilities(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface InsertTaskAttachmentInput {
  taskId: string;
  agentId: string | null;
  name: string;
  kind: TaskAttachment["kind"];
  url?: string;
  path?: string;
  pageId?: string;
  providerId?: string;
  providerKey?: string;
  capabilities?: Record<string, unknown>;
  /** agent-fs only — paired with `driveId` to build a public live-host URL. */
  orgId?: string;
  /** agent-fs only — paired with `orgId` to build a public live-host URL. */
  driveId?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  intent?: string;
  description?: string;
  isPrimary?: boolean;
  createdBy?: string;
  updatedBy?: string;
}

/**
 * Insert a task attachment. Append-only + dedup:
 *   - if sha256 is present and a row for this task already has that sha256,
 *     skip (return existing row);
 *   - otherwise skip if a row exists for the same task with the same
 *     (kind, path|url|page_id, name) tuple.
 * Returns the stored attachment (newly inserted or pre-existing duplicate).
 */
export async function insertTaskAttachment(
  input: InsertTaskAttachmentInput,
): Promise<TaskAttachment> {
  return await getStorage().transaction(async () => {
    const attachment = await insertTaskAttachmentRow(input);
    if (attachment.kind === "agent-fs" && attachment.providerId && attachment.providerKey) {
      const task = await getTaskById(input.taskId);
      if (!task) throw new Error(`Task not found while mapping attachment: ${input.taskId}`);
      await upsertAssetKeyMapping({
        providerId: attachment.providerId,
        providerOrgId: attachment.orgId,
        providerDriveId: attachment.driveId,
        providerKey: attachment.providerKey,
        key: task.key,
        sourceEntityType: "task-attachment",
        sourceEntityId: attachment.id,
        createdBy: input.createdBy,
        updatedBy: input.updatedBy,
      });
    }
    return attachment;
  });
}

const GENERATED_PULL_REQUEST_PROVIDER_ID = "github";
const GENERATED_PULL_REQUEST_INTENT = "task-deliverable";
const GENERATED_PULL_REQUEST_DESCRIPTION = "Pull request shipped by this task";
const GENERATED_PULL_REQUEST_SOURCE = "task-pull-request-recorder";

function pullRequestKey(pullRequest: { owner: string; repo: string; number: number }): string {
  return `${pullRequest.owner.toLowerCase()}/${pullRequest.repo.toLowerCase()}#${pullRequest.number}`;
}

/**
 * Persist PRs detected by server-owned task lifecycle paths. Existing URL
 * attachments win regardless of display name, so an agent-authored row and an
 * automatic row never duplicate the same task deliverable. A capability key
 * rejected by AttachmentInputSchema marks server-generated rows so
 * reconciliation cannot mistake caller-authored metadata for provenance.
 */
export async function recordTaskPullRequestAttachments(
  taskId: string,
  agentId: string | null,
  text: string | null | undefined,
): Promise<TaskAttachment[]> {
  const pullRequests = extractGitHubPullRequestUrls(text);
  if (pullRequests.length === 0) return [];

  const existingUrls = await getStorage().repos.tasks.listUrlAttachmentUrls(taskId);
  const existingPullRequests = new Set(
    existingUrls.flatMap((url) => extractGitHubPullRequestUrls(url)).map(pullRequestKey),
  );
  const stored: TaskAttachment[] = [];
  for (const pullRequest of pullRequests) {
    const dedupeKey = pullRequestKey(pullRequest);
    if (existingPullRequests.has(dedupeKey)) continue;
    stored.push(
      await insertTaskAttachment({
        taskId,
        agentId,
        name: `GitHub pull request #${pullRequest.number}`,
        kind: "url",
        url: pullRequest.url,
        providerId: GENERATED_PULL_REQUEST_PROVIDER_ID,
        capabilities: {
          [SERVER_GENERATED_ATTACHMENT_CAPABILITY]: GENERATED_PULL_REQUEST_SOURCE,
        },
        intent: GENERATED_PULL_REQUEST_INTENT,
        description: GENERATED_PULL_REQUEST_DESCRIPTION,
      }),
    );
    existingPullRequests.add(dedupeKey);
  }
  return stored;
}

/** Reconcile only lifecycle-generated PR rows against their current source text. */
async function reconcileTaskPullRequestAttachments(
  taskId: string,
  agentId: string | null,
  sourceTexts: Array<string | null | undefined>,
): Promise<TaskAttachment[]> {
  const desiredPullRequests = sourceTexts.flatMap(extractGitHubPullRequestUrls);
  const desiredKeys = new Set(desiredPullRequests.map(pullRequestKey));
  const generatedRows = await getStorage().repos.tasks.listGeneratedUrlAttachments(
    taskId,
    SERVER_GENERATED_ATTACHMENT_CAPABILITY,
    GENERATED_PULL_REQUEST_SOURCE,
  );

  for (const row of generatedRows) {
    const pullRequest = extractGitHubPullRequestUrls(row.url)[0];
    const expectedName = pullRequest ? `GitHub pull request #${pullRequest.number}` : null;
    if (
      !pullRequest ||
      row.name !== expectedName ||
      !desiredKeys.has(pullRequestKey(pullRequest))
    ) {
      await getStorage().repos.tasks.deleteTaskAttachment(row.id);
    }
  }

  return await recordTaskPullRequestAttachments(
    taskId,
    agentId,
    desiredPullRequests.map((pullRequest) => pullRequest.url).join("\n"),
  );
}

async function insertTaskAttachmentRow(input: InsertTaskAttachmentInput): Promise<TaskAttachment> {
  const tasks = getStorage().repos.tasks;
  if (input.sha256) {
    const existing = await tasks.findTaskAttachmentBySha256(input.taskId, input.sha256);
    if (existing) return rowToTaskAttachment(existing);
  }

  const tupleExisting = await tasks.findTaskAttachmentByTuple({
    taskId: input.taskId,
    kind: input.kind,
    path: input.path ?? "",
    url: input.url ?? "",
    pageId: input.pageId ?? "",
    name: input.name,
  });
  if (tupleExisting) return rowToTaskAttachment(tupleExisting);

  const row = await tasks.insertTaskAttachment({
    id: crypto.randomUUID(),
    task_id: input.taskId,
    ...taskAttachmentWrite(input),
    created_by: input.createdBy ?? null,
    updated_by: input.updatedBy ?? input.createdBy ?? null,
  });

  if (!row) {
    throw new Error("Failed to insert task attachment");
  }
  return rowToTaskAttachment(row);
}

// ============================================================================
// Cross-entity asset namespaces + logical provider mappings
// ============================================================================

function rowToAssetKeyMapping(row: AssetKeyMappingRow): AssetKeyMapping {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerOrgId: row.provider_org_id || undefined,
    providerDriveId: row.provider_drive_id || undefined,
    providerKey: row.provider_key,
    key: row.key,
    sourceEntityType:
      (row.source_entity_type as "task-attachment" | "external" | null) ?? undefined,
    sourceEntityId: row.source_entity_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

export interface UpsertAssetKeyMappingInput {
  providerId: string;
  providerOrgId?: string;
  providerDriveId?: string;
  providerKey: string;
  key?: string;
  sourceEntityType?: "task-attachment" | "external";
  sourceEntityId?: string;
  createdBy?: string;
  updatedBy?: string;
}

async function insertAssetKeyHistory(input: {
  entityType: AssetEntityType;
  entityId: string;
  previousKey?: string | null;
  newKey: string;
  changedBy?: string;
}): Promise<void> {
  await getStorage().repos.assets.insertAssetKeyHistory({
    id: crypto.randomUUID(),
    entity_type: input.entityType,
    entity_id: input.entityId,
    previous_key: input.previousKey ?? null,
    new_key: input.newKey,
    changed_by: input.changedBy ?? null,
  });
}

export async function getAssetKeyMappingByProvider(input: {
  providerId: string;
  providerOrgId?: string;
  providerDriveId?: string;
  providerKey: string;
}): Promise<AssetKeyMapping | null> {
  const row = await getStorage().repos.assets.findAssetKeyMappingByProvider({
    providerId: input.providerId,
    providerOrgId: input.providerOrgId ?? "",
    providerDriveId: input.providerDriveId ?? "",
    providerKey: input.providerKey,
  });
  return row ? rowToAssetKeyMapping(row) : null;
}

/**
 * Idempotently project a provider tuple into a logical namespace. Updating the
 * namespace never calls the provider and never renames remote content.
 */
export async function upsertAssetKeyMapping(
  input: UpsertAssetKeyMappingInput,
): Promise<AssetKeyMapping> {
  if (!input.providerId.trim()) throw new Error("providerId is required");
  if (!input.providerKey.trim()) throw new Error("providerKey is required");
  const now = new Date().toISOString();

  const storage = getStorage();
  return await storage.transaction(async () => {
    const existing = await getAssetKeyMappingByProvider(input);
    if (existing) {
      const key = normalizeAssetKey(input.key ?? existing.key);
      const row = await storage.repos.assets.updateAssetKeyMapping(existing.id, {
        key,
        source_entity_type: input.sourceEntityType ?? existing.sourceEntityType ?? null,
        source_entity_id: input.sourceEntityId ?? existing.sourceEntityId ?? null,
        updated_at: now,
        updated_by: input.updatedBy ?? input.createdBy ?? existing.updatedBy ?? null,
      });
      if (!row) throw new Error("Failed to update asset key mapping");
      if (existing.key !== key) {
        await insertAssetKeyHistory({
          entityType: "file",
          entityId: existing.id,
          previousKey: existing.key,
          newKey: key,
          changedBy: input.updatedBy ?? input.createdBy,
        });
      }
      return rowToAssetKeyMapping(row);
    }

    const id = crypto.randomUUID();
    const key = normalizeAssetKey(
      input.key ?? defaultAssetKey(`fs:${input.providerId.trim()}`, id),
    );
    const row = await storage.repos.assets.insertAssetKeyMapping({
      id,
      provider_id: input.providerId.trim(),
      provider_org_id: input.providerOrgId ?? "",
      provider_drive_id: input.providerDriveId ?? "",
      provider_key: input.providerKey,
      key,
      source_entity_type: input.sourceEntityType ?? "external",
      source_entity_id: input.sourceEntityId ?? null,
      created_at: now,
      updated_at: now,
      created_by: input.createdBy ?? null,
      updated_by: input.updatedBy ?? input.createdBy ?? null,
    });
    if (!row) throw new Error("Failed to create asset key mapping");
    await insertAssetKeyHistory({
      entityType: "file",
      entityId: id,
      newKey: key,
      changedBy: input.createdBy,
    });
    return rowToAssetKeyMapping(row);
  });
}

export async function getAssetKeyMapping(id: string): Promise<AssetKeyMapping | null> {
  const row = await getStorage().repos.assets.findAssetKeyMapping(id);
  return row ? rowToAssetKeyMapping(row) : null;
}

export interface AssetSummaryFilters {
  keyPrefix?: string;
  types?: AssetEntityType[];
  limit?: number;
}

export async function listAssetSummaries(filters?: AssetSummaryFilters): Promise<AssetSummary[]> {
  const requestedTypes = new Set<AssetEntityType>(
    filters?.types?.length
      ? filters.types
      : ["task", "workflow", "schedule", "page", "app", "script", "file"],
  );
  const limit = Math.min(Math.max(filters?.limit ?? 500, 1), 1000);
  const order: AssetEntityType[] = [
    "task",
    "workflow",
    "schedule",
    "page",
    "app",
    "script",
    "file",
  ];
  const rows = await getStorage().repos.assets.listAssetSummaries(
    order.filter((type) => requestedTypes.has(type)),
    filters?.keyPrefix ? assetKeyPrefixPattern(filters.keyPrefix) : null,
    limit,
  );

  return rows.map((row) => ({
    entityType: row.entityType as AssetEntityType,
    id: row.id,
    key: row.key,
    label: row.label,
    updatedAt: row.updatedAt,
    providerRef:
      row.providerId && row.providerKey
        ? {
            providerId: row.providerId,
            orgId: row.providerOrgId ?? undefined,
            driveId: row.providerDriveId ?? undefined,
            providerKey: row.providerKey,
          }
        : undefined,
  }));
}

async function currentAssetKey(entityType: AssetEntityType, id: string): Promise<string | null> {
  if (entityType === "file") {
    const mapping = await getAssetKeyMapping(id);
    return mapping?.key ?? null;
  }
  return await getStorage().repos.assets.findAssetKey(entityType, id);
}

export async function moveAssetKey(input: {
  entityType: AssetEntityType;
  id: string;
  key: string;
  changedBy?: string;
  /** Agent making the move; recorded as `updatedByAgentId` on workflows, schedules and scripts. */
  changedByAgentId?: string;
  /** Task moves only: descendant task ids the caller already authorized to move with the task. */
  descendantTaskIds?: readonly string[];
}): Promise<false | { movedTaskIds?: string[] }> {
  const key = normalizeAssetKey(input.key);
  await assertAssetKeyMovesAllowed();
  const previousKey = await currentAssetKey(input.entityType, input.id);
  if (!previousKey) return false;
  if (previousKey === key && input.entityType !== "task") return {};
  if (input.entityType === "file") {
    const mapping = await getAssetKeyMapping(input.id);
    if (mapping?.sourceEntityType === "task-attachment") {
      throw new Error(
        "Task attachment namespaces move with their parent task; move the task instead.",
      );
    }
  }
  const now = new Date().toISOString();

  const storage = getStorage();
  return storage.transaction(async () => {
    if (input.entityType === "task") {
      const movedTaskIds = await moveTaskChainKeyInTx(
        input.id,
        input.descendantTaskIds ?? [],
        key,
        input.changedBy,
      );
      if (movedTaskIds === false) return false;
      return { movedTaskIds };
    }
    // Workflows, schedules and scripts also record the moving agent.
    await storage.repos.assets.setAssetKey(input.entityType, input.id, {
      key,
      now,
      changedBy: input.changedBy ?? null,
      changedByAgentId: input.changedByAgentId ?? null,
    });
    await insertAssetKeyHistory({
      entityType: input.entityType,
      entityId: input.id,
      previousKey,
      newKey: key,
      changedBy: input.changedBy,
    });
    return {};
  });
}

export async function deleteTaskAttachment(id: string): Promise<boolean> {
  return (await getStorage().repos.tasks.deleteTaskAttachment(id)) > 0;
}

export async function replaceTaskAttachment(
  id: string,
  input: Omit<InsertTaskAttachmentInput, "taskId">,
): Promise<TaskAttachment | null> {
  const row = await getStorage().repos.tasks.replaceTaskAttachment(id, taskAttachmentWrite(input));

  return row ? rowToTaskAttachment(row) : null;
}

export async function getTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
  const rows = await getStorage().repos.tasks.listTaskAttachments(taskId);
  return rows.map(rowToTaskAttachment);
}

// ============================================================================
// Task Steering Messages
// ============================================================================

function rowToSteeringMessage(row: TaskSteeringMessageRow): SteeringMessage {
  const senderId =
    row.created_by_kind === "user" ? row.created_by_user_id : row.created_by_agent_id;
  const senderLabel =
    row.created_by_kind === "system"
      ? "system"
      : `${row.sender_name?.trim() || senderId || "Unknown"} (${row.created_by_kind})`;
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    mode: row.mode as SteerMode,
    status: row.status as SteeringStatus,
    deliveredMode: (row.delivered_mode as SteerMode | null) ?? undefined,
    source: row.source as SteeringSource,
    senderLabel,
    createdByKind: row.created_by_kind as SteeringMessage["createdByKind"],
    createdByUserId: row.created_by_user_id ?? undefined,
    createdByAgentId: row.created_by_agent_id ?? undefined,
    promotedTaskId: row.promoted_task_id ?? undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    handledAt: row.handled_at ?? undefined,
    handledNote: row.handled_note ?? undefined,
  };
}

export interface CreateSteeringMessageArgs {
  taskId: string;
  body: string;
  mode: SteerMode;
  source: SteeringSource;
  createdByKind: SteeringMessage["createdByKind"];
  createdByUserId?: string;
  createdByAgentId?: string;
}

export async function createSteeringMessage(
  args: CreateSteeringMessageArgs,
): Promise<SteeringMessage> {
  const id = crypto.randomUUID();
  const row = await getStorage().repos.tasks.insertSteeringMessage({
    id,
    task_id: args.taskId,
    body: args.body,
    mode: args.mode,
    source: args.source,
    created_by_kind: args.createdByKind,
    created_by_user_id: args.createdByUserId ?? null,
    created_by_agent_id: args.createdByAgentId ?? null,
  });
  if (!row) throw new Error("Failed to create steering message");

  getStorage().afterCommit(async () => {
    const task = await getTaskById(args.taskId);
    if (task?.agentId) publishWorkerNudge(task.agentId, { kind: "steer", taskId: args.taskId });
  });

  try {
    await createLogEntry({
      eventType: "task_steering",
      taskId: args.taskId,
      agentId: args.createdByAgentId,
      newValue: "pending",
      metadata: {
        steeringMessageId: id,
        mode: args.mode,
        source: args.source,
      },
    });
  } catch {}

  return (await getSteeringMessageById(id))!;
}

export async function getSteeringMessagesForTask(
  taskId: string,
  opts?: { status?: SteeringStatus },
): Promise<SteeringMessage[]> {
  const rows = await getStorage().repos.tasks.listSteeringMessages(taskId, opts?.status);
  return rows.map(rowToSteeringMessage);
}

export async function getSteeringMessageById(id: string): Promise<SteeringMessage | null> {
  const row = await getStorage().repos.tasks.findSteeringMessage(id);
  return row ? rowToSteeringMessage(row) : null;
}

export async function getPendingSteeringForTask(taskId: string): Promise<SteeringMessage[]> {
  return await getSteeringMessagesForTask(taskId, { status: "pending" });
}

export async function getPendingSteeringForAgent(
  agentId: string,
  readableBy?: { userId: string | null },
): Promise<SteeringMessage[]> {
  const rows = await getStorage().repos.tasks.listPendingSteeringForAgent(agentId, readableBy);
  return rows.map(rowToSteeringMessage);
}

/**
 * `expectedTaskId` fences a worker callback to the task whose session received
 * the message: a row handed to a successor in the meantime is left untouched.
 */
export async function markSteeringDelivered(
  id: string,
  deliveredMode: SteerMode,
  expectedTaskId?: string,
): Promise<SteeringMessage | null> {
  const row = await getStorage().repos.tasks.markSteeringDelivered(
    id,
    deliveredMode,
    expectedTaskId ?? null,
  );

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_steering",
        taskId: row.task_id,
        newValue: "delivered",
        metadata: {
          steeringMessageId: id,
          requestedMode: row.mode,
          deliveredMode,
        },
      });
    } catch {}
  }

  return row ? await getSteeringMessageById(id) : null;
}

export async function markSteeringHandled(
  id: string,
  note?: string,
): Promise<SteeringMessage | null> {
  const row = await getStorage().repos.tasks.markSteeringHandled(id, note ?? null);
  return row ? await getSteeringMessageById(id) : null;
}

export async function markSteeringPromoted(
  id: string,
  promotedTaskId: string,
): Promise<SteeringMessage | null> {
  const row = await getStorage().repos.tasks.markSteeringPromoted(id, promotedTaskId);
  return row ? await getSteeringMessageById(id) : null;
}

export async function cancelPendingSteeringForTask(taskId: string): Promise<number> {
  return await getStorage().repos.tasks.cancelPendingSteering(taskId);
}

export async function hasPendingSteering(taskId: string): Promise<boolean> {
  return await getStorage().repos.tasks.hasPendingSteering(taskId);
}

// ============================================================================
// Combined Queries (Agent with Tasks)
// ============================================================================

export async function getAgentWithTasks(
  id: string,
  readableBy?: { userId: string | null },
): Promise<AgentWithTasks | null> {
  return await getStorage().transaction(
    async () => {
      const agent = await getAgentById(id);
      if (!agent) return null;

      const tasks = await getTasksByAgentId(id, readableBy);
      return { ...agent, tasks };
    },
    { readOnly: true },
  );
}

export async function getAllAgentsWithTasks(opts?: {
  slim?: boolean;
  readableBy?: { userId: string | null };
}): Promise<AgentWithTasks[]> {
  return await getStorage().transaction(
    async () => {
      const agents = await getAllAgents({ slim: opts?.slim ?? false });
      return await Promise.all(
        agents.map(async (agent) => ({
          ...agent,
          tasks: await getTasksByAgentId(agent.id, opts?.readableBy),
        })),
      );
    },
    { readOnly: true },
  );
}

// ============================================================================
// Agent Log Queries
// ============================================================================

type AgentLogRow = {
  id: string;
  eventType: AgentLogEventType;
  agentId: string | null;
  taskId: string | null;
  oldValue: string | null;
  newValue: string | null;
  metadata: string | null;
  createdAt: string;
};

function rowToAgentLog(row: AgentLogRow): AgentLog {
  return {
    id: row.id,
    eventType: row.eventType,
    agentId: row.agentId ?? undefined,
    taskId: row.taskId ?? undefined,
    oldValue: row.oldValue ?? undefined,
    newValue: row.newValue ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt,
  };
}

export async function createLogEntry(entry: {
  eventType: AgentLogEventType;
  agentId?: string;
  taskId?: string;
  oldValue?: string;
  newValue?: string;
  metadata?: Record<string, unknown>;
}): Promise<AgentLog> {
  const id = crypto.randomUUID();
  const metaJson = entry.metadata ? JSON.stringify(entry.metadata) : null;
  // A nested transaction (a SAVEPOINT) inside a caller's transaction: most
  // callers swallow a failed log write, and on Postgres a failed statement
  // aborts the whole transaction unless it ran inside a savepoint.
  const row = (await getStorage().transaction(() =>
    getStorage().repos.agents.insertLog({
      id,
      eventType: entry.eventType,
      agentId: entry.agentId ?? null,
      taskId: entry.taskId ?? null,
      oldValue: entry.oldValue ? scrubSecrets(entry.oldValue) : null,
      newValue: entry.newValue ? scrubSecrets(entry.newValue) : null,
      metadata: metaJson ? scrubSecrets(metaJson) : null,
    }),
  )) as AgentLogRow | null;
  if (!row) throw new Error("Failed to create log entry");
  return rowToAgentLog(row);
}

export async function getLogsByAgentId(
  agentId: string,
  readableBy?: { userId: string | null },
): Promise<AgentLog[]> {
  const rows = (await getStorage().repos.agents.listLogsByAgent(
    agentId,
    readableBy,
  )) as AgentLogRow[];
  return rows.map(rowToAgentLog);
}

export async function getLogsByTaskId(taskId: string, limit = 200): Promise<AgentLog[]> {
  const rows = (await getStorage().repos.agents.listLogsByTask(taskId, limit)) as AgentLogRow[];
  return rows.map(rowToAgentLog);
}

export async function getLogsByTaskIdAndEventType(
  taskId: string,
  eventType: AgentLogEventType,
): Promise<AgentLog[]> {
  const rows = (await getStorage().repos.agents.listLogsByTaskChronological(
    taskId,
    eventType,
  )) as AgentLogRow[];
  return rows.map(rowToAgentLog);
}

export async function getLogsByTaskIdChronological(taskId: string): Promise<AgentLog[]> {
  const rows = (await getStorage().repos.agents.listLogsByTaskChronological(
    taskId,
  )) as AgentLogRow[];
  return rows.map(rowToAgentLog);
}

/**
 * Phase 6: list all log rows of a given eventType, newest first. Used by the
 * REST audit-log tests to assert mutation rows landed.
 */
export async function getLogsByEventType(eventType: AgentLogEventType): Promise<AgentLog[]> {
  const rows = (await getStorage().repos.agents.listLogsByEventType(eventType)) as AgentLogRow[];
  return rows.map(rowToAgentLog);
}

export async function getAllLogs(
  limit?: number,
  readableBy?: { userId: string | null },
): Promise<AgentLog[]> {
  // With a limit, agent status changes are left out.
  const rows = (await getStorage().repos.agents.listAllLogs(limit, readableBy)) as AgentLogRow[];
  return rows.map(rowToAgentLog);
}

// ============================================================================
// Task Pool Operations
// ============================================================================

// The runtime contract for task creation lives in src/types.ts
// (`CreateTaskOptionsSchema`); `createTaskExtended` parses options against it.
// The type is re-exported so existing importers (src/tasks/sibling-awareness.ts)
// keep resolving it from this module.
export type { CreateTaskOptions } from "../types";

/**
 * Find recent tasks within a time window for deduplication checks.
 * Returns tasks created in the last N minutes, optionally filtered by creator or target agent.
 */
export async function findRecentSimilarTasks(opts: {
  windowMinutes?: number;
  creatorAgentId?: string;
  agentId?: string;
  limit?: number;
}): Promise<AgentTask[]> {
  const since = new Date(Date.now() - (opts.windowMinutes ?? 10) * 60 * 1000).toISOString();
  // Excludes every terminal status (`TERMINAL_TASK_STATUSES` in src/types.ts).
  const rows = await getStorage().repos.tasks.listRecentSimilarTasks({
    since,
    creatorAgentId: opts.creatorAgentId,
    agentId: opts.agentId,
    limit: opts.limit ?? 50,
  });
  return rows.map((row) => rowToAgentTask(row as AgentTaskRow));
}

type RoutingDecisionWorkerStatus = {
  agentId: string;
  status: AgentStatus;
  activeTaskCount: number;
  openTaskCount: number;
};

type RoutingDecisionCandidate = {
  taskId: string;
  agentId: string;
};

type RoutingDecisionSnapshot = {
  capturedAt: string;
  workerStatuses: RoutingDecisionWorkerStatus[];
  continuityCandidates: {
    samePr: RoutingDecisionCandidate | null;
    sameThread: RoutingDecisionCandidate | null;
    sameRepo: RoutingDecisionCandidate | null;
  };
};

async function findLatestRoutingCandidate(
  match: RoutingCandidateMatch,
): Promise<RoutingDecisionCandidate | null> {
  return await getStorage().repos.tasks.findLatestRoutingCandidate(match);
}

async function captureRoutingDecisionSnapshot(
  options: CreateTaskOptions,
): Promise<RoutingDecisionSnapshot> {
  const workerStatuses = (await getStorage().repos.tasks.listRoutingWorkerStatuses(
    OPEN_TASK_STATUSES,
  )) as RoutingDecisionWorkerStatus[];

  const samePr =
    options.vcsRepo && options.vcsNumber != null
      ? await findLatestRoutingCandidate({
          vcsRepo: options.vcsRepo,
          vcsNumber: options.vcsNumber,
        })
      : null;

  let sameThread: RoutingDecisionCandidate | null = null;
  if (options.slackChannelId && options.slackThreadTs) {
    sameThread = await findLatestRoutingCandidate({
      slackChannelId: options.slackChannelId,
      slackThreadTs: options.slackThreadTs,
    });
  } else if (options.agentmailThreadId) {
    sameThread = await findLatestRoutingCandidate({
      agentmailThreadId: options.agentmailThreadId,
    });
  }

  const sameRepo = options.vcsRepo
    ? await findLatestRoutingCandidate({ vcsRepo: options.vcsRepo })
    : null;

  return {
    capturedAt: new Date().toISOString(),
    workerStatuses,
    continuityCandidates: { samePr, sameThread, sameRepo },
  };
}

function logRoutingDecisionFailure(taskId: string, stage: "capture" | "write", error: unknown) {
  console.warn(
    `[routing-decision] Failed to ${stage} snapshot for task ${taskId}:`,
    scrubSecrets(error instanceof Error ? error.message : String(error)),
  );
}

export async function createTaskExtended(
  task: string,
  options?: CreateTaskOptions,
  /**
   * `readCommitted`: run the INSERT transaction at READ COMMITTED on Postgres
   * when it is the outermost transaction (decision D7 opt-down). Only the
   * unkeyed REST create sets it; see the comment at the transaction.
   */
  txMode?: { readCommitted?: boolean },
): Promise<AgentTask> {
  if (typeof task !== "string" || task.trim().length === 0) {
    throw new Error("createTaskExtended: 'task' must be a non-empty string");
  }
  // Single runtime enforcement point for every task write (REST, MCP,
  // scripts bridge, webhooks, scheduler, internal callers). Reject, never
  // coerce: a bad shape throws before anything reaches the INSERT; absent
  // fields keep the `??` defaults at the bind site below.
  options = CreateTaskOptionsSchema.parse(options ?? {});
  if (
    options.inheritParentRoutingAffinity === false &&
    options.routingAffinity?.leadOnly !== true
  ) {
    throw new Error(
      "Disabling parent routing-affinity inheritance requires an explicit Lead-only control-plane affinity.",
    );
  }
  // An explicit empty `outputSchema: {}` means "no output schema": it stores
  // NULL and blocks the parent-schema inheritance below. Callers pass `{}` on
  // purpose to keep a delegated child free of their own output contract.
  if (options.outputSchema !== undefined && !isEffectiveOutputSchema(options.outputSchema)) {
    options = { ...options, outputSchema: undefined, inheritParentOutputSchema: false };
  }
  let requestedByUserIdInherited = false;
  // The parent key is read again inside the INSERT transaction (see below).
  let keyInherited = false;
  // True only when `options.routingAffinity` ends up populated purely via
  // the plain parent-fallback inherit below (child declared no affinity of
  // its own, the parent wasn't lead-only, AND the parent's affinity actually
  // carries a `sourceAgentId`/`role` identity — the shape only
  // `buildRoutingAffinityFromAgent` produces). That shape is PROVENANCE — a
  // record of where the continuation came from — not a requirement any
  // caller declared. It must never gate the direct-assignment/offer
  // enforcement further down; only an explicit caller-declared requirement
  // (`send-task`/`task-action`'s `{ leadOnly, capabilities }`, which never
  // carries `sourceAgentId`/`role`), or a lead-only ratchet, does. See #1276
  // (3c857542) for the ratchet this must NOT weaken, and the Superagent P1
  // finding on #1340 for why `leadOnly` alone isn't a sufficient gate.
  let routingAffinityIsInheritedProvenance = false;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // `status: "draft"` wins over offeredTo/agentId — a draft task keeps its
  // intended owner/offer for when it's promoted (#1240), but must not be
  // dispatch-eligible while attachments are still uploading.
  const status: AgentTaskStatus =
    options?.status === "draft"
      ? "draft"
      : options?.offeredTo
        ? "offered"
        : options?.agentId
          ? "pending"
          : options?.status === "backlog"
            ? "backlog"
            : "unassigned";

  // Inherit Slack/AgentMail metadata from parent task (unless explicitly overridden)
  if (options?.parentTaskId) {
    const parent = await getTaskById(options.parentTaskId);
    if (parent) {
      // Identity & routing — anything that says "what work is this, who asked
      // for it, where does it run" carries forward to every child (follow-ups,
      // reboot retries, resume tasks). Explicit options always win.
      //
      // When adding a new identity-shaped column to `agent_tasks`, ADD IT HERE
      // unless you have a specific reason a child should NOT inherit it. This
      // is the single source of truth — `createResumeFollowUp` and the other
      // follow-up creators rely on this block instead of re-listing fields.

      // Slack context — inherited as an atomic unit. A foreign channelId's
      // thread ts is meaningless to Slack's API, so an explicit slackChannelId
      // that DIFFERS from the parent's must not pull in the parent's
      // slackThreadTs/slackUserId (that combination misroutes/fails to thread —
      // see swarm memory dispatch-slack-channel-must-match-parent-context-2026-07-10).
      // When the explicit channel matches the parent's (or is unset), per-field
      // fill-in proceeds as before.
      const explicitForeignChannel =
        !!options.slackChannelId &&
        !!parent.slackChannelId &&
        options.slackChannelId !== parent.slackChannelId;
      if (parent.slackChannelId && !options.slackChannelId) {
        options.slackChannelId = parent.slackChannelId;
      }
      if (parent.slackThreadTs && !options.slackThreadTs && !explicitForeignChannel) {
        options.slackThreadTs = parent.slackThreadTs;
      }
      if (parent.slackUserId && !options.slackUserId && !explicitForeignChannel) {
        options.slackUserId = parent.slackUserId;
      }
      if (parent.slackParticipants && !options.slackParticipants && !explicitForeignChannel) {
        options.slackParticipants = parent.slackParticipants;
      }

      // AgentMail context
      if (parent.agentmailInboxId && !options.agentmailInboxId) {
        options.agentmailInboxId = parent.agentmailInboxId;
      }
      if (parent.agentmailMessageId && !options.agentmailMessageId) {
        options.agentmailMessageId = parent.agentmailMessageId;
      }
      if (parent.agentmailThreadId && !options.agentmailThreadId) {
        options.agentmailThreadId = parent.agentmailThreadId;
      }

      // Mention context (Slack @-mentions)
      if (parent.mentionMessageId && !options.mentionMessageId) {
        options.mentionMessageId = parent.mentionMessageId;
      }
      if (parent.mentionChannelId && !options.mentionChannelId) {
        options.mentionChannelId = parent.mentionChannelId;
      }

      // VCS identity (GitHub / GitLab issue / PR / MR + webhook routing)
      // Webhook handlers locate active work via `findTaskByVcs(repo, number, provider)`,
      // so a resume / follow-up child MUST carry the full VCS identity or
      // subsequent review/update events get dropped.
      //
      // Inherited as an atomic unit, like Slack context above: a child that
      // names its own vcsRepo different from the parent's (e.g. `send-task
      // vcsRepo=...`) inherits NONE of the parent's vcs* fields. Otherwise it
      // would pair its repo with the parent's number/URL, so PR reconciliation
      // attaches the parent's PR as the child's deliverable and
      // `findTaskByVcs` matches an unrelated PR with the same number.
      const inheritParentVcs =
        !options.vcsRepo ||
        (!!parent.vcsRepo && options.vcsRepo.toLowerCase() === parent.vcsRepo.toLowerCase());
      if (inheritParentVcs) {
        if (parent.vcsProvider && !options.vcsProvider) {
          options.vcsProvider = parent.vcsProvider;
        }
        if (parent.vcsRepo && !options.vcsRepo) {
          options.vcsRepo = parent.vcsRepo;
        }
        if (parent.vcsNumber != null && options.vcsNumber == null) {
          options.vcsNumber = parent.vcsNumber;
        }
        if (parent.vcsEventType && !options.vcsEventType) {
          options.vcsEventType = parent.vcsEventType;
        }
        if (parent.vcsCommentId != null && options.vcsCommentId == null) {
          options.vcsCommentId = parent.vcsCommentId;
        }
        if (parent.vcsAuthor && !options.vcsAuthor) {
          options.vcsAuthor = parent.vcsAuthor;
        }
        if (parent.vcsUrl && !options.vcsUrl) {
          options.vcsUrl = parent.vcsUrl;
        }
        if (parent.vcsInstallationId != null && options.vcsInstallationId == null) {
          options.vcsInstallationId = parent.vcsInstallationId;
        }
        if (parent.vcsNodeId && !options.vcsNodeId) {
          options.vcsNodeId = parent.vcsNodeId;
        }
      }

      // Execution context (per-task overrides)
      //
      // `model` is DELIBERATELY NOT inherited. A parent task's `model` is a
      // concrete, provider-specific resolved string (e.g. `claude-opus-4-8`,
      // `openrouter/moonshotai/kimi-k2.6`). Derived tasks (resume follow-ups,
      // completion/review follow-ups, re-dispatches) routinely land on a
      // DIFFERENT agent — and therefore a different harness/provider — than the
      // parent. Carrying the parent's concrete model across that boundary makes
      // the child die at session-init with a model-incompatibility error before
      // any worker code runs (e.g. a `claude-opus-4-8` resume claimed by a Codex
      // worker → `400 model is not supported when using Codex`, or a
      // `kimi-k2.6` review follow-up routed to a Claude-harness Lead → session
      // exit 1). Per Taras's directive (2026-05-29): derived tasks must never
      // set the model — it resolves from the ASSIGNEE agent's own provider /
      // `MODEL_OVERRIDE` config at session-init (see
      // `src/commands/runner.ts` — `opts.model || configModel`). A null `model`
      // here is the correct, intended state. Do NOT re-add inheritance here; if
      // a same-provider child genuinely needs a specific model, the creator must
      // pass it explicitly. Resume and reboot-retry creators do: they pass the
      // parent's task-level pin via `inheritedModelSelection`
      // (`src/tasks/worker-follow-up.ts`).
      if (parent.dir && !options.dir) {
        options.dir = parent.dir;
      }

      // Contract (schema validation) — `store-progress` validates completion
      // output against `outputSchema`, runner injects structured-output
      // instructions only when it's present. Opt-out via
      // `inheritParentOutputSchema: false` for control-plane children (e.g. the
      // Lead reroute-decision) that must not be held to the original work's
      // output contract.
      if (
        isEffectiveOutputSchema(parent.outputSchema) &&
        !options.outputSchema &&
        options.inheritParentOutputSchema !== false
      ) {
        options.outputSchema = parent.outputSchema;
      }

      // Attribution
      if (
        parent.requestedByUserId &&
        !options.requestedByUserId &&
        options.inheritParentRequester !== false
      ) {
        options.requestedByUserId = parent.requestedByUserId;
        requestedByUserIdInherited = true;
      }
      if (parent.key && !options.key) {
        options.key = parent.key;
        keyInherited = true;
      }
      if (parent.contextKey && !options.contextKey) {
        options.contextKey = parent.contextKey;
      }
      // followUpConfig is opt-in: only a continuation of the same work carries
      // the creator's onCompleted/onFailed forward. Lead follow-ups, new
      // delegations and thread replies all pass parentTaskId too, and
      // inheriting there spread one task's instructions down the thread.
      if (
        parent.followUpConfig &&
        !options.followUpConfig &&
        options.inheritParentFollowUpConfig === true
      ) {
        options.followUpConfig = parent.followUpConfig;
      }
      if (parent.routingAffinityInvalid && options.inheritParentRoutingAffinity !== false) {
        // Never let a corrupt parent affinity create an apparently untagged
        // continuation. This is a fail-closed quarantine, including recovery.
        throw new TaskRoutingAuthorizationError(
          `Cannot continue task ${parent.id}: routing affinity is invalid.`,
        );
      }
      if (parent.routingAffinity && options.inheritParentRoutingAffinity !== false) {
        // Privilege cannot be shed by a continuation. A child can narrow or
        // replace ordinary routing provenance, but a Lead-only parent always
        // stamps Lead-only onto the child (including callers that supplied
        // requiredCapabilities and therefore built a fresh affinity object).
        if (!options.routingAffinity) {
          options.routingAffinity = parent.routingAffinity;
          // A non-lead-only parent's affinity, inherited here only because
          // the child supplied nothing of its own, is provenance — not a
          // requirement — ONLY when it actually IS a provenance snapshot.
          // `buildRoutingAffinityFromAgent` (session-resume) always stamps
          // `sourceAgentId` and `role` together; neither `send-task` nor
          // `task-action`'s `requiredCapabilities`/`leadOnly` requirement
          // ever exposes either field to a caller (see their zod schemas —
          // both build `{ leadOnly, capabilities }` only). So a caller can
          // declare a non-lead-only capability requirement (`leadOnly:
          // false, capabilities: [...]`) with neither `sourceAgentId` nor
          // `role` set, and that must keep gating direct assignment/offer on
          // a continuation exactly as it did on the parent — see the
          // Superagent P1 finding on PR #1340 (inherited-affinity
          // provenance-vs-requirement confusion). Gate on the presence of
          // either identity field, not on `leadOnly` alone. A lead-only
          // parent's affinity is always a requirement (the ratchet), so it's
          // excluded below regardless.
          routingAffinityIsInheritedProvenance =
            !parent.routingAffinity.leadOnly &&
            (!!parent.routingAffinity.sourceAgentId || !!parent.routingAffinity.role);
        } else if (parent.routingAffinity.leadOnly) {
          // Child-supplied affinity may add requirements, but never remove an
          // authorization-affecting requirement inherited from a Lead-only
          // parent. This includes public continuations that default their
          // requiredCapabilities to an empty array.
          options.routingAffinity = {
            ...options.routingAffinity,
            capabilities: [
              ...new Set([
                ...(parent.routingAffinity.capabilities ?? []),
                ...(options.routingAffinity.capabilities ?? []),
              ]),
            ],
            leadOnly: true,
          };
        }
      }
    }
  }

  // Auto-inherit Slack metadata from the creator's source task (deterministic via sourceTaskId)
  // Priority: explicit params > parentTaskId inheritance > sourceTaskId lookup
  // sourceTaskId is set by the adapter's X-Source-Task-Id header — each adapter carries its taskId natively
  if (options?.creatorAgentId && !options.slackChannelId && options.sourceTaskId) {
    const sourceTask = await getTaskById(options.sourceTaskId);
    if (sourceTask?.slackChannelId) {
      options.slackChannelId = sourceTask.slackChannelId;
      options.slackThreadTs = sourceTask.slackThreadTs;
      options.slackUserId = sourceTask.slackUserId;
    }
  }

  // contextKey → Slack-fields backfill: a slack-family contextKey is the
  // durable record of where this task belongs, but delivery code
  // (src/slack/responses.ts, src/slack/watcher.ts, src/tools/slack-reply.ts)
  // reads slackChannelId/slackThreadTs exclusively. Without this, a task that
  // inherited only a slack contextKey (no Slack fields) would silently never
  // deliver. Deliberately does NOT backfill slackUserId — the key doesn't
  // encode it.
  if (!options?.slackChannelId) {
    const backfill = slackChannelFromContextKey(options?.contextKey);
    if (backfill && options) {
      options.slackChannelId = backfill.channelId;
      options.slackThreadTs = backfill.threadTs;
    }
  } else if (!options.slackThreadTs) {
    // Channel present but no thread: a trusted caller supplied slackChannelId
    // without slackThreadTs. If it matches the slack-family contextKey's
    // channel, fill the thread from there too — otherwise delivery (which
    // reads slackThreadTs directly) silently fails to thread.
    const backfill = slackChannelFromContextKey(options.contextKey);
    if (backfill && backfill.channelId === options.slackChannelId) {
      options.slackThreadTs = backfill.threadTs;
    }
  }

  // Residual-mismatch guard: after all inheritance/backfill above, a final
  // slackChannelId/slackThreadTs that still disagrees with a slack-family
  // contextKey would misroute delivery — src/slack/responses.ts,
  // src/slack/watcher.ts, and src/tools/slack-reply.ts all read these fields
  // directly, so logging a warning and inserting the mismatch unchanged does
  // NOT prevent misdelivery. This boundary is reachable by untrusted-ish
  // callers too (e.g. POST /api/tasks accepts client-supplied parentTaskId +
  // contextKey), so a non-override caller must not be able to persist a
  // mismatch: the durable contextKey wins and the Slack fields are
  // normalized to match it. `overrideSlackContext` (set by `send-task` when
  // the caller passed `overrideSlackContext: true`) opts out, preserving the
  // deliberately divergent lineage. Never throw here — this also runs on
  // trusted ingress hot paths that must not fail task creation.
  const finalSlackContext = slackChannelFromContextKey(options?.contextKey);
  if (finalSlackContext && options?.slackChannelId) {
    if (options.slackChannelId !== finalSlackContext.channelId) {
      if (options.overrideSlackContext) {
        console.log(
          `[slack-routing] override: keeping slackChannelId="${options.slackChannelId}" despite disagreeing with contextKey channel "${finalSlackContext.channelId}" (contextKey=${options.contextKey}, sourceTaskId=${options.sourceTaskId ?? "n/a"}, parentTaskId=${options.parentTaskId ?? "n/a"})`,
        );
      } else {
        console.warn(
          `[slack-routing] MISMATCH task creation: normalizing slackChannelId="${options.slackChannelId}" to contextKey channel "${finalSlackContext.channelId}" (contextKey=${options.contextKey}, sourceTaskId=${options.sourceTaskId ?? "n/a"}, parentTaskId=${options.parentTaskId ?? "n/a"})`,
        );
        options.slackChannelId = finalSlackContext.channelId;
        options.slackThreadTs = finalSlackContext.threadTs;
      }
    } else if (options.slackThreadTs && options.slackThreadTs !== finalSlackContext.threadTs) {
      if (options.overrideSlackContext) {
        console.log(
          `[slack-routing] override: keeping slackThreadTs="${options.slackThreadTs}" despite disagreeing with contextKey thread "${finalSlackContext.threadTs}" (contextKey=${options.contextKey}, sourceTaskId=${options.sourceTaskId ?? "n/a"}, parentTaskId=${options.parentTaskId ?? "n/a"})`,
        );
      } else {
        console.warn(
          `[slack-routing] MISMATCH task creation: normalizing slackThreadTs="${options.slackThreadTs}" to contextKey thread "${finalSlackContext.threadTs}" (contextKey=${options.contextKey}, sourceTaskId=${options.sourceTaskId ?? "n/a"}, parentTaskId=${options.parentTaskId ?? "n/a"})`,
        );
        options.slackThreadTs = finalSlackContext.threadTs;
      }
    }
  }

  // Direct assignment and offers bypass the pool claim gate, so enforce the
  // complete structured affinity here. This is after parent inheritance so
  // continuations cannot shed a Lead-only boundary or its capabilities.
  // Exception: an affinity that is pure inherited PROVENANCE (see
  // `routingAffinityIsInheritedProvenance` above) describes where this
  // continuation came from, not a requirement anyone declared for it — an
  // explicit direct assignment/offer is the caller overriding routing, and
  // provenance must not veto that override. A caller-declared requirement
  // (explicit `leadOnly`/`capabilities`, or a lead-only ratchet) still gates
  // as before.
  const targetAgentId = options.agentId ?? options.offeredTo;
  // Extension identities (`ext:<name>`, role "extension") are API principals,
  // never executors. This is the shared chokepoint for every creation path
  // (send-task, POST /api/tasks, schedules, workflow agent-task nodes, script
  // runs, apps, Slack fan-out, pre.task.create hook rewrites).
  for (const id of new Set([options.agentId, options.offeredTo])) {
    if (!id) continue;
    const target = await getAgentById(id);
    if (target && isExtensionAgent(target)) {
      throw new ExtensionAgentAssignmentError(target);
    }
  }
  if (options.routingAffinity && targetAgentId && !routingAffinityIsInheritedProvenance) {
    const target = await getAgentById(targetAgentId);
    if (!target || !isAgentEligibleForTask(target, { routingAffinity: options.routingAffinity })) {
      try {
        await createLogEntry({
          eventType: "task_authorization_rejected",
          agentId: options.creatorAgentId,
          metadata: {
            leadOnly: options.routingAffinity.leadOnly === true,
            targetAgentId,
            decision: "reject_ineligible_assignment",
            parentTaskId: options.parentTaskId,
            source: options.source,
            contextKey: options.contextKey,
          },
        });
      } catch {}
      throw new TaskRoutingAuthorizationError(
        options.routingAffinity.leadOnly
          ? `Lead-only task routing affinity does not authorize assignment or offer to agent "${targetAgentId}".`
          : `Task routing affinity does not authorize assignment or offer to agent "${targetAgentId}".`,
      );
    }
  }

  const auditUserId = getCurrentRequestUserId() ?? null;
  const assetKey = normalizeAssetKey(
    options?.key ??
      (options?.parentTaskId
        ? null
        : sessionSourceKey({
            id,
            slackChannelId: options?.slackChannelId,
            slackThreadTs: options?.slackThreadTs,
            contextKey: options?.contextKey,
          })) ??
      defaultAssetKey("task", id),
  );
  // The Linear tracker dedup guard and the INSERT commit as one unit. Two
  // distinct webhook deliveries for the same issue are dispatched
  // fire-and-forget (src/linear/webhook.ts), nothing serializes them, and
  // `agent_tasks` has no UNIQUE index on contextKey, so a guard read separated
  // from the INSERT by any await lets both deliveries create a task for one
  // issue. The FIFO lock serializes whole transactions, so the loser's re-read
  // observes the winner's committed row. Pre-checks at the call sites
  // (src/tools/send-task.ts, src/linear/sync.ts) stay a fast path only.
  const tasks = getStorage().repos.tasks;
  // Decision D7 opt-down, for the caller that asks (the unkeyed REST create):
  // on Postgres this transaction runs at READ COMMITTED. Reason: under
  // SERIALIZABLE, 58% of unkeyed creates retried in the seeded bench (ledger
  // part 9), from predicate reads of agent_tasks and agents (routing snapshot,
  // human-free class). What SERIALIZABLE guarded, and how each holds here:
  // the Linear tracker dedup and the workflow step check have no row to lock,
  // so a create that needs either stays SERIALIZABLE; the parent key re-read
  // locks the parent row first (`FOR UPDATE`), so an in-flight chain move
  // commits before the read. Scenario: stress-task-create.
  const readCommitted =
    txMode?.readCommitted === true &&
    !options?.workflowRunStepId &&
    (options?.bypassTrackerContextDedup || !isLinearTrackerContextKey(options?.contextKey));
  const claim = await getStorage().transaction<
    { existing: ExistingTrackerContextWork } | { row: AgentTaskRow }
  >(
    async () => {
      // A workflow step's task commits only while the step may still start
      // work. Checked in the INSERT's transaction: a cascade cancel of the
      // step's run tree either commits first and is seen here, or sees and
      // cancels this task.
      if (options?.workflowRunStepId) {
        const blocked = await getStepExecutionBlock(options.workflowRunStepId);
        if (blocked) throw new WorkflowStepNotExecutableError(options.workflowRunStepId, blocked);
      }
      const existingTrackerWork = options?.bypassTrackerContextDedup
        ? null
        : await findExistingLinearTrackerContextWork(options?.contextKey);
      if (existingTrackerWork) return { existing: existingTrackerWork };

      // A chain move (a user move, the source key backfill) can commit between
      // the parent read above and this write lock. Its chain query did not see
      // this child, so take the parent's key as it is now.
      if (readCommitted && keyInherited && options?.parentTaskId) {
        await tasks.lockTask(options.parentTaskId);
      }
      const parentKey =
        keyInherited && options?.parentTaskId
          ? ((await tasks.findTaskKey(options.parentTaskId)) ?? undefined)
          : undefined;
      const insertKey = parentKey ? normalizeAssetKey(parentKey) : assetKey;

      let routingDecisionSnapshot: RoutingDecisionSnapshot | null = null;
      try {
        routingDecisionSnapshot = await captureRoutingDecisionSnapshot(options);
      } catch (error) {
        logRoutingDecisionFailure(id, "capture", error);
      }

      const isHumanFree = await classifyTaskHumanFree({
        taskType: options?.taskType,
        tags: JSON.stringify(options?.tags ?? []),
        source: options?.source ?? "mcp",
        requestedByUserId: options?.requestedByUserId,
        requestedByUserIdInherited,
        parentTaskId: options?.parentTaskId,
        workflowRunId: options?.workflowRunId,
      });

      const provenance = getCurrentRunProvenance();
      const inserted = (await tasks.insertTask({
        id,
        key: insertKey,
        agentId: options?.agentId ?? null,
        creatorAgentId: options?.creatorAgentId ?? null,
        // Free text from every task source; scrub at the single INSERT.
        task: scrubSecrets(task),
        status,
        source: options?.source ?? "mcp",
        routing_reason: options?.routingReason ?? null,
        routing_source: options?.routingSource ?? null,
        routing_note: options?.routingNote ?? null,
        taskType: options?.taskType ?? null,
        tags: JSON.stringify(options?.tags ?? []),
        priority: options?.priority ?? 50,
        dependsOn: JSON.stringify(options?.dependsOn ?? []),
        offeredTo: options?.offeredTo ?? null,
        offeredAt: options?.offeredTo ? now : null,
        slackChannelId: options?.slackChannelId ?? null,
        slackThreadTs: options?.slackThreadTs ?? null,
        slackTriggerMessageTs: options?.slackTriggerMessageTs ?? null,
        slackUserId: options?.slackUserId ?? null,
        slackParticipants: options?.slackParticipants
          ? JSON.stringify(options.slackParticipants)
          : null,
        vcsProvider: options?.vcsProvider ?? null,
        vcsRepo: options?.vcsRepo ?? null,
        vcsEventType: options?.vcsEventType ?? null,
        vcsNumber: options?.vcsNumber ?? null,
        vcsCommentId: options?.vcsCommentId ?? null,
        vcsAuthor: options?.vcsAuthor ?? null,
        vcsUrl: options?.vcsUrl ?? null,
        vcsInstallationId: options?.vcsInstallationId ?? null,
        vcsNodeId: options?.vcsNodeId ?? null,
        agentmailInboxId: options?.agentmailInboxId ?? null,
        agentmailMessageId: options?.agentmailMessageId ?? null,
        agentmailThreadId: options?.agentmailThreadId ?? null,
        mentionMessageId: options?.mentionMessageId ?? null,
        mentionChannelId: options?.mentionChannelId ?? null,
        dir: options?.dir ?? null,
        parentTaskId: options?.parentTaskId ?? null,
        dispatchedByTaskId: options?.dispatchedByTaskId ?? null,
        model: options?.model ?? null,
        modelTier: options?.modelTier ?? null,
        effort: options?.effort ?? null,
        profile: options?.profile?.trim() || null,
        modelGroup: options?.modelGroup?.trim() || null,
        fallbackHops: options?.fallbackHops?.length ? JSON.stringify(options.fallbackHops) : null,
        scheduleId: options?.scheduleId ?? null,
        workflowRunId: options?.workflowRunId ?? null,
        workflowRunStepId: options?.workflowRunStepId ?? null,
        outputSchema: options?.outputSchema ? JSON.stringify(options.outputSchema) : null,
        followUpConfig: options?.followUpConfig ? JSON.stringify(options.followUpConfig) : null,
        requestedByUserId: options?.requestedByUserId ?? null,
        requestedByUserIdInherited,
        contextKey: options?.contextKey ?? null,
        routingAffinity: options?.routingAffinity ? JSON.stringify(options.routingAffinity) : null,
        swarmVersion: pkg.version,
        createdAt: now,
        lastUpdatedAt: now,
        created_by: auditUserId,
        updated_by: auditUserId,
        isHumanFree,
        // A task a workflow node owns keeps only its workflowRunId: the engine
        // can run that node inside the request of the script that triggered it.
        sourceStepId: options?.workflowRunId ? null : (provenance?.sourceStepId ?? null),
        sourceScriptRunId: options?.workflowRunId ? null : (provenance?.sourceScriptRunId ?? null),
      })) as AgentTaskRow | null;
      if (!inserted) throw new Error("Failed to create task");

      if (routingDecisionSnapshot) {
        try {
          // A nested transaction (a SAVEPOINT): this write may fail without
          // failing the task, and on Postgres a failed statement aborts the
          // whole transaction unless it ran inside a savepoint.
          await getStorage().transaction(() =>
            tasks.insertRoutingDecision({
              task_id: id,
              selected_agent_id: options.offeredTo ?? options.agentId ?? null,
              captured_at: routingDecisionSnapshot.capturedAt,
              worker_statuses: JSON.stringify(routingDecisionSnapshot.workerStatuses),
              continuity_candidates: JSON.stringify(routingDecisionSnapshot.continuityCandidates),
              created_by: auditUserId,
              updated_by: auditUserId,
            }),
          );
        } catch (error) {
          logRoutingDecisionFailure(id, "write", error);
        }
      }
      return { row: inserted };
    },
    readCommitted ? { isolation: "read committed" } : {},
  );

  if ("existing" in claim) {
    console.log(
      `[task-dedup] Skipping Linear tracker task creation for ${options?.contextKey}: ${claim.existing.reason} ${claim.existing.task.id.slice(0, 8)} already exists`,
    );
    return claim.existing.task;
  }
  const row = claim.row;

  try {
    await createLogEntry({
      eventType: status === "offered" ? "task_offered" : "task_created",
      agentId: options?.creatorAgentId,
      taskId: id,
      newValue: status,
      metadata: {
        source: options?.source ?? "mcp",
        leadOnly: options?.routingAffinity?.leadOnly === true,
        authorization: options?.routingAffinity?.leadOnly
          ? { decision: "authorized", targetAgentId: options.agentId ?? options.offeredTo ?? null }
          : undefined,
      },
    });
  } catch {}

  emitTaskLifecycleTelemetryAfterCommit(
    "created",
    {
      taskId: row.id,
      source: row.source,
      ...taskContextForTelemetry(rowToAgentTask(row)),
      hasParent: !!row.parentTaskId,
      has_repo: !!row.vcsRepo,
      priority: row.priority,
    },
    (task) => task !== null,
    // The human who asked (a pseudonymous user_ref), null for system tasks.
    row.requestedByUserId,
  );

  getStorage().afterCommit(() => {
    import("../workflows/event-bus")
      .then(({ workflowEventBus }) => {
        workflowEventBus.emit("task.created", {
          taskId: row.id,
          task: row.task,
          source: row.source,
          tags: options?.tags ?? [],
          agentId: row.agentId,
          workflowRunId: row.workflowRunId,
          workflowRunStepId: row.workflowRunStepId,
        });
      })
      .catch((err) =>
        console.error(
          "[db] task.created event not emitted:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        ),
      );
  });

  return rowToAgentTask(row);
}

export async function claimTask(taskId: string, agentId: string): Promise<AgentTask | null> {
  // Static per (agent, task), so this pre-check does not reopen the atomic
  // claim race. It always applies to lead-only authorization.
  {
    const task = await getTaskById(taskId);
    const agent = await getAgentById(agentId);
    if (task && (!agent || !isAgentEligibleForTask(agent, task))) {
      try {
        await createLogEntry({
          eventType: "task_claim_rejected_affinity",
          agentId,
          taskId,
          metadata: {
            agentRole: agent?.role ?? null,
            requiredRole: task.routingAffinity?.role ?? null,
            leadOnly: task.routingAffinity?.leadOnly === true,
            agentIsLead: agent?.isLead ?? false,
          },
        });
      } catch {}
      return null;
    }
  }

  // Atomic claim: single UPDATE with WHERE guard ensures exactly-once claiming.
  // No pre-read needed — the WHERE clause handles the race condition.
  // Status goes directly to 'in_progress' because the claiming session is
  // already working on the task (prevents duplicate task_assigned triggers).
  const now = new Date().toISOString();
  const row = await getStorage().repos.tasks.claimUnassignedTask(taskId, agentId, now);

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_claimed",
        agentId,
        taskId,
        oldValue: "unassigned",
        newValue: "in_progress",
      });
    } catch {}
  }

  const result = row ? rowToAgentTask(row as AgentTaskRow) : null;
  // Fire-and-forget: notify lifecycle subscribers (e.g. GitHub eyes reaction)
  if (result) {
    emitTaskStarted(result);
  }
  return result;
}

export async function releaseTask(
  taskId: string,
  wakeSnapshot?: AgentTask,
): Promise<AgentTask | null> {
  const task = wakeSnapshot ?? (await getTaskById(taskId));
  if (!task) return null;
  // Allow releasing both 'pending' (directly assigned) and 'in_progress' (pool-claimed) tasks
  if (task.status !== "pending" && task.status !== "in_progress") return null;

  const now = new Date().toISOString();
  const row = await getStorage().repos.tasks.releaseTaskToPool(
    taskId,
    now,
    wakeSnapshot
      ? { agentId: wakeSnapshot.agentId ?? null, poolWakeAt: wakeSnapshot.poolWakeAt ?? null }
      : undefined,
  );

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_released",
        agentId: task.agentId ?? undefined,
        taskId,
        oldValue: task.status,
        newValue: "unassigned",
      });
    } catch {}
    // The sweep routes released wakes itself, preserving its exclusion of the old agent.
    if (isRuntimePoolsEnabled() && !wakeSnapshot)
      getStorage().afterCommit(() => {
        void import("../workflows/event-bus")
          .then(({ workflowEventBus }) => workflowEventBus.emit("task.unassigned", { taskId }))
          .catch((error) =>
            console.error("[db] Routing event failed:", scrubSecrets(String(error))),
          );
      });
  }

  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

export async function acceptTask(taskId: string, agentId: string): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  const agent = await getAgentById(agentId);
  // Extension identities never take work, including offers left over from
  // before creation-time rejection existed.
  if (isExtensionAgent(agent)) return null;
  if (
    (task.routingAffinity?.leadOnly || task.routingAffinityInvalid) &&
    (!agent || !isAgentEligibleForTask(agent, task))
  ) {
    try {
      await createLogEntry({
        eventType: "task_claim_rejected_affinity",
        agentId,
        taskId,
        metadata: {
          leadOnly: true,
          agentIsLead: agent?.isLead ?? false,
          decision: "reject_offer_accept",
        },
      });
    } catch {}
    return null;
  }
  // Accept both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId)
    return null;

  const now = new Date().toISOString();
  const row = await getStorage().repos.tasks.acceptOfferedTask(taskId, agentId, now);

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_accepted",
        agentId,
        taskId,
        oldValue: task.status,
        newValue: "pending",
      });
    } catch {}
    getStorage().afterCommit(() => publishWorkerNudge(agentId, { kind: "work", taskId }));
  }

  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

export async function rejectTask(
  taskId: string,
  agentId: string,
  reason?: string,
): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  // Reject both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId)
    return null;

  const now = new Date().toISOString();
  const row = await getStorage().repos.tasks.rejectOfferedTask(taskId, reason ?? null, now);

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_rejected",
        agentId,
        taskId,
        oldValue: task.status,
        newValue: "unassigned",
        metadata: reason ? { reason } : undefined,
      });
    } catch {}
    if (isRuntimePoolsEnabled())
      getStorage().afterCommit(() => {
        void import("../workflows/event-bus")
          .then(({ workflowEventBus }) => workflowEventBus.emit("task.unassigned", { taskId }))
          .catch((error) =>
            console.error("[db] Routing event failed:", scrubSecrets(String(error))),
          );
      });
  }

  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

/**
 * Move a task to backlog status. Task must be unassigned (in pool).
 * Backlog tasks are not returned by pool queries.
 */
export async function moveTaskToBacklog(taskId: string): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "unassigned") return null;

  const now = new Date().toISOString();
  const row = await getStorage().repos.tasks.moveTaskStatus(taskId, "unassigned", "backlog", now);

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_status_change",
        taskId,
        oldValue: "unassigned",
        newValue: "backlog",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

/**
 * Move a task from backlog to unassigned (pool). Task must be in backlog status.
 */
export async function moveTaskFromBacklog(taskId: string): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "backlog") return null;

  const now = new Date().toISOString();
  const row = await getStorage().repos.tasks.moveTaskStatus(taskId, "backlog", "unassigned", now);

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_status_change",
        taskId,
        oldValue: "backlog",
        newValue: "unassigned",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

/**
 * Promote a task out of `draft` status into whichever status it should have
 * had at creation time — `offered` if it was offered to an agent, `pending`
 * if it has an owning agent (the common UI-composer case, which defaults to
 * Lead), otherwise `unassigned`. `draft` exists solely to keep a task
 * dispatch-ineligible while its UI-uploaded attachments are still in flight
 * (#1240); this is the promote half of that window. Called once the upload
 * batch settles — success, partial failure, or total failure all promote, a
 * draft is never left stranded by upload errors — or by
 * `promoteAbandonedDraftTasks` for drafts nobody ever promoted.
 */
export async function promoteDraftTask(taskId: string): Promise<AgentTask | null> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.tasks.promoteDraftTask(taskId, now);

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: "draft",
        newValue: row.status,
      });
    } catch {}
  }

  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

/**
 * Mark a draft as still being worked on, so `promoteAbandonedDraftTasks`
 * (which goes by `lastUpdatedAt`) doesn't promote it while an upload batch
 * that outlasts the sweep window is still running. No-op once promoted.
 */
export async function refreshDraftTaskLease(taskId: string): Promise<void> {
  await getStorage().repos.tasks.refreshDraftTaskLease(taskId, new Date().toISOString());
}

/**
 * Heartbeat sweep: promote drafts abandoned mid-upload (tab closed, network
 * dropped) instead of leaving them permanently dispatch-ineligible — the
 * composer's UI-driven promote (`promoteDraftTask`) never fires if the user
 * never comes back. Same target-status logic, applied in bulk by elapsed
 * time. Default 5 minutes is well above the tens-of-seconds worst-case
 * upload-batch duration seen against slow storage (#1226) while still
 * surfacing an abandoned session to its owner promptly.
 */
export async function promoteAbandonedDraftTasks(timeoutMinutes: number = 5): Promise<number> {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  return await getStorage().repos.tasks.promoteDraftsIdleSince(cutoffTime, now);
}

/**
 * Release tasks that have been in 'reviewing' status for too long.
 * Returns them to 'offered' status for retry.
 */
export async function releaseStaleReviewingTasks(timeoutMinutes: number = 30): Promise<number> {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  return await getStorage().repos.tasks.releaseReviewingIdleSince(cutoffTime, now);
}

/**
 * Release 'offered' tasks whose offeree can no longer possibly poll for them
 * — the agent was deleted, or is `offline` (multi-runtime expiry once its
 * last runtime instance ages out, or an explicit graceful close). Returns
 * them to `unassigned` rather than back to `offered`: a stuck offer is
 * invisible to `autoAssignPoolTasks` (which only scans `unassigned`) and to
 * the poll-based accept/reject path (which only the original offeree can
 * reach), so `offered` is a dead end once the offeree is gone (#1190).
 *
 * Deliberately gated on liveness, not elapsed time: a fixed timeout would
 * either yank a live offer out from under an offeree that is simply slow to
 * poll, or (set generously) leave a genuinely dead offeree's task stranded
 * for the full window regardless of how obviously offline it already is.
 * `agents.status = 'offline'` already encodes the staleness threshold that
 * matters — `runtimeStaleThresholdMinutes()` / `RUNTIME_STALE_THRESHOLD_MIN`
 * for multi-runtime expiry, or immediate for an explicit close — so no
 * separate timeout knob is introduced here.
 * When runtime pools are enabled, the supplied reachability predicate preserves
 * offers to wakeable or provisioning agents without a DB import of runtime-pools.
 */
export async function releaseStaleOfferedTasksForOfflineAgents(
  isReachable?: (agent: Agent) => Promise<boolean>,
): Promise<number> {
  const now = new Date().toISOString();
  const reachable: string[] = [];
  if (isRuntimePoolsEnabled() && isReachable) {
    for (const agent of await getAllAgents()) {
      if (agent.status === "offline" && (await isReachable(agent))) reachable.push(agent.id);
    }
  }

  return await getStorage().repos.tasks.releaseOffersOfOfflineAgents(now, reachable);
}

export async function getOfferedTasksForAgent(agentId: string): Promise<AgentTask[]> {
  const rows = await getStorage().repos.tasks.listOfferedTasksForAgent(agentId);
  return rows.map((row) => rowToAgentTask(row as AgentTaskRow));
}

/**
 * Atomically claim an offered task for review.
 * Marks it as 'reviewing' to prevent duplicate polling.
 * Returns null if task is not offered to this agent or already claimed.
 */
export async function claimOfferedTask(taskId: string, agentId: string): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "offered" || task.offeredTo !== agentId) return null;
  const agent = await getAgentById(agentId);
  if (isExtensionAgent(agent)) return null;
  if (
    (task.routingAffinity?.leadOnly || task.routingAffinityInvalid) &&
    (!agent || !isAgentEligibleForTask(agent, task))
  ) {
    try {
      await createLogEntry({
        eventType: "task_claim_rejected_affinity",
        agentId,
        taskId,
        metadata: {
          leadOnly: true,
          agentIsLead: agent?.isLead ?? false,
          decision: "reject_offer_claim",
        },
      });
    } catch {}
    return null;
  }

  const now = new Date().toISOString();
  const row = await getStorage().repos.tasks.moveTaskStatus(taskId, "offered", "reviewing", now);

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId,
        oldValue: "offered",
        newValue: "reviewing",
      });
    } catch {
      // Log creation is best-effort
    }
  }
  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

export async function getUnassignedTasksCount(): Promise<number> {
  return await getStorage().repos.tasks.countUnassignedTasks();
}

/** Get unassigned task IDs, ordered by priority (highest first) then creation time */
export async function getUnassignedTaskIds(limit = 10): Promise<string[]> {
  return await getStorage().repos.tasks.listUnassignedTaskIds(limit);
}

/**
 * Batch size for the paginated eligibility scans in
 * `getUnassignedTaskIdsForAgent` (and `autoAssignPoolTasks` in
 * src/heartbeat/heartbeat.ts, which mirrors this pattern). A fixed single
 * window used to mean N ineligible affinity-tagged tasks at the head of the
 * priority order could hide all eligible work behind them forever — see
 * PR #954 review. Scanning continues page-by-page until `limit` eligible
 * candidates are found or the pool is exhausted; the scan cap
 * (`getEligibilityScanCap`) bounds worst-case DB load when eligible work is
 * buried deep or genuinely absent.
 */
const ELIGIBILITY_SCAN_BATCH_SIZE = Number(process.env.ELIGIBILITY_SCAN_BATCH_SIZE) || 25;

/**
 * Same ordering as `getUnassignedTaskIds`, filtered through
 * `isAgentEligibleForTask` for the requesting agent. Used by the poll
 * auto-claim path so an ineligible candidate is never even offered to the
 * budget gate / claim loop. Paginates through the unassigned pool in
 * `ELIGIBILITY_SCAN_BATCH_SIZE`-row windows (filtering in JS to avoid
 * JSON-parsing `routingAffinity` in SQL) until `limit` eligible tasks are
 * found or the pool is exhausted, capped at `ELIGIBILITY_SCAN_CAP` rows
 * scanned so a pool full of ineligible tasks can't turn every poll into an
 * unbounded scan. `accept` adds a caller-side filter (e.g. harness model
 * compatibility) that runs inside the scan, so rejected rows do not use up
 * the `limit`.
 */
export async function getUnassignedTaskIdsForAgent(
  agentId: string,
  limit = 10,
  accept?: (task: AgentTask) => boolean | Promise<boolean>,
): Promise<string[]> {
  const agent = await getAgentById(agentId);
  if (!agent) return [];

  const batchSize = Math.max(limit * 5, ELIGIBILITY_SCAN_BATCH_SIZE);
  const eligible: string[] = [];
  const scanCap = getEligibilityScanCap();
  let offset = 0;

  while (eligible.length < limit && offset < scanCap) {
    const rows = await getStorage().repos.tasks.listUnassignedTasks(batchSize, offset);
    if (rows.length === 0) break;

    for (const row of rows) {
      const task = rowToAgentTask(row as AgentTaskRow);
      if (isAgentEligibleForTask(agent, task) && (!accept || (await accept(task)))) {
        eligible.push(task.id);
        if (eligible.length >= limit) break;
      }
    }

    offset += rows.length;
    if (rows.length < batchSize) break; // Exhausted the pool.
  }

  return eligible;
}

// ============================================================================
// Dependency Checking
// ============================================================================

export async function checkDependencies(taskId: string): Promise<{
  ready: boolean;
  blockedBy: string[];
}> {
  const task = await getTaskById(taskId);
  if (!task || !task.dependsOn || task.dependsOn.length === 0) {
    return { ready: true, blockedBy: [] };
  }

  const blockedBy: string[] = [];
  for (const depId of task.dependsOn) {
    const depTask = await getTaskById(depId);
    // A skipped dependency settled without work to hand on; it does not
    // block, the same as a completed one.
    if (!depTask || (depTask.status !== "completed" && depTask.status !== "skipped")) {
      blockedBy.push(depId);
    }
  }

  return { ready: blockedBy.length === 0, blockedBy };
}

/**
 * Reverse-lookup: find all tasks whose `dependsOn` JSON array contains `parentId`.
 * Uses SQLite `json_each` to scan the dependsOn column efficiently.
 * Returns only non-terminal tasks by default (the callers want to cascade-fail
 * live dependents, not re-process already-finished ones).
 */
export async function getDependentTasks(
  parentId: string,
  opts?: { includeTerminal?: boolean },
): Promise<AgentTask[]> {
  const rows = await getStorage().repos.tasks.listDependentTasks(parentId);

  const tasks = rows.map((row) => rowToAgentTask(row as AgentTaskRow));
  if (opts?.includeTerminal) return tasks;
  return tasks.filter((t) => !isTerminalTaskStatus(t.status));
}

export interface CascadeFailResult {
  taskId: string;
  taskSubject: string;
}

/**
 * Recursively cascade-fail all transitive dependents of a parent task.
 * Walks the full dependency graph: if A fails, and B depends on A, and C
 * depends on B, then both B and C are failed.
 *
 * Guards against cycles with a visited set. Skips already-terminal tasks.
 * Returns the list of tasks that were actually cascade-failed (for follow-up
 * enrichment).
 */
export async function cascadeFailDependents(
  parentId: string,
  parentStatus: string,
  visited?: Set<string>,
): Promise<CascadeFailResult[]> {
  const seen = visited ?? new Set<string>();
  if (seen.has(parentId)) return [];
  seen.add(parentId);

  const dependents = await getDependentTasks(parentId);
  const results: CascadeFailResult[] = [];

  for (const dep of dependents) {
    if (seen.has(dep.id)) continue;

    const reason = `Blocked dependency ${parentId.slice(0, 8)} was ${parentStatus}`;
    const failed = await failTask(dep.id, reason, { statusKind: "cascade" });
    if (failed) {
      results.push({
        taskId: failed.id,
        taskSubject: failed.task.slice(0, 120),
      });
      // Recurse: this dependent may itself have dependents
      const transitive = await cascadeFailDependents(dep.id, "failed (cascade)", seen);
      results.push(...transitive);
    }
  }

  return results;
}

// ============================================================================
// Agent Profile Operations
// ============================================================================

// Default markdown template generators moved to src/prompts/defaults.ts
// Re-export for backwards compatibility with any external consumers
export {
  generateDefaultClaudeMd,
  generateDefaultIdentityMd,
  generateDefaultSoulMd,
  generateDefaultToolsMd,
} from "../prompts/defaults.ts";

export async function updateAgentProfile(
  id: string,
  requested: {
    name?: string;
    description?: string;
    role?: string;
    capabilities?: string[];
    claudeMd?: string;
    soulMd?: string;
    identityMd?: string;
    setupScript?: string;
    toolsMd?: string;
    heartbeatMd?: string;
    /** `null` resets to the deterministic fallback; omit the key to leave untouched. */
    avatar?: AgentAvatar | null;
    slackIcon?: AgentSlackIcon | null;
  },
  meta?: VersionMeta,
  guard?: {
    /** Per-field compare-and-set token; see {@link ProfileExpectedHashes}. */
    expectedHashes?: ProfileExpectedHashes;
    /** Called once per field dropped because its expected hash was stale. */
    onConflict?: (conflict: ProfileSyncConflict) => void;
    /** Only the extension identity lifecycle may grant the reserved extension role. */
    allowExtensionRole?: boolean;
  },
): Promise<Agent | null> {
  const storage = getStorage();
  const agents = storage.repos.agents;
  // Conflicts are reported after commit: a replayed attempt (decision D6) finds
  // them again, and the caller must hear each dropped field once.
  const outcome = await storage.transaction(async () => {
    const conflicts: ProfileSyncConflict[] = [];
    const agent = await (async (): Promise<Agent | null> => {
      // A local copy: a replayed attempt (decision D6) must start from the request.
      let updates = requested;
      // Get current agent state for version comparison
      const current = (await agents.findAgentById(id)) as AgentRow | null;
      if (!current) return null;

      const roleViolation = reservedRoleViolation(current.role, updates.role, {
        allowExtensionRole: guard?.allowExtensionRole,
      });
      if (roleViolation) throw new ReservedAgentRoleError(roleViolation);

      // Compare with the old metadata before replacing it. Persist refreshed defaults
      // atomically so both running workers and restarted workers see matching blobs.
      const previous = rowToAgent(current);
      const next = {
        name: updates.name ?? previous.name,
        description: updates.description ?? previous.description,
        role: updates.role ?? previous.role,
        capabilities: updates.capabilities ?? previous.capabilities,
      };
      const metadataChanged =
        next.name !== previous.name ||
        next.description !== previous.description ||
        next.role !== previous.role ||
        JSON.stringify(next.capabilities) !== JSON.stringify(previous.capabilities);
      if (metadataChanged) {
        updates = { ...updates };
        if (
          updates.identityMd === undefined &&
          previous.identityMd &&
          matchesDefaultIdentityMd(previous.identityMd, previous)
        ) {
          updates.identityMd = generateDefaultIdentityMd(next);
        }
        if (
          updates.claudeMd === undefined &&
          previous.claudeMd &&
          matchesDefaultClaudeMd(previous.claudeMd, previous)
        ) {
          updates.claudeMd = generateDefaultClaudeMd(next);
        }
      }

      // Compare-and-set. A writer that edits a copy of a field (a session's
      // materialized CLAUDE.md) sends the hash that copy was based on. If the DB
      // moved since — a sibling session's sync, an `update-profile` — the copy is
      // stale and writing it would revert the newer value, so the field is dropped
      // (no version, no column write). An edit on top of the current value applies,
      // including a deliberate revert to an earlier version. Without a token the
      // write is unconditional, as before.
      //
      // Runs BEFORE the budget check: a stale copy of an older, longer value must be
      // dropped, not rejected — a budget rejection throws and would also roll back
      // the other fields of the same update.
      const writable = { ...updates };
      for (const field of VERSIONABLE_FIELDS) {
        const expectedHash = guard?.expectedHashes?.[field];
        if (expectedHash === undefined) continue;
        if (writable[field] === undefined || writable[field] === null) continue;

        const currentHash = computeContentHash(current[field] ?? "");
        if (currentHash === expectedHash) continue;

        console.warn(
          `[profile-sync] agent ${id}: ${field} dropped — based on ${expectedHash.slice(0, 12)}, DB is at ${currentHash.slice(0, 12)}`,
        );
        delete writable[field];
        conflicts.push({ field, expectedHash, currentHash });
      }

      if (writable.heartbeatMd !== undefined) {
        validateHeartbeatExpiry(current.heartbeatMd ?? "", writable.heartbeatMd);
      }

      for (const field of BUDGETED_IDENTITY_FIELDS) {
        const nextValue = writable[field];
        if (nextValue === undefined) continue;

        const result = checkIdentityFieldBudget({
          field,
          currentValue: current[field] ?? "",
          nextValue,
        });
        if (!result.ok) {
          throw new IdentityFieldBudgetError(
            result,
            computeContentHash(current[field] ?? ""),
            computeContentHash(nextValue),
          );
        }
      }

      if (updates.name !== undefined) {
        const existingAgent = await agents.findAgentByNameExcept(updates.name, id);
        if (existingAgent) throw new Error("Agent name already exists");
      }

      // Create context versions for changed fields (stale copies already dropped)
      for (const field of VERSIONABLE_FIELDS) {
        const newValue = writable[field];
        if (newValue === undefined || newValue === null) continue;

        const currentValue = current[field] ?? "";
        const newHash = computeContentHash(newValue);
        const currentHash = computeContentHash(currentValue);

        if (newHash === currentHash) continue; // No actual change

        const latestVersion = await getLatestContextVersion(id, field);
        const version = (latestVersion?.version ?? 0) + 1;

        await createContextVersion({
          agentId: id,
          field,
          content: newValue,
          version,
          changeSource: meta?.changeSource ?? "api",
          changedByAgentId: meta?.changedByAgentId ?? null,
          changeReason: meta?.changeReason ?? null,
          contentHash: newHash,
          previousVersionId: latestVersion?.id ?? null,
        });
      }

      // Proceed with existing UPDATE logic.
      //
      // `avatar` can't use the COALESCE(?, col) pattern the other fields use:
      // COALESCE can never write NULL back (a bound NULL just falls through to
      // the existing value), which would make "reset to default avatar"
      // unimplementable. So it gets its own explicit-set CASE, gated by an
      // `avatarProvided` flag distinguishing "key absent from updates" (leave
      // untouched) from "key present with value null" (reset).
      const avatarProvided = Object.hasOwn(updates, "avatar");
      const avatarJson = updates.avatar ? JSON.stringify(updates.avatar) : null;
      const slackIconProvided = Object.hasOwn(updates, "slackIcon");
      const slackIconJson = updates.slackIcon ? JSON.stringify(updates.slackIcon) : null;

      const now = new Date().toISOString();
      const row = (await agents.updateAgentProfile(id, {
        name: updates.name ?? null,
        description: updates.description ?? null,
        role: updates.role ?? null,
        capabilities: updates.capabilities ? JSON.stringify(updates.capabilities) : null,
        claudeMd: writable.claudeMd ?? null,
        soulMd: writable.soulMd ?? null,
        identityMd: writable.identityMd ?? null,
        setupScript: writable.setupScript ?? null,
        toolsMd: writable.toolsMd ?? null,
        heartbeatMd: writable.heartbeatMd ?? null,
        avatar: { set: avatarProvided, value: avatarJson },
        slackIcon: { set: slackIconProvided, value: slackIconJson },
        now,
      })) as AgentRow | null;

      return row ? rowToAgent(row) : null;
    })();
    return { agent, conflicts };
  });
  for (const conflict of outcome.conflicts) guard?.onConflict?.(conflict);
  return outcome.agent;
}

export async function updateAgentName(id: string, newName: string): Promise<Agent | null> {
  return await updateAgentProfile(id, { name: newName });
}

// ============================================================================
// Channel Operations
// ============================================================================

type ChannelRow = {
  id: string;
  name: string;
  description: string | null;
  type: ChannelType;
  createdBy: string | null;
  participants: string | null;
  createdAt: string;
};

function rowToChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    type: row.type,
    createdBy: row.createdBy ?? undefined,
    participants: row.participants ? JSON.parse(row.participants) : [],
    createdAt: row.createdAt,
  };
}

type ChannelMessageRow = {
  id: string;
  channelId: string;
  agentId: string | null;
  content: string;
  replyToId: string | null;
  mentions: string | null;
  createdAt: string;
};

function rowToChannelMessage(row: ChannelMessageRow, agentName?: string): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channelId,
    agentId: row.agentId,
    agentName: agentName ?? (row.agentId ? undefined : "Human"),
    content: row.content,
    replyToId: row.replyToId ?? undefined,
    mentions: row.mentions ? JSON.parse(row.mentions) : [],
    createdAt: row.createdAt,
  };
}

export async function createChannel(
  name: string,
  options?: {
    description?: string;
    type?: ChannelType;
    createdBy?: string;
    participants?: string[];
  },
): Promise<Channel> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = (await getStorage().repos.messaging.insertChannel({
    id,
    name,
    description: options?.description ?? null,
    type: options?.type ?? "public",
    createdBy: options?.createdBy ?? null,
    participants: JSON.stringify(options?.participants ?? []),
    createdAt: now,
  })) as ChannelRow | null;

  if (!row) throw new Error("Failed to create channel");
  return rowToChannel(row);
}

export async function getMessageById(id: string): Promise<ChannelMessage | null> {
  const row = await getStorage().repos.messaging.findChannelMessage(id);
  if (!row) return null;
  const agent = row.agentId ? await getAgentById(row.agentId) : null;
  return rowToChannelMessage(row, agent?.name);
}

export async function getChannelById(id: string): Promise<Channel | null> {
  const row = (await getStorage().repos.messaging.findChannelById(id)) as ChannelRow | null;
  return row ? rowToChannel(row) : null;
}

export async function getChannelByName(name: string): Promise<Channel | null> {
  const row = (await getStorage().repos.messaging.findChannelByName(name)) as ChannelRow | null;
  return row ? rowToChannel(row) : null;
}

export async function getAllChannels(): Promise<Channel[]> {
  const rows = (await getStorage().repos.messaging.listChannels()) as ChannelRow[];
  return rows.map(rowToChannel);
}

export async function deleteChannel(id: string): Promise<boolean> {
  return (await getStorage().repos.messaging.deleteChannel(id)) > 0;
}

export async function postMessage(
  channelId: string,
  agentId: string | null,
  content: string,
  options?: {
    replyToId?: string;
    mentions?: string[];
  },
): Promise<ChannelMessage> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Detect /task prefix - only create tasks when explicitly requested
  const isTaskMessage = content.trimStart().startsWith("/task ");
  // Scrubbed once here: the row, the task description built from it and the
  // appended task-link UPDATE below all derive from this value.
  const messageContent = scrubSecrets(
    isTaskMessage ? content.replace(/^\s*\/task\s+/, "") : content,
  );

  const row = await getStorage().repos.messaging.insertChannelMessage({
    id,
    channelId,
    agentId,
    content: messageContent,
    replyToId: options?.replyToId ?? null,
    mentions: JSON.stringify(options?.mentions ?? []),
    createdAt: now,
  });

  if (!row) throw new Error("Failed to post message");

  try {
    await createLogEntry({
      eventType: "channel_message",
      agentId: agentId ?? undefined,
      metadata: { channelId, messageId: id },
    });
  } catch {}

  // Determine which agents should receive task notifications
  let targetMentions = options?.mentions ?? [];

  // Thread follow-up: If no explicit mentions and this is a reply, inherit from parent message
  // Note: Only for notifications, not for task creation (requires explicit /task)
  if (targetMentions.length === 0 && options?.replyToId) {
    const parentMessage = await getMessageById(options.replyToId);
    if (parentMessage?.mentions && parentMessage.mentions.length > 0) {
      targetMentions = parentMessage.mentions;
    }
  }

  getStorage().afterCommit(() => {
    for (const mentionedAgentId of new Set(targetMentions)) {
      publishWorkerNudge(mentionedAgentId, { kind: "work" });
    }
  });

  // Only create tasks when /task prefix is used
  if (isTaskMessage && targetMentions.length > 0) {
    const sender = agentId ? await getAgentById(agentId) : null;
    const channel = await getChannelById(channelId);
    const senderName = sender?.name ?? "Human";
    const channelName = channel?.name ?? "unknown";
    const truncated =
      messageContent.length > 80 ? `${messageContent.slice(0, 80)}...` : messageContent;

    // Dedupe mentions (self-mentions allowed - agents can create tasks for themselves)
    const uniqueMentions = [...new Set(targetMentions)];
    const createdTaskIds: string[] = [];

    for (const mentionedAgentId of uniqueMentions) {
      // Skip if agent doesn't exist
      const mentionedAgent = await getAgentById(mentionedAgentId);
      if (!mentionedAgent) continue;

      const taskDescription = `Task from ${senderName} in #${channelName}: "${truncated}"`;

      const task = await createTaskExtended(taskDescription, {
        agentId: mentionedAgentId, // Direct assignment
        routingReason: "human_pinned",
        routingSource: "engine_default",
        creatorAgentId: agentId ?? undefined,
        source: "mcp",
        taskType: "task",
        priority: 50,
        mentionMessageId: id,
        mentionChannelId: channelId,
      });
      createdTaskIds.push(task.id);
    }

    // Append task links to message content (markdown format for frontend)
    if (createdTaskIds.length > 0) {
      const taskLinks = createdTaskIds
        .map((taskId) => `[#${taskId.slice(0, 8)}](task:${taskId})`)
        .join(" ");
      const updatedContent = `${messageContent}\n\n→ Created: ${taskLinks}`;
      await getStorage().repos.messaging.setChannelMessageContent(id, updatedContent);
    }
  }

  // Get agent name for the response - re-fetch to get updated content
  const agent = agentId ? await getAgentById(agentId) : null;
  const updatedRow = await getStorage().repos.messaging.findChannelMessageWithAgent(id);
  return rowToChannelMessage(updatedRow ?? row, agent?.name);
}

export async function getChannelMessages(
  channelId: string,
  options?: {
    limit?: number;
    since?: string;
    before?: string;
  },
): Promise<ChannelMessage[]> {
  const rows = await getStorage().repos.messaging.listChannelMessages(channelId, {
    since: options?.since,
    before: options?.before,
    limit: options?.limit,
  });
  return rows.map((row) => rowToChannelMessage(row, row.agentName ?? undefined)).reverse(); // Return in chronological order
}

export async function updateReadState(agentId: string, channelId: string): Promise<void> {
  const now = new Date().toISOString();
  await getStorage().repos.messaging.setChannelLastRead(agentId, channelId, now);
}

export async function getLastReadAt(agentId: string, channelId: string): Promise<string | null> {
  const result = await getStorage().repos.messaging.findChannelReadState(agentId, channelId);
  return result?.lastReadAt ?? null;
}

export async function getUnreadMessages(
  agentId: string,
  channelId: string,
): Promise<ChannelMessage[]> {
  const lastReadAt = await getLastReadAt(agentId, channelId);

  const rows = await getStorage().repos.messaging.listChannelMessagesSince(channelId, lastReadAt);
  return rows.map((row) => rowToChannelMessage(row, row.agentName ?? undefined));
}

export async function getMentionsForAgent(
  agentId: string,
  options?: { unreadOnly?: boolean; channelId?: string },
): Promise<ChannelMessage[]> {
  const since =
    options?.channelId && options.unreadOnly
      ? await getLastReadAt(agentId, options.channelId)
      : null;
  const rows = await getStorage().repos.messaging.listMentionMessages(agentId, {
    channelId: options?.channelId,
    since,
  });
  return rows.map((row) => rowToChannelMessage(row, row.agentName ?? undefined));
}

// ============================================================================
// Inbox Summary (for system tray)
// ============================================================================

export interface MentionPreview {
  channelName: string;
  agentName: string;
  content: string;
  createdAt: string;
}

export interface InboxSummary {
  unreadCount: number;
  mentionsCount: number;
  offeredTasksCount: number;
  poolTasksCount: number;
  inProgressCount: number;
  recentMentions: MentionPreview[]; // Up to 3 recent @mentions
}

export async function getInboxSummary(agentId: string): Promise<InboxSummary> {
  const messaging = getStorage().repos.messaging;
  const channels = await getAllChannels();
  let unreadCount = 0;
  let mentionsCount = 0;

  for (const channel of channels) {
    // Check if this channel is already being processed
    const readState = await messaging.findChannelReadState(agentId, channel.id);

    const lastReadAt = readState?.lastReadAt ?? null;
    const isProcessing =
      readState?.processing_since !== null && readState?.processing_since !== undefined;

    // Skip channels that are already being processed
    if (isProcessing) continue;

    // Count unread (excluding own messages)
    unreadCount += await messaging.countUnreadChannelMessages(channel.id, agentId, lastReadAt);

    // Count mentions in unread
    mentionsCount += await messaging.countChannelMentions(channel.id, agentId, lastReadAt);
  }

  const tasks = getStorage().repos.tasks;
  // Count offered tasks for this agent
  const offeredCount = await tasks.countTasksWithStatus("offered", { offeredTo: agentId });

  // Count unassigned tasks in pool
  const poolCount = await tasks.countUnassignedTasks();

  // Count my in-progress tasks
  const inProgressCount = await tasks.countTasksWithStatus("in_progress", { agentId });

  // Get recent unread @mentions (up to 3)
  const recentMentions: MentionPreview[] = [];
  const mentionMessages = await getMentionsForAgent(agentId, { unreadOnly: false });

  // Filter to only unread mentions and limit to 3
  for (const msg of mentionMessages) {
    if (recentMentions.length >= 3) break;

    // Check if message is unread (by checking against read state per channel)
    const lastReadAt = await getLastReadAt(agentId, msg.channelId);
    if (lastReadAt && new Date(msg.createdAt) <= new Date(lastReadAt)) {
      continue; // Already read
    }

    // Get channel name
    const channel = await getChannelById(msg.channelId);

    recentMentions.push({
      channelName: channel?.name ?? "unknown",
      agentName: msg.agentName ?? "Unknown",
      content: msg.content.length > 100 ? `${msg.content.slice(0, 100)}...` : msg.content,
      createdAt: msg.createdAt,
    });
  }

  return {
    unreadCount,
    mentionsCount,
    offeredTasksCount: offeredCount,
    poolTasksCount: poolCount,
    inProgressCount,
    recentMentions,
  };
}

/**
 * Atomically claim unread mentions for an agent.
 * Sets processing_since to prevent duplicate polling.
 * Returns channels with unread mentions, or empty array if none/already claimed.
 */
export async function claimMentions(
  agentId: string,
  opts?: { dryRun?: boolean },
): Promise<{ channelId: string; lastReadAt: string | null; mentionsCount: number }[]> {
  const now = new Date().toISOString();
  const messaging = getStorage().repos.messaging;
  const channels = await getAllChannels();
  const claimedChannels: { channelId: string; lastReadAt: string | null; mentionsCount: number }[] =
    [];

  for (const channel of channels) {
    // Check if this channel is already being processed
    const readState = await messaging.findChannelReadState(agentId, channel.id);

    const lastReadAt = readState?.lastReadAt ?? null;
    const isProcessing =
      readState?.processing_since !== null && readState?.processing_since !== undefined;

    // Skip channels that are already being processed
    if (isProcessing) continue;

    // Check if there are unread mentions
    const mentionCount = await messaging.countChannelMentions(channel.id, agentId, lastReadAt);

    if (mentionCount > 0) {
      // dryRun: report what a claim would take, without the write (idle-poll probe).
      if (opts?.dryRun) {
        claimedChannels.push({
          channelId: channel.id,
          lastReadAt,
          mentionsCount: mentionCount,
        });
        continue;
      }
      // Atomically claim mentions for this channel
      const changes = await messaging.claimChannelMentions(
        agentId,
        channel.id,
        lastReadAt || new Date(0).toISOString(),
        now,
      );

      // Only add to claimed list if we actually claimed it (not already processing)
      if (changes > 0) {
        claimedChannels.push({
          channelId: channel.id,
          lastReadAt,
          mentionsCount: mentionCount,
        });
      }
    }
  }

  return claimedChannels;
}

/**
 * Release mention processing for specific channels.
 * Clears processing_since to allow future polling.
 */
export async function releaseMentionProcessing(
  agentId: string,
  channelIds: string[],
): Promise<void> {
  if (channelIds.length === 0) return;

  await getStorage().repos.messaging.releaseChannelProcessing(agentId, channelIds);
}

/**
 * Auto-release stale mention processing (for crashed Claude processes).
 */
export async function releaseStaleMentionProcessing(timeoutMinutes: number = 30): Promise<number> {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  return await getStorage().repos.messaging.releaseChannelProcessingBefore(cutoffTime);
}

// ============================================================================
// Service Operations (removed PM2 service registry; the table and these
// accessors stay until a drop migration lands)
// ============================================================================

type ServiceRow = {
  id: string;
  agentId: string;
  name: string;
  port: number;
  description: string | null;
  url: string | null;
  healthCheckPath: string | null;
  status: ServiceStatus;
  // PM2 configuration
  script: string;
  cwd: string | null;
  interpreter: string | null;
  args: string | null; // JSON array
  env: string | null; // JSON object
  metadata: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToService(row: ServiceRow): Service {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    port: row.port,
    description: row.description ?? undefined,
    url: row.url ?? undefined,
    healthCheckPath: row.healthCheckPath ?? "/health",
    status: row.status,
    // PM2 configuration
    script: row.script,
    cwd: row.cwd ?? undefined,
    interpreter: row.interpreter ?? undefined,
    args: row.args ? JSON.parse(row.args) : undefined,
    env: row.env ? JSON.parse(row.env) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export interface CreateServiceOptions {
  port?: number;
  description?: string;
  url?: string;
  healthCheckPath?: string;
  // PM2 configuration
  script: string; // Required
  cwd?: string;
  interpreter?: string;
  args?: string[];
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export async function createService(
  agentId: string,
  name: string,
  options: CreateServiceOptions,
): Promise<Service> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = (await getStorage().repos.agents.insertService({
    id,
    agentId,
    name,
    port: options.port ?? 3000,
    description: options.description ?? null,
    url: options.url ?? null,
    healthCheckPath: options.healthCheckPath ?? "/health",
    script: options.script,
    cwd: options.cwd ?? null,
    interpreter: options.interpreter ?? null,
    args: options.args ? JSON.stringify(options.args) : null,
    env: options.env ? JSON.stringify(options.env) : null,
    metadata: JSON.stringify(options.metadata ?? {}),
    now,
  })) as ServiceRow | null;

  if (!row) throw new Error("Failed to create service");

  try {
    await createLogEntry({
      eventType: "service_registered",
      agentId,
      newValue: name,
      metadata: { serviceId: id, port: options?.port ?? 3000 },
    });
  } catch {}

  return rowToService(row);
}

export async function getServiceById(id: string): Promise<Service | null> {
  const row = (await getStorage().repos.agents.findServiceById(id)) as ServiceRow | null;
  return row ? rowToService(row) : null;
}

export async function getServiceByAgentAndName(
  agentId: string,
  name: string,
): Promise<Service | null> {
  const row = (await getStorage().repos.agents.findServiceByAgentAndName(
    agentId,
    name,
  )) as ServiceRow | null;
  return row ? rowToService(row) : null;
}

export async function getServicesByAgentId(agentId: string): Promise<Service[]> {
  const rows = (await getStorage().repos.agents.listServicesByAgent(agentId)) as ServiceRow[];
  return rows.map(rowToService);
}

export interface ServiceFilters {
  agentId?: string;
  name?: string;
  status?: ServiceStatus;
}

export async function getAllServices(filters?: ServiceFilters): Promise<Service[]> {
  const rows = (await getStorage().repos.agents.listServices({
    agentId: filters?.agentId,
    nameLike: filters?.name,
    status: filters?.status,
  })) as ServiceRow[];
  return rows.map(rowToService);
}

export async function updateServiceStatus(
  id: string,
  status: ServiceStatus,
): Promise<Service | null> {
  const oldService = await getServiceById(id);
  if (!oldService) return null;

  const now = new Date().toISOString();
  const row = (await getStorage().repos.agents.setServiceStatus(
    id,
    status,
    now,
  )) as ServiceRow | null;

  if (row && oldService.status !== status) {
    try {
      await createLogEntry({
        eventType: "service_status_change",
        agentId: oldService.agentId,
        oldValue: oldService.status,
        newValue: status,
        metadata: { serviceId: id, serviceName: oldService.name },
      });
    } catch {}
  }

  return row ? rowToService(row) : null;
}

export async function deleteService(id: string): Promise<boolean> {
  const service = await getServiceById(id);
  if (service) {
    try {
      await createLogEntry({
        eventType: "service_unregistered",
        agentId: service.agentId,
        oldValue: service.name,
        metadata: { serviceId: id },
      });
    } catch {}
  }

  return (await getStorage().repos.agents.deleteService(id)) > 0;
}

/** Upsert a service - update if exists (by agentId + name), create if not */
export async function upsertService(
  agentId: string,
  name: string,
  options: CreateServiceOptions,
): Promise<Service> {
  const existing = await getServiceByAgentAndName(agentId, name);

  if (existing) {
    // Update existing service
    const now = new Date().toISOString();
    const row = (await getStorage().repos.agents.updateServiceDefinition(
      existing.id,
      {
        port: options.port ?? existing.port,
        description: options.description ?? existing.description ?? null,
        url: options.url ?? existing.url ?? null,
        healthCheckPath: options.healthCheckPath ?? existing.healthCheckPath ?? "/health",
        script: options.script,
        cwd: options.cwd ?? null,
        interpreter: options.interpreter ?? null,
        args: options.args ? JSON.stringify(options.args) : null,
        env: options.env ? JSON.stringify(options.env) : null,
        metadata: JSON.stringify(options.metadata ?? existing.metadata ?? {}),
      },
      now,
    )) as ServiceRow | null;

    if (!row) throw new Error("Failed to update service");
    return rowToService(row);
  }

  // Create new service
  return createService(agentId, name, options);
}

export async function deleteServicesByAgentId(agentId: string): Promise<number> {
  const services = await getServicesByAgentId(agentId);
  for (const service of services) {
    try {
      await createLogEntry({
        eventType: "service_unregistered",
        agentId,
        oldValue: service.name,
        metadata: { serviceId: service.id },
      });
    } catch {}
  }

  return await getStorage().repos.agents.deleteServicesByAgent(agentId);
}

// ============================================================================
// Session Log Operations (raw CLI output)
// ============================================================================

function rowToSessionLog(row: SessionLogRow): SessionLog {
  return {
    id: row.id,
    taskId: row.taskId ?? undefined,
    sessionId: row.sessionId,
    iteration: row.iteration,
    cli: row.cli,
    content: row.content,
    lineNumber: row.lineNumber,
    createdAt: row.createdAt,
  };
}

export async function createSessionLogs(logs: {
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  lines: string[];
}): Promise<void> {
  // Bounded batches, one short transaction each (reference shape:
  // src/be/boot-scrub-sweep.ts): worker log batches have unbounded line
  // counts, and a single transaction across thousands of scrub+INSERT
  // iterations would hold the global write lock — and the event loop — for
  // the whole sweep. The regex scrub runs outside the transaction so only
  // the inserts hold the lock.
  const BATCH_SIZE = 200;
  for (let start = 0; start < logs.lines.length; start += BATCH_SIZE) {
    // Yield to the event loop between batches.
    if (start > 0) await new Promise<void>((r) => setTimeout(r, 5));
    const batch: Array<{ content: string; reasoning: ReturnType<typeof extractReasoning> }> = [];
    const end = Math.min(start + BATCH_SIZE, logs.lines.length);
    for (let i = start; i < end; i++) {
      const line = logs.lines[i];
      if (line === undefined) continue;
      // Defense-in-depth: callers (runner.ts → POST /api/session-logs) send
      // content that is already scrubbed at the adapter emit site. We scrub
      // again here so any future write path that bypasses the adapter still
      // lands clean text in the persistent session_logs table.
      const content = scrubSecrets(line);
      // Parsed here, next to the scrub, so the write lock covers inserts only.
      batch.push({ content, reasoning: extractReasoning(logs.cli, content) });
    }
    await getStorage().transaction(async () => {
      // The worker flushes one (sessionId, iteration) in many POSTs, so the
      // lineNumber continues from the newest stored row instead of restarting
      // at the POST's index. Rows written here are monotonic in insert order,
      // so this equals MAX + 1 for them.
      const last = await getStorage().repos.sessions.lastLogLineNumber(
        logs.sessionId,
        logs.iteration,
      );
      let lineNumber = last !== null ? last + 1 : 0;
      // Consecutive Claude thinking lines of one message just before the current line.
      let run = 0;
      let runMessageId: string | undefined;
      for (const [index, { content, reasoning }] of batch.entries()) {
        await getStorage().repos.sessions.insertLog({
          id: crypto.randomUUID(),
          taskId: logs.taskId ?? null,
          sessionId: logs.sessionId,
          iteration: logs.iteration,
          cli: logs.cli,
          content,
          lineNumber,
          reasoningChars: reasoning.reasoning?.chars ?? null,
          reasoningKind: reasoning.reasoning ? "reasoning" : null,
        });
        const toolMessageId = reasoning.toolUseMessageId;
        if (toolMessageId) {
          const before = runMessageId === toolMessageId ? run : 0;
          // Only a run of 2+ can hold an update. A run that reaches the batch
          // start may continue in an earlier POST, so the DB decides that case.
          if (before >= 2 || before === index) {
            await classifyClaudeUpdate(logs.sessionId, toolMessageId, lineNumber);
          }
        }
        const messageId = reasoning.reasoning?.messageId;
        if (logs.cli === "claude" && messageId) {
          run = runMessageId === messageId ? run + 1 : 1;
          runMessageId = messageId;
        } else {
          run = 0;
          runMessageId = undefined;
        }
        lineNumber++;
      }
    });
  }
}

// Session log reads are in insert order (rowid on SQLite). Rows written before
// lineNumber was assigned server-side restart at 0 on every worker flush, so
// only the insert order orders them. The API never runs VACUUM
// (runbooks/db-retention.md); a manual VACUUM may renumber rowids but copies
// rows in rowid order.
export async function getSessionLogsByTaskId(
  taskId: string,
  limit?: number,
): Promise<SessionLog[]> {
  const rows = await getStorage().repos.sessions.listLogsByTask(taskId, limit);
  return rows.map(rowToSessionLog);
}

export async function getSessionLogsBySession(
  sessionId: string,
  iteration: number,
): Promise<SessionLog[]> {
  const rows = await getStorage().repos.sessions.listLogsBySession(sessionId, iteration);
  return rows.map(rowToSessionLog);
}

// ============================================================================
// Session Costs (aggregated cost data per session)
// ============================================================================

export async function createSessionCost(input: CreateSessionCostInput): Promise<SessionCost> {
  return (await insertSessionCost(input)).cost;
}

export async function getSessionCostsByTaskId(taskId: string, limit = 500): Promise<SessionCost[]> {
  const rows = await getStorage().repos.sessions.listSessionCostsByTask(taskId, limit);
  return rows.map(rowToSessionCost);
}

export async function getSessionCostsByAgentId(
  agentId: string,
  limit = 100,
): Promise<SessionCost[]> {
  const rows = await getStorage().repos.sessions.listSessionCostsByAgent(agentId, limit);
  return rows.map(rowToSessionCost);
}

export async function getAllSessionCosts(limit = 100): Promise<SessionCost[]> {
  const rows = await getStorage().repos.sessions.listSessionCosts({ limit });
  return rows.map(rowToSessionCost);
}

// --- Date-filtered session costs (P1) ---

export async function getSessionCostsFiltered(opts: {
  agentId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<SessionCost[]> {
  const rows = await getStorage().repos.sessions.listSessionCosts({
    agentId: opts.agentId,
    startDate: opts.startDate,
    endDate: opts.endDate,
    limit: opts.limit ?? 100,
  });
  return rows.map(rowToSessionCost);
}

// --- Aggregation queries (P0) ---

export interface SessionCostSummaryTotals {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalDurationMs: number;
  totalSessions: number;
  avgCostPerSession: number;
  /**
   * Cost of tasks with a human requester, over `attributableCostUsd` (not
   * `totalCostUsd`) — see `attributableCostUsd` for why. Also excludes cost on
   * a structurally-human-free task that happens to carry a stale/inherited
   * `requestedByUserId` (measured 2026-08-19: ~5% of the naive-attributed
   * population), so the two totals stay a consistent partition.
   */
  attributedCostUsd: number;
  /**
   * The corrected coverage denominator: `totalCostUsd` minus the cost of
   * structurally-human-free tasks (heartbeat/boot-triage, scheduled runs, and
   * `source='system'` follow-ups whose parent itself had no human requester —
   * i.e. follow-ups of the swarm's own self-maintenance, not of human work).
   * These tasks have no human requester *by construction*; stamping one on
   * them would be a lie, not coverage, so they don't belong in the
   * denominator at all. `attributedCostUsd / attributableCostUsd` is the
   * number to show as "coverage" — dividing by `totalCostUsd` instead
   * silently deflates it with a population that could never have scored.
   */
  attributableCostUsd: number;
  /** Cost of the structurally-human-free population excluded from `attributableCostUsd`. */
  excludedCostUsd: number;
  /** Distinct tasks behind `excludedCostUsd` — surfaced so the UI can name the exclusion count, not just wave at a percentage. */
  excludedTaskCount: number;
  /** API-priced cost of sessions whose task ran on a subscription credential (`SUBSCRIPTION_KEY_TYPES`). */
  subscriptionCostUsd: number;
  /** Cost without an immutable credential identity. Its billing type is unknown. */
  credentialUnattributedCostUsd: number;
  credentialUnattributedSessions: number;
}

export interface SessionCostDailyRow {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  /** Part of `costUsd` that ran on a subscription credential. */
  subscriptionCostUsd: number;
  /** Cost without an immutable credential identity. Its billing type is unknown. */
  credentialUnattributedCostUsd: number;
  credentialUnattributedSessions: number;
}

/**
 * How a credential's plan is known, strongest first: picked on the dashboard,
 * reported by a worker (Codex JWT), or estimated from rate-limit utilization.
 */
export type PlanSource = "manual" | "detected" | "estimated";

/** Spend per credential, for the subscription vs API comparison. */
export interface SessionCostByCredentialRow {
  /** Null when the executing session reported no credential. */
  keyType: string | null;
  keySuffix: string | null;
  /** Label set on the API Keys page. */
  name: string | null;
  /** Billed as a flat subscription (`SUBSCRIPTION_KEY_TYPES`) rather than per token. */
  subscription: boolean;
  /** Plan id from `SUBSCRIPTION_PLANS`, or null when unknown. */
  plan: string | null;
  planSource: PlanSource | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  firstSessionAt: string;
  lastSessionAt: string;
}

export interface SessionCostByAgentRow {
  agentId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  durationMs: number;
}

export interface SessionCostByUserRow {
  /** `null` = no human requester (heartbeat, boot triage, other autonomous work). */
  userId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  tasks: number;
  durationMs: number;
}

/** `opts.userId` sentinel selecting spend with no human requester. */
export const UNATTRIBUTED_USER_ID = "unattributed";

export async function getSessionCostSummary(opts: {
  startDate?: string;
  endDate?: string;
  agentId?: string;
  /** A user id, or `UNATTRIBUTED_USER_ID` for spend with no human requester. */
  userId?: string;
  groupBy?: "day" | "agent" | "both" | "user";
}): Promise<{
  totals: SessionCostSummaryTotals;
  daily: SessionCostDailyRow[];
  byAgent: SessionCostByAgentRow[];
  byUser: SessionCostByUserRow[];
  byCredential: SessionCostByCredentialRow[];
}> {
  // `session_costs` deliberately carries no `userId` column — a task can be
  // re-attributed after the fact, so the human requester is resolved by joining
  // through the task (same shape as `getDailySpendForUser`).
  const filter: SessionCostSummaryFilter = {
    startDate: opts.startDate,
    endDate: opts.endDate,
    agentId: opts.agentId,
    user:
      opts.userId === UNATTRIBUTED_USER_ID
        ? { kind: "unattributed" }
        : opts.userId
          ? { kind: "user", userId: opts.userId }
          : undefined,
    subscriptionKeyTypes: SUBSCRIPTION_KEY_TYPES,
  };
  const totalsRow = await getStorage().repos.sessions.costSummaryTotals(filter);

  const totals: SessionCostSummaryTotals = totalsRow
    ? {
        ...totalsRow,
        avgCostPerSession:
          totalsRow.totalSessions > 0 ? totalsRow.totalCostUsd / totalsRow.totalSessions : 0,
      }
    : {
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalDurationMs: 0,
        totalSessions: 0,
        avgCostPerSession: 0,
        attributedCostUsd: 0,
        attributableCostUsd: 0,
        excludedCostUsd: 0,
        excludedTaskCount: 0,
        subscriptionCostUsd: 0,
        credentialUnattributedCostUsd: 0,
        credentialUnattributedSessions: 0,
      };

  // Daily breakdown
  const groupBy = opts.groupBy ?? "both";
  let daily: SessionCostDailyRow[] = [];
  if (groupBy === "day" || groupBy === "both") {
    daily = await getStorage().repos.sessions.costSummaryDaily(filter);
  }

  // Per-agent breakdown
  let byAgent: SessionCostByAgentRow[] = [];
  if (groupBy === "agent" || groupBy === "both") {
    byAgent = await getStorage().repos.sessions.costSummaryByAgent(filter);
  }

  // Per-requester breakdown. Structurally-human-free work is assigned to the
  // autonomous bucket even if a stale requester id survives on the task.
  let byUser: SessionCostByUserRow[] = [];
  if (groupBy === "user" || groupBy === "both") {
    byUser = await getStorage().repos.sessions.costSummaryByUser(filter);
  }

  let byCredential: SessionCostByCredentialRow[] = [];
  if (groupBy === "both") {
    const rows = await getStorage().repos.sessions.costSummaryByCredential(filter);
    const labels = await getCredentialLabels();
    byCredential = rows.map((row) => {
      const label =
        row.keyType && row.keySuffix
          ? labels.get(credentialKey(row.keyType, row.keySuffix))
          : undefined;
      return {
        ...row,
        name: label?.name ?? null,
        subscription: row.keyType !== null && SUBSCRIPTION_KEY_TYPES.includes(row.keyType),
        plan: label?.plan ?? null,
        planSource: label?.planSource ?? null,
      };
    });
  }

  return { totals, daily, byAgent, byUser, byCredential };
}

function credentialKey(keyType: string, keySuffix: string): string {
  return `${keyType}:${keySuffix}`;
}

/**
 * Name and plan per credential (keyType + keySuffix), merged over its scope
 * rows. A manual plan wins over a detected one.
 */
async function getCredentialLabels(): Promise<
  Map<string, { name: string | null; plan: string | null; planSource: PlanSource | null }>
> {
  const rows = (await getStorage().repos.config.listKeyLabels()) as {
    keyType: string;
    keySuffix: string;
    name: string | null;
    plan: string | null;
    planSource: PlanSource | null;
  }[];
  const labels = new Map<
    string,
    { name: string | null; plan: string | null; planSource: PlanSource | null }
  >();
  for (const row of rows) {
    const key = credentialKey(row.keyType, row.keySuffix);
    const seen = labels.get(key);
    if (!seen) {
      labels.set(key, {
        name: row.name,
        plan: row.planSource === "estimated" ? null : row.plan,
        planSource: row.planSource,
      });
    } else if (!seen.name && row.name) {
      seen.name = row.name;
    }
  }
  return labels;
}

// --- Per-person attribution (four-metric view) ---

export interface AttributionByPersonRow {
  userId: string;
  /** Root tasks (`parentTaskId IS NULL`) only — counting fan-out children would let
   *  whoever triggers the biggest decomposition win by accident. */
  problemsInitiated: number;
  /** Roots that completed AND show shippable evidence — see `getAttributionByPerson` doc. */
  problemsShipped: number;
  /** Distinct agents engaged across the person's entire task tree (not root-scoped —
   *  a root that fans out to nine agents is nine agents of reach). */
  agentsReached: number;
  reposReached: number;
  surfacesReached: number;
  /**
   * Share of root tasks completed without a re-dispatch or a human correction.
   * Deliberately `null`: distinguishing a legitimate multi-agent fan-out from a
   * correction-driven re-dispatch isn't computable from a single query pass
   * (would need to inspect *why* a child task was created, which isn't a stored
   * fact), and a task-count-based proxy would misclassify normal delegation as
   * rework. Render as "not yet computed" — do not invent a stand-in.
   */
  firstPassYield: null;
}

/**
 * Four metrics per human requester, reported side by side — never summed into
 * a composite score. Scope is root tasks (`problemsInitiated`/`problemsShipped`)
 * or the person's entire task tree (`*Reached`); `requestedByUserId IS NULL`
 * (autonomous work) and structurally-human-free rows with a stale/inherited
 * requester (`agent_tasks.isHumanFree`, see `src/be/db/tasks/human-free.ts`) are excluded —
 * neither belongs to a person.
 *
 * "Problems shipped" detection walks each root's full task tree, preferring a
 * `task_attachments` row (`kind='url'` matching a GitHub PR or GitLab MR URL,
 * or `kind='page'` for a published artifact) and falling back to the same
 * provider-specific URL match on any task output. GitLab matching is host
 * agnostic so self-hosted instances are covered. This does NOT detect a closed ticket (no
 * Linear/Jira issue-state table exists locally) — "shipped" undercounts
 * ticket-only outcomes until the real artifacts join lands.
 */
export async function getAttributionByPerson(opts: {
  startDate?: string;
  endDate?: string;
}): Promise<AttributionByPersonRow[]> {
  const window: AttributionWindow = {};
  if (opts.startDate) window.startDate = opts.startDate;
  if (opts.endDate) {
    // A date-only value represents the whole UTC day. Preserve inclusive
    // timestamp semantics for callers that provide an exact instant.
    const dateOnlyEnd = /^\d{4}-\d{2}-\d{2}$/.test(opts.endDate)
      ? new Date(`${opts.endDate}T00:00:00.000Z`)
      : null;
    if (
      dateOnlyEnd &&
      !Number.isNaN(dateOnlyEnd.getTime()) &&
      dateOnlyEnd.toISOString().slice(0, 10) === opts.endDate
    ) {
      dateOnlyEnd.setUTCDate(dateOnlyEnd.getUTCDate() + 1);
      window.endBefore = dateOnlyEnd.toISOString();
    } else {
      window.endAtOrBefore = opts.endDate;
    }
  }
  const githubHost = getGitHubHostForSql();

  const rootRows = await getStorage().repos.tasks.listAttributionRoots(window, githubHost);
  const reachRows = await getStorage().repos.tasks.listAttributionReach(window);

  const byUser = new Map<string, AttributionByPersonRow>();
  for (const r of rootRows) {
    byUser.set(r.userId, {
      userId: r.userId,
      problemsInitiated: r.initiated,
      problemsShipped: r.shipped,
      agentsReached: 0,
      reposReached: 0,
      surfacesReached: 0,
      firstPassYield: null,
    });
  }
  for (const r of reachRows) {
    const existing = byUser.get(r.userId);
    if (existing) {
      existing.agentsReached = r.agentsReached;
      existing.reposReached = r.reposReached;
      existing.surfacesReached = r.surfacesReached;
    } else {
      // Reach with no root task in-window (e.g. only fan-out children whose
      // root predates the window) — still a real person row.
      byUser.set(r.userId, {
        userId: r.userId,
        problemsInitiated: 0,
        problemsShipped: 0,
        agentsReached: r.agentsReached,
        reposReached: r.reposReached,
        surfacesReached: r.surfacesReached,
        firstPassYield: null,
      });
    }
  }

  return Array.from(byUser.values());
}

// --- Dashboard cost summary (P4) ---

export interface DashboardCostSummary {
  costToday: number;
  costMtd: number;
}

export async function getDashboardCostSummary(): Promise<DashboardCostSummary> {
  // Phase 13: compute the date boundaries in TS and pass them as ISO 8601
  // strings. `session_costs.createdAt` is a TEXT ISO 8601 column; lexicographic
  // comparison on ISO 8601 sorts correctly, so the comparison works as long
  // as both sides are the same shape. The old code compared an ISO string
  // (`2026-05-15T03:45:12.123Z`) against `date('now')` (which returns the
  // string `2026-05-15`) — lexicographically `2026-05-15T...` > `2026-05-15`,
  // so post-midnight rows correctly counted, BUT rows whose ISO began with
  // the EXACT bare-date string would fail the `>=` check inconsistently
  // depending on millisecond precision. Use a proper ISO-millisecond boundary
  // for both halves so the comparison is unambiguous.
  const now = new Date();
  const startOfDayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const startOfMonthUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const row = await getStorage().repos.sessions.dashboardCost(startOfDayUtc, startOfMonthUtc);

  return row ?? { costToday: 0, costMtd: 0 };
}

// ============================================================================
// Inbox Message Operations
// ============================================================================

type InboxMessageRow = {
  id: string;
  agentId: string;
  content: string;
  source: string;
  status: InboxMessageStatus;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  matchedText: string | null;
  delegatedToTaskId: string | null;
  responseText: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToInboxMessage(row: InboxMessageRow): InboxMessage {
  return {
    id: row.id,
    agentId: row.agentId,
    content: row.content,
    source: row.source as "slack",
    status: row.status,
    slackChannelId: row.slackChannelId ?? undefined,
    slackThreadTs: row.slackThreadTs ?? undefined,
    slackUserId: row.slackUserId ?? undefined,
    matchedText: row.matchedText ?? undefined,
    delegatedToTaskId: row.delegatedToTaskId ?? undefined,
    responseText: row.responseText ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export interface CreateInboxMessageOptions {
  source?: "slack" | "agentmail";
  slackChannelId?: string;
  slackThreadTs?: string;
  slackUserId?: string;
  matchedText?: string;
}

export async function createInboxMessage(
  agentId: string,
  content: string,
  options?: CreateInboxMessageOptions,
): Promise<InboxMessage> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = (await getStorage().repos.messaging.insertInboxMessage({
    id,
    agentId,
    content: scrubSecrets(content),
    source: options?.source ?? "slack",
    status: "unread",
    slackChannelId: options?.slackChannelId ?? null,
    slackThreadTs: options?.slackThreadTs ?? null,
    slackUserId: options?.slackUserId ?? null,
    matchedText: options?.matchedText == null ? null : scrubSecrets(options.matchedText),
    delegatedToTaskId: null,
    responseText: null,
    createdAt: now,
    lastUpdatedAt: now,
  })) as InboxMessageRow | null;

  if (!row) throw new Error("Failed to create inbox message");
  return rowToInboxMessage(row);
}

export async function getInboxMessageById(id: string): Promise<InboxMessage | null> {
  const row = (await getStorage().repos.messaging.findInboxMessage(id)) as InboxMessageRow | null;
  return row ? rowToInboxMessage(row) : null;
}

export async function getUnreadInboxMessages(agentId: string): Promise<InboxMessage[]> {
  const rows = (await getStorage().repos.messaging.listUnreadInboxMessages(
    agentId,
  )) as InboxMessageRow[];
  return rows.map(rowToInboxMessage);
}

/**
 * Atomically claim up to N unread inbox messages for processing.
 * Marks them as 'processing' to prevent duplicate polling.
 * Returns empty array if no unread messages available.
 */
export async function claimInboxMessages(
  agentId: string,
  limit: number = 5,
): Promise<InboxMessage[]> {
  const now = new Date().toISOString();
  const messaging = getStorage().repos.messaging;

  // Get IDs of unread messages to claim
  const unreadRows = await messaging.listUnreadInboxMessages(agentId, limit);
  const unreadIds = unreadRows.map((row) => row.id);

  if (unreadIds.length === 0) {
    return [];
  }

  // Atomically update status to 'processing' for these specific IDs
  const rows = (await messaging.markInboxMessagesProcessing(unreadIds, now)) as InboxMessageRow[];

  return rows.map(rowToInboxMessage);
}

export async function markInboxMessageRead(id: string): Promise<InboxMessage | null> {
  const now = new Date().toISOString();
  const row = (await getStorage().repos.messaging.markInboxMessageRead(
    id,
    now,
  )) as InboxMessageRow | null;
  return row ? rowToInboxMessage(row) : null;
}

export async function markInboxMessageResponded(
  id: string,
  responseText: string,
): Promise<InboxMessage | null> {
  const now = new Date().toISOString();
  const row = (await getStorage().repos.messaging.markInboxMessageResponded(
    id,
    scrubSecrets(responseText),
    now,
  )) as InboxMessageRow | null;
  return row ? rowToInboxMessage(row) : null;
}

export async function markInboxMessageDelegated(
  id: string,
  taskId: string,
): Promise<InboxMessage | null> {
  const now = new Date().toISOString();
  const row = (await getStorage().repos.messaging.markInboxMessageDelegated(
    id,
    taskId,
    now,
  )) as InboxMessageRow | null;
  return row ? rowToInboxMessage(row) : null;
}

/**
 * Release inbox messages that have been in 'processing' status for too long.
 * This handles cases where Claude process crashes or fails to respond/delegate.
 * Call this periodically from the runner or add a database trigger.
 */
export async function releaseStaleProcessingInbox(timeoutMinutes: number = 30): Promise<number> {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  return await getStorage().repos.messaging.releaseInboxProcessingBefore(cutoffTime, now);
}

// ============================================================================
// Concurrent Context (for lead session awareness)
// ============================================================================

export interface ConcurrentContext {
  processingInboxMessages: Array<{
    id: string;
    content: string;
    source: string;
    slackChannelId: string | null;
    slackThreadTs: string | null;
    createdAt: string;
  }>;
  recentTaskDelegations: Array<{
    id: string;
    task: string;
    agentId: string | null;
    agentName: string | null;
    creatorAgentId: string | null;
    status: string;
    createdAt: string;
  }>;
  activeSwarmTasks: Array<{
    id: string;
    task: string;
    agentId: string | null;
    agentName: string | null;
    status: string;
    createdAt: string;
    progress: string | null;
  }>;
}

/**
 * Get concurrent context for lead session awareness.
 * Returns processing inbox messages, recent task delegations by leads,
 * and currently active (in-progress) tasks across the swarm.
 */
export async function getConcurrentContext(readableBy?: {
  userId: string | null;
}): Promise<ConcurrentContext> {
  // 1. Inbox messages currently being processed (status = 'processing')
  const processingInboxMessages = await getStorage().repos.messaging.listProcessingInboxMessages();

  // 2. Tasks created in the last 5 minutes by lead agents
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const recentTaskDelegations = (await getStorage().repos.tasks.listRecentLeadDelegations(
    fiveMinutesAgo,
    readableBy,
  )) as ConcurrentContext["recentTaskDelegations"];

  // 3. Currently in-progress tasks across the swarm
  const activeSwarmTasks = (await getStorage().repos.tasks.listActiveSwarmTasks(
    readableBy,
  )) as ConcurrentContext["activeSwarmTasks"];

  return {
    processingInboxMessages,
    recentTaskDelegations,
    activeSwarmTasks,
  };
}

// ============================================================================
// Scheduled Task Queries
// ============================================================================

// ── List-endpoint slimming helpers ──────────────────────────────────────────
// List endpoints ship slim rows by default; heavy text fields are replaced
// with bounded previews. Lengths are generous enough for triage/recognition
// while keeping list payloads small.
/** Preview length for a schedule's `taskTemplate`. */
const SCHEDULE_TEMPLATE_PREVIEW_LENGTH = 280;
/** Truncate text for a list-row preview. Appends an ellipsis when clipped. */
function previewText(text: string | null | undefined, maxChars: number): string {
  const s = text ?? "";
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

function rowToScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    cronExpression: row.cronExpression ?? undefined,
    intervalMs: row.intervalMs ?? undefined,
    taskTemplate: row.taskTemplate ?? undefined,
    taskType: row.taskType ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    priority: row.priority,
    targetAgentId: row.targetAgentId ?? undefined,
    enabled: row.enabled === 1,
    lastRunAt: normalizeDate(row.lastRunAt) ?? undefined,
    nextRunAt: normalizeDate(row.nextRunAt) ?? undefined,
    createdByAgentId: row.createdByAgentId ?? undefined,
    updatedByAgentId: row.updatedByAgentId ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    requestedDelayMs: row.requestedDelayMs ?? undefined,
    requestedRunAt: normalizeDate(row.requestedRunAt) ?? undefined,
    timezone: row.timezone,
    consecutiveErrors: row.consecutiveErrors ?? 0,
    lastErrorAt: normalizeDate(row.lastErrorAt) ?? undefined,
    lastErrorMessage: row.lastErrorMessage ?? undefined,
    model: row.model ?? undefined,
    modelTier: parseModelTier(row.modelTier) ?? undefined,
    profile: row.profile ?? undefined,
    modelGroup: row.modelGroup ?? undefined,
    scheduleType: row.scheduleType as "recurring" | "one_time",
    targetType: row.targetType as "agent-task" | "workflow" | "script",
    workflowId: row.workflowId ?? undefined,
    scriptName: row.scriptName ?? undefined,
    scriptArgs: row.scriptArgs ? JSON.parse(row.scriptArgs) : undefined,
    params: JSON.parse(row.params) as Record<string, unknown>,
    requiredParams: JSON.parse(row.requiredParams) as string[],
    requires: JSON.parse(row.requires) as AutomationIntegrationId[],
    createdAt: normalizeDateRequired(row.createdAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

export interface ScheduledTaskFilters {
  enabled?: boolean;
  name?: string;
  scheduleType?: "recurring" | "one_time";
  hideCompleted?: boolean;
  targetType?: "agent-task" | "workflow" | "script";
  workflowId?: string;
  scriptName?: string;
  consecutiveErrorsMin?: number;
  lastRunStatus?: "failed" | "succeeded";
  key?: string;
  keyPrefix?: string;
  /** At most this many rows, in list order. */
  limit?: number;
}

/**
 * Slim list-row mapper — replaces the full `taskTemplate` (the per-run prompt,
 * avg ~3.6 KB) with a bounded `taskTemplatePreview`. Fetch the full template
 * via `getScheduledTaskById(id)`.
 */
function rowToScheduledTaskSummary(row: ScheduledTaskRow): ScheduledTaskSummary {
  const { taskTemplate, ...rest } = rowToScheduledTask(row);
  return {
    ...rest,
    taskTemplatePreview: previewText(taskTemplate, SCHEDULE_TEMPLATE_PREVIEW_LENGTH),
  };
}

export function getScheduledTasks(filters?: ScheduledTaskFilters): Promise<ScheduledTask[]>;
export function getScheduledTasks(
  filters: ScheduledTaskFilters | undefined,
  opts: { slim: true },
): Promise<ScheduledTaskSummary[]>;
export async function getScheduledTasks(
  filters?: ScheduledTaskFilters,
  opts?: { slim?: boolean },
): Promise<ScheduledTask[] | ScheduledTaskSummary[]> {
  const rows = await getStorage().repos.schedules.listScheduledTasks({
    enabled: filters?.enabled,
    name: filters?.name,
    scheduleType: filters?.scheduleType,
    targetType: filters?.targetType,
    workflowId: filters?.workflowId,
    scriptName: filters?.scriptName,
    key: filters?.key ? normalizeAssetKey(filters.key) : undefined,
    keyPattern: filters?.keyPrefix ? assetKeyPrefixPattern(filters.keyPrefix) : undefined,
    consecutiveErrorsMin: filters?.consecutiveErrorsMin,
    lastRunStatus: filters?.lastRunStatus,
    hideCompleted: filters?.hideCompleted !== false,
    limit: filters?.limit,
  });
  return opts?.slim ? rows.map(rowToScheduledTaskSummary) : rows.map(rowToScheduledTask);
}

export async function getScheduledTaskById(id: string): Promise<ScheduledTask | null> {
  const row = await getStorage().repos.schedules.findScheduledTaskById(id);
  return row ? rowToScheduledTask(row) : null;
}

export async function getScheduledTaskByName(name: string): Promise<ScheduledTask | null> {
  const row = await getStorage().repos.schedules.findScheduledTaskByName(name);
  return row ? rowToScheduledTask(row) : null;
}

export interface CreateScheduledTaskData {
  key?: string;
  name: string;
  description?: string;
  cronExpression?: string;
  intervalMs?: number;
  taskTemplate?: string;
  taskType?: string;
  tags?: string[];
  priority?: number;
  targetAgentId?: string;
  enabled?: boolean;
  nextRunAt?: string;
  createdByAgentId?: string;
  /** Only `defer-task` sets this — the task the schedule's run continues. */
  parentTaskId?: string;
  /**
   * Only `defer-task` sets these — the delay the caller actually asked for,
   * kept because the scheduler clears `nextRunAt` once a one_time schedule
   * fires. Write-once provenance; nothing reads them to decide when to run.
   */
  requestedDelayMs?: number;
  requestedRunAt?: string;
  timezone?: string;
  model?: string;
  modelTier?: ModelTier;
  profile?: string;
  modelGroup?: string;
  scheduleType?: "recurring" | "one_time";
  targetType?: "agent-task" | "workflow" | "script";
  workflowId?: string;
  scriptName?: string;
  scriptArgs?: Record<string, unknown>;
  params?: Record<string, unknown>;
  requiredParams?: string[];
  requires?: AutomationIntegrationId[];
  createdBy?: string;
}

export async function createScheduledTask(data: CreateScheduledTaskData): Promise<ScheduledTask> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getStorage().repos.schedules.insertScheduledTask({
    id,
    key: normalizeAssetKey(data.key ?? defaultAssetKey("schedule", id)),
    name: data.name,
    description: data.description == null ? null : scrubSecrets(data.description),
    cronExpression: data.cronExpression ?? null,
    intervalMs: data.intervalMs ?? null,
    taskTemplate: data.taskTemplate == null ? null : scrubSecrets(data.taskTemplate),
    taskType: data.taskType ?? null,
    tags: JSON.stringify(data.tags ?? []),
    priority: data.priority ?? 50,
    targetAgentId: data.targetAgentId ?? null,
    enabled: data.enabled !== false,
    nextRunAt: data.nextRunAt ?? null,
    createdByAgentId: data.createdByAgentId ?? null,
    parentTaskId: data.parentTaskId ?? null,
    requestedDelayMs: data.requestedDelayMs ?? null,
    requestedRunAt: data.requestedRunAt ?? null,
    timezone: data.timezone ?? "UTC",
    model: data.model ?? null,
    modelTier: data.modelTier ?? null,
    profile: data.profile ?? null,
    modelGroup: data.modelGroup ?? null,
    scheduleType: data.scheduleType ?? "recurring",
    targetType: data.targetType ?? "agent-task",
    workflowId: data.workflowId ?? null,
    scriptName: data.scriptName ?? null,
    scriptArgs: data.scriptArgs !== undefined ? JSON.stringify(data.scriptArgs) : "{}",
    params: JSON.stringify(data.params ?? {}),
    requiredParams: JSON.stringify(data.requiredParams ?? []),
    requires: JSON.stringify(data.requires ?? []),
    createdAt: now,
    lastUpdatedAt: now,
    created_by: data.createdBy ?? null,
    updated_by: data.createdBy ?? null,
    updatedByAgentId: data.createdByAgentId ?? null,
  });

  if (!row) throw new Error("Failed to create scheduled task");
  return rowToScheduledTask(row);
}

export interface UpdateScheduledTaskData {
  key?: string;
  name?: string;
  description?: string;
  cronExpression?: string | null;
  intervalMs?: number | null;
  taskTemplate?: string | null;
  taskType?: string;
  tags?: string[];
  priority?: number;
  targetAgentId?: string | null;
  enabled?: boolean;
  lastRunAt?: string;
  nextRunAt?: string | null;
  timezone?: string;
  consecutiveErrors?: number;
  lastErrorAt?: string | null;
  lastErrorMessage?: string | null;
  model?: string | null;
  modelTier?: ModelTier | null;
  profile?: string | null;
  modelGroup?: string | null;
  scheduleType?: "recurring" | "one_time";
  targetType?: "agent-task" | "workflow" | "script";
  workflowId?: string | null;
  scriptName?: string | null;
  scriptArgs?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
  requiredParams?: string[];
  requires?: AutomationIntegrationId[];
  lastUpdatedAt?: string;
  /**
   * Audit pair for a user-intent write: pass both (null = unknown) so they
   * describe the same write. Omitted (scheduler and system writes) leaves them untouched.
   */
  updatedBy?: string | null;
  updatedByAgentId?: string | null;
}

export async function updateScheduledTask(
  id: string,
  data: UpdateScheduledTaskData,
): Promise<ScheduledTask | null> {
  const opt = <T, R>(value: T | undefined, map: (v: T) => R): R | undefined =>
    value === undefined ? undefined : map(value);
  const scrub = (value: string | null) => (value == null ? null : scrubSecrets(value));
  const update: ScheduledTaskColumnUpdate = {
    key: opt(data.key, normalizeAssetKey),
    name: data.name,
    description: opt(data.description, scrub),
    cronExpression: data.cronExpression,
    intervalMs: data.intervalMs,
    taskTemplate: opt(data.taskTemplate, scrub),
    taskType: data.taskType,
    tags: opt(data.tags, (tags) => JSON.stringify(tags)),
    priority: data.priority,
    targetAgentId: data.targetAgentId,
    enabled: data.enabled,
    lastRunAt: data.lastRunAt,
    nextRunAt: data.nextRunAt,
    timezone: data.timezone,
    consecutiveErrors: data.consecutiveErrors,
    lastErrorAt: data.lastErrorAt,
    lastErrorMessage: opt(data.lastErrorMessage, scrub),
    model: data.model,
    modelTier: data.modelTier,
    profile: data.profile,
    modelGroup: data.modelGroup,
    scheduleType: data.scheduleType,
    targetType: data.targetType,
    workflowId: data.workflowId,
    scriptName: data.scriptName,
    scriptArgs: opt(data.scriptArgs, (args) => (args === null ? null : JSON.stringify(args))),
    params: opt(data.params, (p) => JSON.stringify(p)),
    requiredParams: opt(data.requiredParams, (p) => JSON.stringify(p)),
    requires: opt(data.requires, (r) => JSON.stringify(r)),
    updated_by: data.updatedBy,
    updatedByAgentId: data.updatedByAgentId,
  };

  if (Object.values(update).every((value) => value === undefined)) {
    return getScheduledTaskById(id);
  }

  const row = await getStorage().repos.schedules.updateScheduledTask(
    id,
    update,
    data.lastUpdatedAt ?? new Date().toISOString(),
  );

  return row ? rowToScheduledTask(row) : null;
}

export async function deleteScheduledTask(id: string): Promise<boolean> {
  const storage = getStorage();
  return await storage.transaction(async () => {
    // An unfired deferral is the only continuation of a suppressed completion.
    // Read under the delete's write lock so a concurrent wake cannot be missed.
    const deferredParentId = await storage.repos.schedules.findUnfiredDeferralParent(id);
    // Favorites carry no FK to the entity; drop every user's star with it.
    await storage.repos.users.deleteFavoritesOfItem("schedule", id);
    const deleted = await storage.repos.schedules.deleteScheduledTask(id);
    if (deleted > 0 && deferredParentId) {
      storage.afterCommit(async () => {
        try {
          const parent = await getTaskById(deferredParentId);
          if (!parent?.deferredAt) return;
          const { createWorkerTaskFollowUp } = await import("../tasks/worker-follow-up");
          await createWorkerTaskFollowUp({
            task: parent,
            status: "failed",
            failureReason: "Deferred continuation schedule deleted before its wake-up",
          });
        } catch (error) {
          console.error(
            "[deleteScheduledTask] deferred deletion follow-up failed:",
            scrubSecrets(error instanceof Error ? error.message : String(error)),
          );
        }
      });
    }
    return deleted > 0;
  });
}

/**
 * Get all enabled scheduled tasks that are due for execution.
 * A task is due when its nextRunAt time is <= now.
 */
export async function getDueScheduledTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const rows = await getStorage().repos.schedules.listDueScheduledTasks(now);
  return rows.map(rowToScheduledTask);
}

// ============================================================================
// Swarm Config Operations (Centralized Environment/Config Management)
// ============================================================================

const RESERVED_CONFIG_PLACEHOLDER = "[reserved key stored in swarm_config; delete this row]";

function rowToSwarmConfig(row: SwarmConfigRow): SwarmConfig {
  const isEncrypted = row.encrypted === 1;
  if (isReservedConfigKey(row.key)) {
    return {
      id: row.id,
      scope: row.scope as "global" | "agent" | "repo",
      scopeId: row.scopeId ?? null,
      key: row.key,
      value: RESERVED_CONFIG_PLACEHOLDER,
      isSecret: row.isSecret === 1,
      envPath: row.envPath ?? null,
      description: row.description ?? null,
      createdAt: row.createdAt,
      lastUpdatedAt: row.lastUpdatedAt,
      encrypted: isEncrypted,
      exportToEnv: effectiveExportToEnv(row.key, row.exportToEnv !== 0),
    };
  }

  let value = row.value;
  if (isEncrypted) {
    try {
      value = decryptSecret(row.value, getEncryptionKey());
    } catch (err) {
      throw new Error(
        `Failed to decrypt config '${row.key}' (id=${row.id}): check SECRETS_ENCRYPTION_KEY matches the key used at encryption time`,
        { cause: err },
      );
    }
  }
  return {
    id: row.id,
    scope: row.scope as "global" | "agent" | "repo",
    scopeId: row.scopeId ?? null,
    key: row.key,
    value,
    isSecret: row.isSecret === 1,
    envPath: row.envPath ?? null,
    description: row.description ?? null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    encrypted: isEncrypted,
    exportToEnv: effectiveExportToEnv(row.key, row.exportToEnv !== 0),
  };
}

/**
 * Scan swarm_config for any rows flagged `isSecret = 1` whose `encrypted`
 * column is still 0 (plaintext), encrypt them in a single transaction, and
 * flip the flag. Called exactly once during `initDb` on the main path — never
 * on the test template fast-path.
 *
 * Exported for tests so they can simulate a pre-existing legacy row without
 * needing to replay a full boot.
 */
export function autoEncryptLegacyPlaintextSecrets(
  database: Database,
  dbPath: string,
  options: { createBackup?: boolean } = {},
): void {
  const rows = listPlaintextSecretConfigs(database);
  if (rows.length === 0) return;

  const key = getEncryptionKey();

  // Create plaintext backup if key was auto-generated (not user-provided)
  if (options.createBackup) {
    const { writeFileSync } = require("node:fs");
    const backupPath = `${dbPath}.backup.secrets-${new Date().toISOString().split("T")[0]}.env`;
    const backupLines = [
      "# PLAINTEXT SECRET BACKUP - CREATED DURING AUTO-ENCRYPTION MIGRATION",
      "# This file was created because you did not provide SECRETS_ENCRYPTION_KEY",
      "# DELETE THIS FILE after verifying your encryption key is safely backed up",
      "#",
      "# Encryption key location:",
      "#   - Check: <data-dir>/.encryption-key",
      "#   - Or set: SECRETS_ENCRYPTION_KEY=<base64-key>",
      "",
      ...rows.map((r) => `${r.key}=${r.value}`),
      "",
    ].join("\n");

    try {
      writeFileSync(backupPath, backupLines, { mode: 0o600 });
      console.warn(`[secrets] Created plaintext backup: ${backupPath}`);
      console.warn(`[secrets] DELETE THIS FILE after verifying your encryption key is backed up!`);
    } catch (err) {
      console.error(`[secrets] Failed to create backup file: ${(err as Error).message}`);
      // Continue with encryption even if backup fails - the secrets are still in DB
    }
  }

  console.log(`[secrets] Encrypting ${rows.length} legacy plaintext secret(s)...`);

  storeEncryptedSecretConfigs(
    database,
    rows.map((r) => ({ id: r.id, value: encryptSecret(r.value, key) })),
  );
  console.log(`[secrets] Auto-migrated ${rows.length} secret(s) to encrypted storage.`);
}

/**
 * Mask secret values in config entries for API responses.
 */
export function maskSecrets(configs: SwarmConfig[]): SwarmConfig[] {
  return configs.map((c) => (c.isSecret ? { ...c, value: MASKED_SECRET_VALUE } : c));
}

/**
 * List config entries with optional filters.
 */
export async function getSwarmConfigs(filters?: {
  scope?: string;
  scopeId?: string;
  key?: string;
}): Promise<SwarmConfig[]> {
  const rows = await getStorage().repos.config.listConfigs(filters ?? {});
  return rows.map(rowToSwarmConfig);
}

/**
 * Global configs that are allowed to flow into process.env.
 * Reserved env-only keys are filtered in SQL before decryption so a corrupted
 * legacy reserved row cannot block startup or reload. Process-control keys
 * (`isApiProcessControlEnvKey`) and keys that cannot be env names stay out too.
 */
export async function getInjectableGlobalConfigs(): Promise<SwarmConfig[]> {
  const rows = await getStorage().repos.config.listGlobalConfigsExcept([
    "API_KEY",
    "SECRETS_ENCRYPTION_KEY",
    "CORS_ALLOW_ANY_ORIGIN",
    "EXTENSION_ALLOW_LEAD_ACTIVATION",
    "CHAT_SDK_API_URL_OVERRIDES",
    ...TEAMS_SDK_ENV_KEYS,
  ]);
  return rows
    .filter(
      (row) =>
        !isInternalConfigKey(row.key) &&
        !isApiProcessControlEnvKey(row.key) &&
        !invalidConfigKeyError(row.key),
    )
    .map(rowToSwarmConfig);
}

/**
 * Get a single config entry by ID.
 */
export async function getSwarmConfigById(id: string): Promise<SwarmConfig | null> {
  const row = await getStorage().repos.config.findConfigById(id);
  return row ? rowToSwarmConfig(row) : null;
}

/**
 * Get config metadata by ID without decrypting the value. Used by cleanup
 * paths so unreadable secret rows can still be inspected and removed.
 */
export async function getSwarmConfigLookupById(id: string): Promise<{
  id: string;
  scope: "global" | "agent" | "repo";
  scopeId: string | null;
  key: string;
  isSecret: boolean;
  encrypted: boolean;
} | null> {
  const row = await getStorage().repos.config.findConfigById(id);
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope as "global" | "agent" | "repo",
    scopeId: row.scopeId ?? null,
    key: row.key,
    isSecret: row.isSecret === 1,
    encrypted: row.encrypted === 1,
  };
}

/**
 * Upsert a config entry. Inserts or updates by (scope, scopeId, key) unique constraint.
 */
export async function upsertSwarmConfig(data: {
  scope: "global" | "agent" | "repo";
  scopeId?: string | null;
  key: string;
  value: string;
  isSecret?: boolean;
  envPath?: string | null;
  description?: string | null;
  /** Omitted: an update keeps the stored flag; an insert uses `defaultExportToEnv`. */
  exportToEnv?: boolean;
}): Promise<SwarmConfig> {
  const keyError = invalidConfigKeyError(data.key);
  if (keyError) throw new Error(keyError);
  if (isReservedConfigKey(data.key)) {
    throw reservedKeyError(data.key);
  }
  if (data.exportToEnv === true && isEnvExportRestrictedKey(data.key)) {
    throw new Error(envExportRestrictedError(data.key));
  }
  const restricted = isEnvExportRestrictedKey(data.key);

  const now = new Date().toISOString();
  const scopeId = data.scope === "global" ? null : (data.scopeId ?? null);
  const isSecret = data.isSecret === true;
  const envPath = data.envPath ?? null;
  const description = data.description ?? null;

  // Encrypt secret values at rest. Non-secret values are stored verbatim so
  // they remain queryable and diffable. rowToSwarmConfig reverses this on read.
  const storedValue = data.isSecret ? encryptSecret(data.value, getEncryptionKey()) : data.value;
  const encryptedFlag = data.isSecret === true;

  // Manual check for existing entry because SQLite's UNIQUE constraint
  // treats NULL != NULL, so ON CONFLICT never fires when scopeId is NULL (global scope).
  //
  // Lookup and write share one transaction: without it two concurrent saves of
  // the same global key both read `existing = null` and both INSERT (the
  // UNIQUE constraint cannot arbitrate a NULL scopeId), leaving a duplicate
  // pair where env injection reads the last row and every later save updates
  // the first one, i.e. a permanent silent no-op.
  const storage = getStorage();
  const configs = storage.repos.config;
  const row = await storage.transaction(async () => {
    const existing = await configs.findConfigByScopeKey(data.scope, scopeId, data.key);

    // COALESCE keeps the stored flag when the caller did not send one.
    const written = existing
      ? await configs.updateConfigValue(existing.id, {
          value: storedValue,
          isSecret,
          envPath,
          description,
          encrypted: encryptedFlag,
          now,
          forceNoExport: restricted,
          exportToEnv: data.exportToEnv === undefined ? null : data.exportToEnv,
        })
      : await configs.insertConfig({
          id: crypto.randomUUID(),
          scope: data.scope,
          scopeId,
          key: data.key,
          value: storedValue,
          isSecret,
          envPath,
          description,
          encrypted: encryptedFlag,
          exportToEnv: restricted ? false : (data.exportToEnv ?? defaultExportToEnv(data.key)),
          now,
        });
    if (data.scope === "agent" && scopeId) {
      await clearAgentModelProfileOnOverrideChange(scopeId, data.key, existing, written);
    }
    return written;
  });

  if (!row) throw new Error("Failed to upsert swarm config");

  // rowToSwarmConfig transparently decrypts `storedValue` back to plaintext so
  // the returned object sees the original value.
  const config = rowToSwarmConfig(row);

  if (config.isSecret) {
    registerStoredSecret(config.value, configSecretName(config.key));
    registerSensitiveKeyName(config.key);
  }

  storage.afterCommit(() => publishWorkerConfigNudge(config.scope, config.scopeId));

  return config;
}

/** Emit a built-in integration only once for this persisted installation. */
export async function emitBuiltInIntegrationConnectedOnce(
  provider: "github" | "slack",
): Promise<void> {
  try {
    const key = `telemetry.integration.${provider}.emitted`;
    if ((await getSwarmConfigs({ scope: "global", key })).length > 0) return;
    if (!emitIntegrationConnected(_resolveIntegrationType(provider), provider, true)) return;
    await upsertSwarmConfig({ scope: "global", key, value: "true" });
  } catch {
    // Telemetry must never break integration startup.
  }
}

/**
 * Delete a config entry by ID.
 *
 * Intentionally does not decrypt or block reserved keys. Legacy rows that
 * predate hardening must remain removable through remediation paths.
 */
export async function deleteSwarmConfig(id: string): Promise<boolean> {
  const row = await getStorage().repos.config.deleteConfig(id);
  if (row?.scope === "agent" && row.scopeId) {
    await clearAgentModelProfileOnOverrideChange(row.scopeId, row.key, row, null);
  }
  if (row) getStorage().afterCommit(() => publishWorkerConfigNudge(row.scope, row.scopeId));
  return row !== null;
}

/**
 * Delete a config entry looked up by (scope, scopeId, key) rather than row
 * id. Callers like the runtime PATCH route (`PATCH /api/agents/{id}/runtime`)
 * know the logical key (e.g. `MODEL_OVERRIDE`, `REASONING_EFFORT_OVERRIDE`)
 * but not the row id — `deleteSwarmConfig(id)` alone can't serve them. No-ops
 * (returns `false`) when no matching row exists, mirroring `upsertSwarmConfig`'s
 * NULL-safe existing-row lookup (SQLite's UNIQUE constraint treats NULL !=
 * NULL, so a plain `scopeId = ?` comparison never matches global scope).
 */
export async function deleteSwarmConfigByKey(
  scope: "global" | "agent" | "repo",
  scopeId: string | null,
  key: string,
): Promise<boolean> {
  const resolvedScopeId = scope === "global" ? null : scopeId;
  const existing = await getStorage().repos.config.findConfigByScopeKey(
    scope,
    resolvedScopeId,
    key,
  );
  if (!existing) return false;
  return await deleteSwarmConfig(existing.id);
}

/**
 * Get resolved (merged) config for a given agent and/or repo.
 * Scope resolution: repo > agent > global (most-specific wins).
 * Returns one entry per unique key with the most-specific scope winning.
 */
export async function getResolvedConfig(
  agentId?: string,
  repoId?: string,
  options: { includeRepoSecrets?: boolean } = {},
): Promise<SwarmConfig[]> {
  // Start with global configs
  const configMap = new Map<string, SwarmConfig>();

  const globalConfigs = await getSwarmConfigs({ scope: "global" });
  for (const config of globalConfigs) {
    configMap.set(config.key, config);
  }

  // Overlay agent configs (agent wins over global)
  if (agentId) {
    const agentConfigs = await getSwarmConfigs({ scope: "agent", scopeId: agentId });
    for (const config of agentConfigs) {
      configMap.set(config.key, config);
    }
  }

  // Overlay repo configs (repo wins over agent and global)
  if (repoId) {
    const repoConfigs = await getSwarmConfigs({ scope: "repo", scopeId: repoId });
    for (const config of repoConfigs) {
      if (config.isSecret && options.includeRepoSecrets === false) continue;
      configMap.set(config.key, config);
    }
  }

  return Array.from(configMap.values()).sort((a, b) => a.key.localeCompare(b.key));
}

// ============================================================================
// Swarm Repos Functions (Centralized Repository Management)
// ============================================================================

function rowToSwarmRepo(row: SwarmRepoRow): SwarmRepo {
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    clonePath: row.clonePath,
    defaultBranch: row.defaultBranch,
    autoClone: row.autoClone === 1,
    hooks: row.hooks ? JSON.parse(row.hooks) : { enabled: false },
    guidelines: row.guidelines ? JSON.parse(row.guidelines) : null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export async function getSwarmRepos(filters?: {
  autoClone?: boolean;
  name?: string;
}): Promise<SwarmRepo[]> {
  const rows = await getStorage().repos.config.listRepos(filters ?? {});
  return rows.map(rowToSwarmRepo);
}

export async function getSwarmRepoById(id: string): Promise<SwarmRepo | null> {
  const row = await getStorage().repos.config.findRepoById(id);
  return row ? rowToSwarmRepo(row) : null;
}

export async function getSwarmRepoByName(name: string): Promise<SwarmRepo | null> {
  const row = await getStorage().repos.config.findRepoByName(name);
  return row ? rowToSwarmRepo(row) : null;
}

export async function getSwarmRepoByUrl(url: string): Promise<SwarmRepo | null> {
  const row = await getStorage().repos.config.findRepoByUrl(url);
  return row ? rowToSwarmRepo(row) : null;
}

export async function createSwarmRepo(data: {
  url: string;
  name: string;
  clonePath?: string;
  defaultBranch?: string;
  autoClone?: boolean;
  hooks?: { enabled: boolean };
  guidelines?: RepoGuidelines | null;
}): Promise<SwarmRepo> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const clonePath = data.clonePath || `/workspace/personal/repos/${data.name}`;
  const hooksJson = JSON.stringify(data.hooks ?? { enabled: true });
  const guidelinesJson = data.guidelines ? JSON.stringify(data.guidelines) : null;

  const row = await getStorage().repos.config.insertRepo({
    id,
    url: data.url,
    name: data.name,
    clonePath,
    defaultBranch: data.defaultBranch ?? "main",
    autoClone: data.autoClone !== false,
    hooks: hooksJson,
    guidelines: guidelinesJson,
    now,
  });

  if (!row) throw new Error("Failed to create repo");
  return rowToSwarmRepo(row);
}

export async function updateSwarmRepo(
  id: string,
  updates: Partial<{
    url: string;
    name: string;
    clonePath: string;
    defaultBranch: string;
    autoClone: boolean;
    hooks: { enabled: boolean } | null;
    guidelines: RepoGuidelines | null;
  }>,
): Promise<SwarmRepo | null> {
  const columns: SwarmRepoColumnUpdate = {};
  if (updates.url !== undefined) columns.url = updates.url;
  if (updates.name !== undefined) columns.name = updates.name;
  if (updates.clonePath !== undefined) columns.clonePath = updates.clonePath;
  if (updates.defaultBranch !== undefined) columns.defaultBranch = updates.defaultBranch;
  if (updates.autoClone !== undefined) columns.autoClone = updates.autoClone;
  if (updates.hooks !== undefined) {
    columns.hooks = updates.hooks ? JSON.stringify(updates.hooks) : null;
  }
  if (updates.guidelines !== undefined) {
    columns.guidelines = updates.guidelines ? JSON.stringify(updates.guidelines) : null;
  }

  if (Object.keys(columns).length === 0) return await getSwarmRepoById(id);

  const row = await getStorage().repos.config.updateRepo(id, columns, new Date().toISOString());

  return row ? rowToSwarmRepo(row) : null;
}

export async function deleteSwarmRepo(id: string): Promise<boolean> {
  return (await getStorage().repos.config.deleteRepo(id)) > 0;
}

// ============================================================================
// AgentMail Inbox Mapping Queries
// ============================================================================

export interface AgentMailInboxMapping {
  id: string;
  inboxId: string;
  agentId: string;
  inboxEmail: string | null;
  createdAt: string;
}

export async function getAgentMailInboxMapping(
  inboxId: string,
): Promise<AgentMailInboxMapping | null> {
  return await getStorage().repos.messaging.findAgentMailInboxMapping(inboxId);
}

export async function getAgentMailInboxMappingsByAgent(
  agentId: string,
): Promise<AgentMailInboxMapping[]> {
  return await getStorage().repos.messaging.listAgentMailInboxMappings(agentId);
}

export async function getAllAgentMailInboxMappings(): Promise<AgentMailInboxMapping[]> {
  return await getStorage().repos.messaging.listAgentMailInboxMappings();
}

/**
 * Map an inbox to an agent. Re-registering an inbox the same agent already owns
 * refreshes its email. Returns null, and changes nothing, when the inbox is
 * already mapped to a different agent.
 */
export async function createAgentMailInboxMapping(
  inboxId: string,
  agentId: string,
  inboxEmail?: string,
): Promise<AgentMailInboxMapping | null> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  return await getStorage().repos.messaging.upsertAgentMailInboxMapping({
    id,
    inboxId,
    agentId,
    inboxEmail: inboxEmail ?? null,
    createdAt: now,
  });
}

export async function deleteAgentMailInboxMapping(inboxId: string): Promise<boolean> {
  return (await getStorage().repos.messaging.deleteAgentMailInboxMapping(inboxId)) > 0;
}

/**
 * Find the most recent task by AgentMail thread ID
 * Includes completed/failed tasks to maintain thread continuity via parentTaskId
 */
export async function findTaskByAgentMailThread(
  agentmailThreadId: string,
): Promise<AgentTask | null> {
  const row = await getStorage().repos.tasks.findLatestTaskByAgentMailThread(agentmailThreadId);
  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

// ============================================================================
// Active Sessions (runner session tracking for concurrency awareness)
// ============================================================================

export async function insertActiveSession(session: {
  agentId: string;
  taskId?: string;
  triggerType: string;
  inboxMessageId?: string;
  taskDescription?: string;
  runnerSessionId?: string;
  runtimeInstanceId?: string;
}): Promise<ActiveSession> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = (await getStorage().repos.agents.insertActiveSession({
    id,
    agentId: session.agentId,
    taskId: session.taskId ?? null,
    triggerType: session.triggerType,
    inboxMessageId: session.inboxMessageId ?? null,
    taskDescription: session.taskDescription ?? null,
    runnerSessionId: session.runnerSessionId ?? null,
    runtimeInstanceId: session.runtimeInstanceId ?? null,
    now,
  })) as ActiveSession | null;

  if (!row) throw new Error("Failed to insert active session");
  return row;
}

export async function deleteActiveSession(taskId: string): Promise<boolean> {
  return (await getStorage().repos.agents.deleteActiveSessionByTask(taskId)) > 0;
}

export async function deleteActiveSessionById(id: string): Promise<boolean> {
  return (await getStorage().repos.agents.deleteActiveSessionById(id)) > 0;
}

export async function getActiveSessions(
  agentId?: string,
  readableBy?: { userId: string | null },
): Promise<ActiveSession[]> {
  return (await getStorage().repos.agents.listActiveSessions(
    agentId,
    readableBy,
  )) as ActiveSession[];
}

export async function heartbeatActiveSession(taskId: string): Promise<boolean> {
  const now = new Date().toISOString();
  return (await getStorage().repos.agents.heartbeatActiveSession(taskId, now)) > 0;
}

export async function cleanupStaleSessions(maxAgeMinutes = 30): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  return await getStorage().repos.agents.deleteActiveSessionsBefore(cutoff);
}

export async function cleanupAgentSessions(agentId: string): Promise<number> {
  return await getStorage().repos.agents.deleteActiveSessionsByAgent(agentId);
}

/** Update providerSessionId on an active session identified by taskId */
export async function updateActiveSessionProviderSessionId(
  taskId: string,
  providerSessionId: string,
): Promise<boolean> {
  return (
    (await getStorage().repos.agents.setActiveSessionProviderSessionId(taskId, providerSessionId)) >
    0
  );
}

/**
 * Get the active session for a specific task.
 * Used by the heartbeat to cross-reference stalled tasks with worker sessions.
 */
export async function getActiveSessionForTask(taskId: string): Promise<ActiveSession | null> {
  return (await getStorage().repos.agents.findActiveSessionByTask(taskId)) as ActiveSession | null;
}

/**
 * Reassociate session logs from a runner session to a real task ID.
 * Used when a pool task is claimed — logs were stored under a random UUID,
 * this updates them to use the real task ID.
 * Idempotent — safe to call multiple times.
 */
export async function reassociateSessionLogs(
  runnerSessionId: string,
  realTaskId: string,
): Promise<number> {
  return getStorage().repos.sessions.reassignLogsToTask(runnerSessionId, realTaskId);
}

// ============================================================================
// Heartbeat / Triage Query Functions
// ============================================================================

/**
 * Get in_progress tasks that haven't been updated within the given threshold.
 * Used by the heartbeat to detect potentially stalled tasks.
 */
export async function getStalledInProgressTasks(
  thresholdMinutes: number = 30,
): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
  const rows = await getStorage().repos.tasks.listStalledInProgressTasks(cutoff);
  return rows.map((row) => rowToAgentTask(row as AgentTaskRow));
}

/**
 * Genuine same-agent protected pins — resumes tagged `crash-recovery-pin` /
 * `graceful-shutdown-pin`, OR a reboot-retry child tagged `reboot-retry-pin`
 * (routing-affinity Phase 3) — that are still `pending` `graceMin` minutes
 * after creation. The heartbeat reaper escalates these to a Lead
 * reroute-decision.
 *
 * Scoping clauses, each load-bearing:
 *  - `taskType = 'resume' AND (crash/graceful pin tags)` OR `reboot-retry-pin`
 *    tag alone — restricts to work actually pinned to its original agent on a
 *    protected path. A reboot-retry-pin task is a FRESH task (`taskType`
 *    mirrors the original work, not `'resume'`), so it needs its own
 *    disjunct rather than reusing the `taskType = 'resume'` gate. Without
 *    this, a *pooled* resume that `autoAssignPoolTasks` flips to `pending`
 *    earlier in the SAME sweep (keeping its old `createdAt`) would be reaped
 *    and cancelled before the assigned worker polls; it also keeps
 *    `context_limits` / `manual_supersede` pins from being escalated under
 *    the protected-pin label. (Literals must match the pin tag constants in
 *    src/tasks/worker-follow-up.ts.)
 *  - `status = 'pending'` — the "currently unreclaimed" discriminator: when the
 *    agent reclaims via the normal poll path, `startTask` flips the row to
 *    `in_progress` and it drops out of this set. (A reclaimed resume whose
 *    session later orphans can be flipped back to `pending` by
 *    `resetOrphanedInProgressTasksForAgent`, re-entering this set on a later
 *    sweep — re-escalating genuinely re-stalled work, which is fine.) We do NOT
 *    gate on `lastActivityAt` — it is stale for a returned-but-idle agent.
 *  - `createdAt < cutoff` — `createdAt` is the resume's creation = crash-DETECTION
 *    time, so the grace window is measured from detection.
 *
 * Keys only on reboot-durable columns, so a pending pin survives a server reboot
 * and is caught on the first post-reboot sweep.
 */
export async function getStalePinnedResumes(graceMin: number): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - graceMin * 60 * 1000).toISOString();
  const rows = await getStorage().repos.tasks.listStalePinnedResumes(cutoff);
  return rows.map((row) => rowToAgentTask(row as AgentTaskRow));
}

/**
 * Atomically terminalize a pinned resume ONLY if it is still `pending`, in one
 * `UPDATE … RETURNING`. Returns the row when the transition fired, or `null`
 * when it did not (the agent reclaimed it in the gap → `startTask` already
 * flipped it to `in_progress`). The heartbeat reaper escalates to the Lead ONLY
 * when this returns a row, closing the TOCTOU window between reading the resume
 * as `pending` and writing.
 *
 * Deliberately NOT `failTask`: `failTask`'s backing SQL is keyed on `id` with no
 * status precondition, so it would terminalize an `in_progress` resume the
 * worker just started. The `AND status = 'pending'` here is the guard.
 */
export async function failPendingResumeIfUnclaimed(
  taskId: string,
  status: "cancelled" | "failed",
  failureReason: string,
): Promise<AgentTask | null> {
  const now = new Date().toISOString();
  const scrubbedReason = scrubSecrets(failureReason);
  const row = await getStorage().repos.tasks.failPendingTask(taskId, {
    status,
    // The resume budget ran out (failed) or the reaper escalated the pin (cancelled).
    statusKind: status === "failed" ? "error" : "system",
    failureReason: scrubbedReason,
    now,
  });

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: "pending",
        newValue: status,
        metadata: { reason: scrubbedReason, reaper: "pin_unreclaimed" },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

/**
 * Get idle, non-lead, non-offline agents that have capacity for more tasks.
 * Used by the heartbeat for auto-assignment of pool tasks.
 */
export async function getIdleWorkersWithCapacity(): Promise<Agent[]> {
  const rows = (await getStorage().repos.agents.listIdleWorkers()) as AgentRow[];
  const agents = rows.map((row) => rowToAgent(row));

  const withCapacity = await Promise.all(
    agents.map(async (agent) => {
      const activeCount = await getActiveTaskCount(agent.id);
      return activeCount < (agent.maxTasks ?? 1) ? agent : null;
    }),
  );
  return withCapacity.filter((agent): agent is Agent => agent !== null);
}

/**
 * Get unassigned pool tasks ordered by priority (DESC), creation time (ASC),
 * then `rowid` (ASC) as a stable tiebreaker. The `rowid` tiebreaker matters
 * once `offset` is used for pagination (`autoAssignPoolTasks` in
 * src/heartbeat/heartbeat.ts) — without it, rows sharing a `createdAt` could
 * be skipped or repeated across pages. Used by the heartbeat for
 * auto-assignment and status reporting.
 */
export async function getUnassignedPoolTasks(
  limit: number = 10,
  offset: number = 0,
): Promise<AgentTask[]> {
  const rows = await getStorage().repos.tasks.listUnassignedTasks(limit, offset);
  return rows.map((row) => rowToAgentTask(row as AgentTaskRow));
}

/**
 * Affinity-tagged pool tasks that have sat `unassigned` past `cutoffIso` —
 * the starvation-escalation candidate set (routing-affinity Phase 3). Callers
 * MUST separately confirm zero registered agents satisfy
 * `isAgentEligibleForTask` before escalating; this only narrows by tag age.
 */
export async function getStaleUnassignedAffinityTasks(cutoffIso: string): Promise<AgentTask[]> {
  const rows = await getStorage().repos.tasks.listStaleUnassignedAffinityTasks(cutoffIso);
  return rows.map((row) => rowToAgentTask(row as AgentTaskRow));
}

export async function getRecentFailedTasks(hours: number = 6): Promise<AgentTask[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = await getStorage().repos.tasks.listRecentFailedTasks(since, 20);
  return rows.map((row) => rowToAgentTask(row as AgentTaskRow));
}

export async function getRecentCompletedCount(hours: number = 24): Promise<number> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return await getStorage().repos.tasks.countTasksFinishedSince("completed", since);
}

export async function getRecentFailedCount(hours: number = 24): Promise<number> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return await getStorage().repos.tasks.countTasksFinishedSince("failed", since);
}

// ============================================================================
// Workflow CRUD
// ============================================================================

type WorkflowsRepo = ReturnType<typeof getStorage>["repos"]["workflows"];
type WorkflowColumnUpdate = Parameters<WorkflowsRepo["updateWorkflowColumns"]>[1];
type WorkflowRunColumnUpdate = Parameters<WorkflowsRepo["updateRunColumns"]>[1];
type WorkflowRunStepColumnUpdate = Parameters<WorkflowsRepo["updateStepColumns"]>[1];
type WorkflowVersionRow = NonNullable<Awaited<ReturnType<WorkflowsRepo["getVersion"]>>>;

export async function createWorkflow(
  data: {
    key?: string;
    name: string;
    description?: string;
    definition: WorkflowDefinition;
    triggers?: TriggerConfig[];
    cooldown?: CooldownConfig;
    input?: Record<string, InputValue>;
    triggerSchema?: Record<string, unknown>;
    params?: Record<string, unknown>;
    requiredParams?: string[];
    requires?: AutomationIntegrationId[];
    dir?: string;
    vcsRepo?: string;
    createdByAgentId?: string;
    createdBy?: string;
    /** Defaults to true. Extensions create their workflows disabled. */
    enabled?: boolean;
  },
  source?: "api" | "mcp",
): Promise<Workflow> {
  const id = crypto.randomUUID();
  const row = await getStorage().repos.workflows.insertWorkflow({
    id,
    key: normalizeAssetKey(data.key ?? defaultAssetKey("workflow", id)),
    name: data.name,
    description: data.description ?? null,
    definition: JSON.stringify(data.definition),
    triggers: JSON.stringify(data.triggers ?? []),
    cooldown: data.cooldown ? JSON.stringify(data.cooldown) : null,
    input: data.input ? JSON.stringify(data.input) : null,
    triggerSchema: data.triggerSchema ? JSON.stringify(data.triggerSchema) : null,
    params: JSON.stringify(data.params ?? {}),
    requiredParams: JSON.stringify(data.requiredParams ?? []),
    requires: JSON.stringify(data.requires ?? []),
    dir: data.dir ?? null,
    vcsRepo: data.vcsRepo ?? null,
    createdByAgentId: data.createdByAgentId ?? null,
    createdBy: data.createdBy ?? null,
    enabled: data.enabled !== false,
  });
  if (!row) throw new Error("Failed to create workflow");
  const workflow = rowToWorkflow(row);
  // afterCommit: a caller's transaction that rolls back must not report the workflow.
  const requestUserId = getCurrentRequestUserId();
  getStorage().afterCommit(() =>
    telemetry.workflow(
      "created",
      {
        workflowId: workflow.id,
        nodeCount: workflow.definition.nodes.length,
        ...(source ? { via: source } : {}),
      },
      { userId: requestUserId ?? null },
    ),
  );
  return workflow;
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  const row = await getStorage().repos.workflows.findWorkflowById(id);
  return row ? rowToWorkflow(row) : null;
}

/**
 * Slim list-row mapper — drops the heavy `definition` (avg ~18 KB/row) and the
 * trigger config, keeping a derived `nodeCount` so the list view can still
 * answer "how big is this workflow" without the full DAG. Fetch the full shape
 * via `getWorkflow(id)`.
 */
function rowToWorkflowSummary(row: WorkflowRow): WorkflowSummary {
  let nodeCount = 0;
  try {
    const def = JSON.parse(row.definition) as WorkflowDefinition;
    nodeCount = Array.isArray(def?.nodes) ? def.nodes.length : 0;
  } catch {
    nodeCount = 0;
  }
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    dir: row.dir ?? undefined,
    vcsRepo: row.vcs_repo ?? undefined,
    createdByAgentId: row.createdByAgentId ?? undefined,
    updatedByAgentId: row.updatedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    nodeCount,
  };
}

export interface WorkflowFilters {
  enabled?: boolean;
  lastRunStatus?: WorkflowRunStatus;
  consecutiveErrorsMin?: number;
  key?: string;
  keyPrefix?: string;
  /** Matches the name, description or key anywhere, case-insensitive. */
  q?: string;
  /** At most this many rows, newest first. */
  limit?: number;
}

export function listWorkflows(filters?: WorkflowFilters): Promise<Workflow[]>;
export function listWorkflows(
  filters: WorkflowFilters | undefined,
  opts: { slim: true },
): Promise<WorkflowSummary[]>;
export async function listWorkflows(
  filters?: WorkflowFilters,
  opts?: { slim?: boolean },
): Promise<Workflow[] | WorkflowSummary[]> {
  const rows = await getStorage().repos.workflows.listWorkflows({
    enabled: filters?.enabled,
    key: filters?.key ? normalizeAssetKey(filters.key) : undefined,
    keyPattern:
      !filters?.key && filters?.keyPrefix ? assetKeyPrefixPattern(filters.keyPrefix) : undefined,
    lastRunStatus: filters?.lastRunStatus,
    consecutiveErrorsMin: filters?.consecutiveErrorsMin,
    textPattern: filters?.q ? `%${literalPrefixPattern(filters.q)}` : undefined,
    limit: filters?.limit,
  });
  return opts?.slim ? rows.map(rowToWorkflowSummary) : rows.map(rowToWorkflow);
}

export async function updateWorkflow(
  id: string,
  data: {
    key?: string;
    name?: string;
    description?: string;
    enabled?: boolean;
    definition?: WorkflowDefinition;
    triggers?: TriggerConfig[];
    cooldown?: CooldownConfig | null;
    input?: Record<string, InputValue> | null;
    triggerSchema?: Record<string, unknown> | null;
    params?: Record<string, unknown>;
    requiredParams?: string[];
    requires?: AutomationIntegrationId[];
    dir?: string | null;
    vcsRepo?: string | null;
    /**
     * Audit pair for a user-intent write: pass both (null = unknown) so they
     * describe the same write. Omitted (system writes) leaves them untouched.
     */
    updatedBy?: string | null;
    updatedByAgentId?: string | null;
  },
): Promise<Workflow | null> {
  const update: WorkflowColumnUpdate = {};
  if (data.key !== undefined) update.key = normalizeAssetKey(data.key);
  if (data.name !== undefined) update.name = data.name;
  if (data.description !== undefined) update.description = data.description;
  if (data.enabled !== undefined) update.enabled = data.enabled;
  if (data.definition !== undefined) update.definition = JSON.stringify(data.definition);
  if (data.triggers !== undefined) update.triggers = JSON.stringify(data.triggers);
  if (data.cooldown !== undefined) {
    update.cooldown = data.cooldown ? JSON.stringify(data.cooldown) : null;
  }
  if (data.input !== undefined) update.input = data.input ? JSON.stringify(data.input) : null;
  if (data.triggerSchema !== undefined) {
    update.triggerSchema = data.triggerSchema ? JSON.stringify(data.triggerSchema) : null;
  }
  if (data.params !== undefined) update.params = JSON.stringify(data.params);
  if (data.requiredParams !== undefined) {
    update.requiredParams = JSON.stringify(data.requiredParams);
  }
  if (data.requires !== undefined) update.requires = JSON.stringify(data.requires);
  if (data.dir !== undefined) update.dir = data.dir ?? null;
  if (data.vcsRepo !== undefined) update.vcsRepo = data.vcsRepo ?? null;
  if (data.updatedBy !== undefined) update.updatedBy = data.updatedBy;
  if (data.updatedByAgentId !== undefined) update.updatedByAgentId = data.updatedByAgentId;
  if (Object.keys(update).length === 0) return await getWorkflow(id);
  const row = await getStorage().repos.workflows.updateWorkflowColumns(
    id,
    update,
    new Date().toISOString(),
  );
  return row ? rowToWorkflow(row) : null;
}

export async function deleteWorkflow(id: string, source?: "api" | "mcp"): Promise<boolean> {
  // One transaction: the stored human-free flags must never lag the deleted runs
  // (a scheduled workflow root is human-free only while its run row exists).
  return await getStorage().transaction(() => deleteWorkflowRows(id, source));
}

async function deleteWorkflowRows(id: string, source?: "api" | "mcp"): Promise<boolean> {
  const tasks = getStorage().repos.tasks;
  const linkedTaskIds = await tasks.listTaskIdsOfWorkflow(id);
  // Cascade delete in FK-safe order:
  // 1. Unlink agent_tasks (they reference steps and runs)
  await tasks.unlinkTasksFromWorkflow(id);
  // 2. Fail the parent steps of child runs about to go, then delete steps
  await wakeParentsOfDeletedRuns(id);
  const workflows = getStorage().repos.workflows;
  await workflows.deleteStepsOfWorkflow(id);
  // 3. Delete runs (they reference workflow)
  const definitionHashes = await workflows.listRunDefinitionHashesOfWorkflow(id);
  await workflows.deleteRunsOfWorkflow(id);
  await deleteOrphanedRunDefinitions(definitionHashes);
  await reclassifyTaskHumanFree(linkedTaskIds);
  // 4. Delete every user's favorite of it (no FK to the workflow)
  await getStorage().repos.users.deleteFavoritesOfItem("workflow", id);
  // 5. Keep Idempotency-Keys that created or triggered it taken, without the stored response
  await tombstoneWorkflowIdempotencyKeys(id);
  // 6. Delete workflow
  const deleted = (await workflows.deleteWorkflow(id)) > 0;
  if (deleted) {
    // afterCommit: a caller's transaction that rolls back must not report the delete.
    const requestUserId = getCurrentRequestUserId();
    getStorage().afterCommit(() =>
      telemetry.workflow(
        "deleted",
        { workflowId: id, ...(source ? { via: source } : {}) },
        { userId: requestUserId ?? null },
      ),
    );
  }
  return deleted;
}

/**
 * Find enabled workflows that have a schedule trigger matching the given scheduleId.
 * Uses SQLite JSON functions to query into the triggers JSON array.
 */
export async function getWorkflowsByScheduleId(scheduleId: string): Promise<Workflow[]> {
  const rows = await getStorage().repos.workflows.listEnabledByScheduleId(scheduleId);
  return rows.map(rowToWorkflow);
}

// ============================================================================
// Workflow Run CRUD
// ============================================================================

export async function createWorkflowRun(data: {
  id: string;
  workflowId: string;
  triggerType?: "schedule" | "manual" | "event" | "api";
  triggerData?: unknown;
  createdBy?: string;
  parentStepId?: string;
  /** The parent step's `retryCount` when it started this run (migration 240). */
  parentStepAttempt?: number;
  /** Server-stamped agent that started the run (migration 247). Never from trigger data. */
  triggeredByAgentId?: string;
  /** The `workflow_run_definitions` row the run is pinned to (migration 283). */
  definitionHash?: string;
  /** JSON `WorkflowRunPrincipal` decided from the pinned definition (migration 367). */
  principal?: string;
}): Promise<WorkflowRun> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.workflows.insertRun({
    id: data.id,
    workflowId: data.workflowId,
    triggerType: data.triggerType ?? "manual",
    startedAt: now,
    triggerData: data.triggerData ? scrubJsonValue(data.triggerData) : null,
    createdBy: data.createdBy ?? null,
    parentStepId: data.parentStepId ?? null,
    parentStepAttempt: data.parentStepAttempt ?? 0,
    triggeredByAgentId: data.triggeredByAgentId ?? null,
    definitionHash: data.definitionHash ?? null,
    // The script step whose run token started this run (trigger-workflow is
    // a manual or api trigger). A sub-workflow child is linked by
    // parentStepId instead, and an event or schedule run is never the
    // script's, even when it starts inside that script's request.
    sourceStepId:
      data.parentStepId ||
      (data.triggerType !== "api" && (data.triggerType ?? "manual") !== "manual")
        ? null
        : (getCurrentRunProvenance()?.sourceStepId ?? null),
    principal: data.principal ?? null,
  });
  if (!row) throw new Error("Failed to create workflow run");
  return rowToWorkflowRun(row);
}

export async function getWorkflowRun(
  id: string,
  view: WorkflowPayloadView = "replay",
): Promise<WorkflowRun | null> {
  const row = await getStorage().repos.workflows.findRunById(id);
  return row ? rowToWorkflowRun(row, view) : null;
}

function emitWorkflowTerminalTelemetry(run: WorkflowRun): void {
  if (run.status !== "completed" && run.status !== "failed") return;
  const status = run.status;

  // afterCommit (not queueMicrotask): under an async client transaction,
  // microtasks drain before COMMIT, so the verify read below could observe
  // uncommitted state. afterCommit runs strictly post-COMMIT/ROLLBACK. The
  // async hook is passed directly (no detached void-IIFE) so a rejected read
  // (e.g. DB closed mid-shutdown) is contained by the scheduler instead of
  // crashing the process as an unhandled rejection.
  getStorage().afterCommit(async () => {
    const latest = await getWorkflowRun(run.id);
    if (!latest || latest.status !== status) return;
    const steps = await getWorkflowRunStepsByRunId(run.id);
    telemetry.workflow(status, {
      workflowId: run.workflowId,
      durationMs: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : undefined,
      stepsCompleted: steps.filter((step) => step.status === "completed").length,
      stepsFailed: steps.filter((step) => step.status === "failed").length,
    });
  });
}

export async function updateWorkflowRun(
  id: string,
  data: {
    status?: WorkflowRunStatus;
    context?: Record<string, unknown>;
    error?: string | null;
    finishedAt?: string;
  },
): Promise<WorkflowRun | null> {
  const workflows = getStorage().repos.workflows;
  const columns: WorkflowRunColumnUpdate = {};
  if (data.status !== undefined) columns.status = data.status;
  if (data.context !== undefined) {
    // Resume/retry/recovery rebuild the live ctx (resolved `secret.*` inputs
    // included, which are never re-resolved) from the sealed exact copy; the
    // scrubbed column serves display and SQL filters.
    columns.context = scrubJsonValue(data.context);
    columns.context_replay = sealJson(data.context);
  }
  if (data.error !== undefined) {
    columns.error = data.error === null ? null : scrubSecrets(data.error);
  }
  if (data.finishedAt !== undefined) columns.finishedAt = data.finishedAt;
  if (Object.keys(columns).length === 0) {
    const row = await workflows.findRunById(id);
    return row ? rowToWorkflowRun(row) : null;
  }
  const now = new Date().toISOString();
  const update = () => workflows.updateRunColumns(id, columns, now);
  const endsRun = data.status !== undefined && isTerminalWorkflowRunStatus(data.status);
  // A run that ends reads the status it replaces in the same transaction, so
  // only a change out of a live status announces the end: a later terminal
  // write, same status or not, does not announce it again.
  const [previousStatus, row] = endsRun
    ? await getStorage().transaction(async () => {
        const previous = (await workflows.getRunStatus(id)) as WorkflowRunStatus | null;
        return [previous ?? undefined, await update()] as const;
      })
    : [undefined, await update()];
  if (!row) return null;
  const run = rowToWorkflowRun(row);
  if (data.status === "completed" || data.status === "failed") {
    emitWorkflowTerminalTelemetry(run);
  }
  if (row.parentStepId) emitChildRunFinished(id, row.parentStepId, run.status);
  if (endsRun && previousStatus && !isTerminalWorkflowRunStatus(previousStatus)) {
    emitRunFinished(id, run.workflowId, run.status);
  }
  return run;
}

export type WorkflowRunListOptions = {
  status?: WorkflowRunStatus;
  limit?: number;
  offset?: number;
  /**
   * Read the run `context`. Off by default: it is the one large column, and
   * `getWorkflowRun` serves it for a single run.
   */
  includeContext?: boolean;
};

export type WorkflowRunPage = {
  runs: WorkflowRun[];
  page: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
    nextOffset?: number;
  };
};

export async function listWorkflowRuns(
  workflowId: string,
  options: WorkflowRunListOptions = {},
): Promise<WorkflowRun[]> {
  const rows = await getStorage().repos.workflows.listRuns(workflowId, {
    status: options.status,
    limit: options.limit,
    offset: options.offset,
    includeContext: options.includeContext === true,
  });
  // List rows are display-only (runs API, list-workflow-runs tool).
  return rows.map((row) => rowToWorkflowRun(row, "display"));
}

export async function countWorkflowRuns(
  workflowId: string,
  options: Pick<WorkflowRunListOptions, "status"> = {},
): Promise<number> {
  return getStorage().repos.workflows.countRuns(workflowId, options.status || undefined);
}

export async function listWorkflowRunsPage(
  workflowId: string,
  options: Required<Pick<WorkflowRunListOptions, "limit" | "offset">> &
    Pick<WorkflowRunListOptions, "status" | "includeContext">,
): Promise<WorkflowRunPage> {
  const runs = await listWorkflowRuns(workflowId, options);
  const total = await countWorkflowRuns(workflowId, { status: options.status });
  const nextOffset = options.offset + runs.length;
  const hasMore = nextOffset < total;
  return {
    runs,
    page: {
      limit: options.limit,
      offset: options.offset,
      total,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
    },
  };
}

// ============================================================================
// Workflow Run Step CRUD
// ============================================================================

export async function createWorkflowRunStep(data: {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  input?: unknown;
  idempotencyKey?: string;
}): Promise<WorkflowRunStep> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.workflows.insertRunningStep({
    id: data.id,
    runId: data.runId,
    nodeId: data.nodeId,
    nodeType: data.nodeType,
    startedAt: now,
    input: data.input ? scrubJsonValue(data.input) : null,
    idempotencyKey: data.idempotencyKey ?? null,
  });
  if (!row) throw new Error("Failed to create workflow run step");
  return rowToWorkflowRunStep(row);
}

export async function getWorkflowRunStep(id: string): Promise<WorkflowRunStep | null> {
  const row = await getStorage().repos.workflows.findStepById(id);
  return row ? rowToWorkflowRunStep(row) : null;
}

export async function updateWorkflowRunStep(
  id: string,
  data: {
    status?: WorkflowRunStepStatus;
    output?: unknown;
    error?: string | null;
    finishedAt?: string;
    retryCount?: number;
    maxRetries?: number;
    nextRetryAt?: string | null;
    idempotencyKey?: string;
    diagnostics?: string;
    nextPort?: string;
  },
): Promise<WorkflowRunStep | null> {
  const workflows = getStorage().repos.workflows;
  const columns: WorkflowRunStepColumnUpdate = {};
  if (data.status !== undefined) columns.status = data.status;
  if (data.output !== undefined) {
    // Scrubbed for display; dedup, convergence and recovery replay the sealed
    // exact copy into downstream nodes.
    columns.output = scrubJsonValue(data.output);
    columns.output_replay = sealJson(data.output);
  }
  if (data.error !== undefined) {
    columns.error = data.error === null ? null : scrubSecrets(data.error);
  }
  if (data.finishedAt !== undefined) columns.finishedAt = data.finishedAt;
  if (data.retryCount !== undefined) columns.retryCount = data.retryCount;
  if (data.maxRetries !== undefined) columns.maxRetries = data.maxRetries;
  if (data.nextRetryAt !== undefined) columns.nextRetryAt = data.nextRetryAt;
  if (data.idempotencyKey !== undefined) columns.idempotencyKey = data.idempotencyKey;
  if (data.diagnostics !== undefined) columns.diagnostics = scrubSecrets(data.diagnostics);
  if (data.nextPort !== undefined) columns.nextPort = data.nextPort;
  const row =
    Object.keys(columns).length === 0
      ? await workflows.findStepById(id)
      : await workflows.updateStepColumns(id, columns);
  return row ? rowToWorkflowRunStep(row) : null;
}

export async function getWorkflowRunStepsByRunId(
  runId: string,
  view: WorkflowPayloadView = "replay",
): Promise<WorkflowRunStep[]> {
  const rows = await getStorage().repos.workflows.listSteps(runId);
  return rows.map((row) => rowToWorkflowRunStep(row, view));
}

// --- Stuck Workflow Run Recovery ---

export interface StuckWorkflowRun {
  runId: string;
  stepId: string;
  nodeId: string;
  taskId: string;
  taskStatus: string;
  taskOutput: string | null;
  workflowId: string;
}

export async function getStuckWorkflowRuns(): Promise<StuckWorkflowRun[]> {
  return getStorage().repos.workflows.listStuckRuns();
}

// --- New Workflow Query Functions ---

export async function getLastSuccessfulRun(workflowId: string): Promise<WorkflowRun | null> {
  const row = await getStorage().repos.workflows.lastSuccessfulRun(workflowId);
  return row ? rowToWorkflowRun(row) : null;
}

export async function getLastRunStart(workflowId: string): Promise<WorkflowRun | null> {
  const row = await getStorage().repos.workflows.lastRunStart(workflowId);
  return row ? rowToWorkflowRun(row) : null;
}

export async function getRetryableSteps(): Promise<WorkflowRunStep[]> {
  const now = new Date().toISOString();
  const rows = await getStorage().repos.workflows.listDueRetrySteps(now);
  return rows.map((row) => rowToWorkflowRunStep(row));
}

export async function getCompletedStepNodeIds(runId: string): Promise<string[]> {
  return getStorage().repos.workflows.listCompletedStepNodeIds(runId);
}

export async function getTaskByWorkflowRunStepId(stepId: string): Promise<AgentTask | null> {
  const row = await getStorage().repos.tasks.findTaskByWorkflowRunStepId(stepId);
  return row ? rowToAgentTask(row as AgentTaskRow) : null;
}

export async function detachTaskFromWorkflowRunStep(taskId: string): Promise<void> {
  await getStorage().repos.tasks.detachTaskFromWorkflowRunStep(taskId);
}

export async function getStepByIdempotencyKey(key: string): Promise<WorkflowRunStep | null> {
  const row = await getStorage().repos.workflows.findStepByIdempotencyKey(key);
  return row ? rowToWorkflowRunStep(row) : null;
}

export async function getStepCountForNode(runId: string, nodeId: string): Promise<number> {
  return getStorage().repos.workflows.countStepsForNode(runId, nodeId);
}

export async function getLatestStepForNode(
  runId: string,
  nodeId: string,
): Promise<WorkflowRunStep | null> {
  const row = await getStorage().repos.workflows.latestStepForNode(runId, nodeId);
  return row ? rowToWorkflowRunStep(row) : null;
}

/**
 * The node's latest step when it already covers the current predecessor
 * completions: it is running, waiting or completed, and no predecessor has
 * completed a step inserted after it. A loop iteration always has a newer
 * predecessor completion, so it never matches. Ordered by rowid, which
 * follows insert order; startedAt can tie within a millisecond.
 */
export async function getCurrentStepForNode(
  runId: string,
  nodeId: string,
  predecessorIds: string[],
): Promise<WorkflowRunStep | null> {
  const workflows = getStorage().repos.workflows;
  const row = await workflows.lastInsertedStepForNode(runId, nodeId);
  if (!row || !["running", "waiting", "completed"].includes(row.status)) return null;
  if (predecessorIds.length > 0) {
    if (await workflows.hasCompletedStepInsertedAfter(runId, predecessorIds, row.id)) return null;
  }
  return rowToWorkflowRunStep(row);
}

// --- Workflow Version History ---

function rowToWorkflowVersion(row: WorkflowVersionRow): WorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    snapshot: JSON.parse(row.snapshot) as WorkflowSnapshot,
    changedByAgentId: row.changedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

export async function createWorkflowVersion(data: {
  workflowId: string;
  version: number;
  snapshot: WorkflowSnapshot;
  changedByAgentId?: string;
}): Promise<WorkflowVersion> {
  const id = crypto.randomUUID();
  const row = await getStorage().repos.workflows.insertVersion({
    id,
    workflowId: data.workflowId,
    version: data.version,
    snapshot: JSON.stringify(data.snapshot),
    changedByAgentId: data.changedByAgentId ?? null,
  });
  if (!row) throw new Error("Failed to create workflow version");
  return rowToWorkflowVersion(row);
}

export async function getWorkflowVersions(workflowId: string): Promise<WorkflowVersion[]> {
  const rows = await getStorage().repos.workflows.listVersions(workflowId);
  return rows.map(rowToWorkflowVersion);
}

export async function getWorkflowVersion(
  workflowId: string,
  version: number,
): Promise<WorkflowVersion | null> {
  const row = await getStorage().repos.workflows.getVersion(workflowId, version);
  return row ? rowToWorkflowVersion(row) : null;
}

// --- App Version History ---

export type AppVersion = {
  id: string;
  appId: string;
  version: number;
  snapshot: unknown;
  changedByAgentId?: string;
  createdAt: string;
};

function rowToAppVersion(row: AppVersionRow): AppVersion {
  return {
    id: row.id,
    appId: row.appId,
    version: row.version,
    snapshot: JSON.parse(row.snapshot),
    changedByAgentId: row.changedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

export async function createAppVersion(data: {
  appId: string;
  version: number;
  snapshot: unknown;
  changedByAgentId?: string;
}): Promise<AppVersion> {
  const id = crypto.randomUUID();
  const row = await getStorage().repos.pages.insertAppVersion({
    id,
    appId: data.appId,
    version: data.version,
    snapshot: JSON.stringify(data.snapshot),
    changedByAgentId: data.changedByAgentId ?? null,
    createdAt: new Date().toISOString(),
  });
  if (!row) throw new Error("Failed to create app version");
  return rowToAppVersion(row);
}

export async function getAppVersions(appId: string): Promise<AppVersion[]> {
  const rows = await getStorage().repos.pages.listAppVersions(appId);
  return rows.map(rowToAppVersion);
}

export async function getAppVersion(appId: string, version: number): Promise<AppVersion | null> {
  const row = await getStorage().repos.pages.findAppVersion(appId, version);
  return row ? rowToAppVersion(row) : null;
}

// ============================================================================
// Pages CRUD + version history
// ----------------------------------------------------------------------------
// DB-backed lightweight artifacts. Mirrors the workflow versioning pattern:
// parent table `pages` holds the CURRENT state, history table `page_versions`
// holds pre-update snapshots. snapshotPage() (src/pages/version.ts) MUST be
// called BEFORE updatePage() so the snapshot freezes pre-update content.
// ============================================================================

function rowToPage(row: PageRow): Page {
  return {
    id: row.id,
    key: row.key,
    agentId: row.agentId,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    contentType: row.contentType as PageContentType,
    authMode: row.authMode as PageAuthMode,
    passwordHash: row.passwordHash ?? undefined,
    body: row.body,
    needsCredentials: row.needsCredentials
      ? (JSON.parse(row.needsCredentials) as string[])
      : undefined,
    theme: row.theme ?? null,
    themeTokens: parsePageThemeTokens(row.theme_tokens),
    designVersion: typeof row.design_version === "number" ? row.design_version : 1,
    viewCount: typeof row.view_count === "number" ? row.view_count : 0,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export async function createPage(data: {
  key?: string;
  agentId: string;
  slug: string;
  title: string;
  description?: string;
  contentType: PageContentType;
  authMode?: PageAuthMode;
  passwordHash?: string;
  body: string;
  needsCredentials?: string[];
  theme?: string | null;
  themeTokens?: Page["themeTokens"];
  /** Defaults to 2 (the swarm design system). Rows inserted outside this function default to 1. */
  designVersion?: number;
}): Promise<Page> {
  // Match the historical SQL default ID shape while making the value
  // available before insert so the default namespace can include it.
  const id = crypto.randomUUID().replace(/-/g, "");
  const row = await getStorage().repos.pages.insertPage({
    id,
    key: normalizeAssetKey(data.key ?? defaultAssetKey("page", id)),
    agentId: data.agentId,
    slug: data.slug,
    title: data.title,
    description: data.description ?? null,
    contentType: data.contentType,
    authMode: data.authMode ?? "authed",
    passwordHash: data.passwordHash ?? null,
    body: data.body,
    needsCredentials: data.needsCredentials ? JSON.stringify(data.needsCredentials) : null,
    theme: data.theme ?? null,
    theme_tokens: data.themeTokens ? JSON.stringify(data.themeTokens) : null,
    design_version: data.designVersion ?? 2,
  });
  if (!row) throw new Error("Failed to create page");
  return rowToPage(row);
}

export async function getPage(id: string): Promise<Page | null> {
  const row = await getStorage().repos.pages.findPage(id);
  return row ? rowToPage(row) : null;
}

export async function getPageBySlug(agentId: string, slug: string): Promise<Page | null> {
  const row = await getStorage().repos.pages.findPageBySlug(agentId, slug);
  return row ? rowToPage(row) : null;
}

export async function getLatestPageBySlug(slug: string): Promise<Page | null> {
  const row = await getStorage().repos.pages.findLatestPageBySlug(slug);
  return row ? rowToPage(row) : null;
}

/**
 * Slim list-row mapper — drops the page `body` (the full HTML/JSON document,
 * up to ~290 KB and ~95% of a list payload) and `passwordHash`. Fetch the
 * full page via `getPage(id)`.
 */
function rowToPageSummary(row: PageRow): PageSummary {
  return {
    id: row.id,
    key: row.key,
    agentId: row.agentId,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    contentType: row.contentType as PageContentType,
    authMode: row.authMode as PageAuthMode,
    needsCredentials: row.needsCredentials
      ? (JSON.parse(row.needsCredentials) as string[])
      : undefined,
    viewCount: typeof row.view_count === "number" ? row.view_count : 0,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export interface PageListOptions {
  slim?: boolean;
  key?: string;
  keyPrefix?: string;
  /** Matches the title, slug or description anywhere, case-insensitive. */
  q?: string;
}

export function listPagesByAgent(agentId: string, limit?: number, offset?: number): Promise<Page[]>;
export function listPagesByAgent(
  agentId: string,
  limit: number | undefined,
  offset: number | undefined,
  opts: PageListOptions & { slim?: false },
): Promise<Page[]>;
export function listPagesByAgent(
  agentId: string,
  limit: number | undefined,
  offset: number | undefined,
  opts: PageListOptions & { slim: true },
): Promise<PageSummary[]>;
export async function listPagesByAgent(
  agentId: string,
  limit = 100,
  offset = 0,
  opts?: PageListOptions,
): Promise<Page[] | PageSummary[]> {
  const rows = await getStorage().repos.pages.listPages(pageFilter(opts, agentId), limit, offset);
  return opts?.slim ? rows.map(rowToPageSummary) : rows.map(rowToPage);
}

export function listAllPages(limit?: number, offset?: number): Promise<Page[]>;
export function listAllPages(
  limit: number | undefined,
  offset: number | undefined,
  opts: PageListOptions & { slim?: false },
): Promise<Page[]>;
export function listAllPages(
  limit: number | undefined,
  offset: number | undefined,
  opts: PageListOptions & { slim: true },
): Promise<PageSummary[]>;
export async function listAllPages(
  limit = 100,
  offset = 0,
  opts?: PageListOptions,
): Promise<Page[] | PageSummary[]> {
  const rows = await getStorage().repos.pages.listPages(pageFilter(opts), limit, offset);
  return opts?.slim ? rows.map(rowToPageSummary) : rows.map(rowToPage);
}

/**
 * Total page count — used to back a filter-aware `total` in the `/api/pages`
 * pager so the UI shows the real count, not just the current page's length.
 */
export async function countAllPages(
  filters?: Pick<PageListOptions, "key" | "keyPrefix" | "q">,
): Promise<number> {
  return await getStorage().repos.pages.countPages(pageFilter(filters));
}

/** Page count scoped to a single agent — companion to `listPagesByAgent`. */
export async function countPagesByAgent(
  agentId: string,
  filters?: Pick<PageListOptions, "key" | "keyPrefix" | "q">,
): Promise<number> {
  return await getStorage().repos.pages.countPages(pageFilter(filters, agentId));
}

/**
 * Apply a patch to a page. Does NOT snapshot — caller must invoke
 * `snapshotPage(id, agentId)` BEFORE calling this to preserve pre-update
 * state (mirrors the workflow update pattern at src/http/workflows.ts:483).
 *
 * Always bumps `updatedAt` even if no other field changed (keeps the index
 * useful for list ordering).
 */
export async function updatePage(
  id: string,
  data: {
    key?: string;
    title?: string;
    description?: string | null;
    contentType?: PageContentType;
    authMode?: PageAuthMode;
    passwordHash?: string | null;
    body?: string;
    needsCredentials?: string[] | null;
    slug?: string;
    /** undefined keeps the stored value, null clears it. */
    theme?: string | null;
    /** undefined keeps the stored value, null clears it. */
    themeTokens?: Page["themeTokens"];
    designVersion?: number;
  },
): Promise<Page | null> {
  const update: PageColumnUpdate = {
    key: data.key === undefined ? undefined : normalizeAssetKey(data.key),
    title: data.title,
    description: data.description === undefined ? undefined : (data.description ?? null),
    contentType: data.contentType,
    authMode: data.authMode,
    passwordHash: data.passwordHash === undefined ? undefined : (data.passwordHash ?? null),
    body: data.body,
    needsCredentials:
      data.needsCredentials === undefined
        ? undefined
        : data.needsCredentials
          ? JSON.stringify(data.needsCredentials)
          : null,
    slug: data.slug,
    theme: data.theme,
    theme_tokens:
      data.themeTokens === undefined
        ? undefined
        : data.themeTokens
          ? JSON.stringify(data.themeTokens)
          : null,
    design_version: data.designVersion,
  };
  if (Object.values(update).every((value) => value === undefined)) return getPage(id);
  const row = await getStorage().repos.pages.updatePage(id, update, new Date().toISOString());
  return row ? rowToPage(row) : null;
}

export async function deletePage(id: string): Promise<boolean> {
  const storage = getStorage();
  const changes = await storage.transaction(async () => {
    // Drops every user's favorite and the page's `task:page:<id>` kv namespace with it.
    const deleted = await storage.repos.pages.deletePageCascade(id);
    if (deleted > 0) {
      storage.afterCommit(() => realtimeBus.publish("room:namespace-deleted", `task:page:${id}`));
    }
    return deleted;
  });
  return changes > 0;
}

/**
 * Bump the `view_count` counter on a page by 1. Called from `pages-public.ts`
 * on every successful 200 from `GET /p/:id` (HTML inline serve) and
 * `GET /p/:id.json` (JSON metadata fetch). No-op when the page doesn't
 * exist — caller already guards on `getPage(id)` before reaching the bump
 * path, so this only fires for valid ids. Wrapped in try/catch by the
 * caller so an unexpected DB error never breaks page serving.
 */
export async function incrementPageViewCount(id: string): Promise<boolean> {
  return (await getStorage().repos.pages.incrementPageViewCount(id)) > 0;
}

function rowToPageVersion(row: PageVersionRow): PageVersion {
  return {
    id: row.id,
    pageId: row.pageId,
    version: row.version,
    snapshot: JSON.parse(row.snapshot) as PageSnapshot,
    changedByAgentId: row.changedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

export async function createPageVersion(data: {
  pageId: string;
  version: number;
  snapshot: PageSnapshot;
  changedByAgentId?: string;
}): Promise<PageVersion> {
  const row = await getStorage().repos.pages.insertPageVersion({
    pageId: data.pageId,
    version: data.version,
    snapshot: JSON.stringify(data.snapshot),
    changedByAgentId: data.changedByAgentId ?? null,
  });
  if (!row) throw new Error("Failed to create page version");
  return rowToPageVersion(row);
}

export async function getPageVersions(pageId: string): Promise<PageVersion[]> {
  const rows = await getStorage().repos.pages.listPageVersions(pageId);
  return rows.map(rowToPageVersion);
}

export async function getPageVersion(pageId: string, version: number): Promise<PageVersion | null> {
  const row = await getStorage().repos.pages.findPageVersion(pageId, version);
  return row ? rowToPageVersion(row) : null;
}

// ============================================================================
// Metrics CRUD + version history
// ----------------------------------------------------------------------------
// Config-driven metrics mirror Pages: parent table `metrics` holds the current
// JSON definition, and `metric_versions` holds pre-update snapshots.
// ============================================================================

function rowToMetric(row: MetricRow): Metric {
  return {
    id: row.id,
    agentId: row.agentId,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    definition: JSON.parse(row.definition) as MetricDefinition,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

function rowToMetricSummary(row: MetricRow): MetricSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export async function createMetric(data: {
  agentId: string;
  slug: string;
  title: string;
  description?: string;
  definition: MetricDefinition;
}): Promise<Metric> {
  const row = await getStorage().repos.pages.insertMetric({
    agentId: data.agentId,
    slug: data.slug,
    title: data.title,
    description: data.description ?? null,
    definition: JSON.stringify(data.definition),
  });
  if (!row) throw new Error("Failed to create metric");
  return rowToMetric(row);
}

export async function getMetric(id: string): Promise<Metric | null> {
  const row = await getStorage().repos.pages.findMetric(id);
  return row ? rowToMetric(row) : null;
}

export async function getMetricBySlug(agentId: string, slug: string): Promise<Metric | null> {
  const row = await getStorage().repos.pages.findMetricBySlug(agentId, slug);
  return row ? rowToMetric(row) : null;
}

export async function listMetricsByAgent(
  agentId: string,
  limit?: number,
  offset?: number,
): Promise<Metric[]>;
export async function listMetricsByAgent(
  agentId: string,
  limit: number | undefined,
  offset: number | undefined,
  opts: { slim: true },
): Promise<MetricSummary[]>;
export async function listMetricsByAgent(
  agentId: string,
  limit = 100,
  offset = 0,
  opts?: { slim?: boolean },
): Promise<Metric[] | MetricSummary[]> {
  const rows = await getStorage().repos.pages.listMetrics(agentId, limit, offset);
  return opts?.slim ? rows.map(rowToMetricSummary) : rows.map(rowToMetric);
}

export async function listAllMetrics(limit?: number, offset?: number): Promise<Metric[]>;
export async function listAllMetrics(
  limit: number | undefined,
  offset: number | undefined,
  opts: { slim: true },
): Promise<MetricSummary[]>;
export async function listAllMetrics(
  limit = 100,
  offset = 0,
  opts?: { slim?: boolean },
): Promise<Metric[] | MetricSummary[]> {
  const rows = await getStorage().repos.pages.listMetrics(null, limit, offset);
  return opts?.slim ? rows.map(rowToMetricSummary) : rows.map(rowToMetric);
}

export async function countAllMetrics(): Promise<number> {
  return await getStorage().repos.pages.countMetrics(null);
}

export async function countMetricsByAgent(agentId: string): Promise<number> {
  return await getStorage().repos.pages.countMetrics(agentId);
}

export async function updateMetric(
  id: string,
  data: {
    title?: string;
    description?: string | null;
    definition?: MetricDefinition;
    slug?: string;
  },
): Promise<Metric | null> {
  const update: MetricColumnUpdate = {
    title: data.title,
    description: data.description === undefined ? undefined : (data.description ?? null),
    definition: data.definition === undefined ? undefined : JSON.stringify(data.definition),
    slug: data.slug,
  };
  if (Object.values(update).every((value) => value === undefined)) return getMetric(id);
  const row = await getStorage().repos.pages.updateMetric(id, update, new Date().toISOString());
  return row ? rowToMetric(row) : null;
}

export async function deleteMetric(id: string): Promise<boolean> {
  return (await getStorage().repos.pages.deleteMetric(id)) > 0;
}

function rowToMetricVersion(row: MetricVersionRow): MetricVersion {
  return {
    id: row.id,
    metricId: row.metricId,
    version: row.version,
    snapshot: JSON.parse(row.snapshot) as MetricSnapshot,
    changedByAgentId: row.changedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

export async function createMetricVersion(data: {
  metricId: string;
  version: number;
  snapshot: MetricSnapshot;
  changedByAgentId?: string;
}): Promise<MetricVersion> {
  const row = await getStorage().repos.pages.insertMetricVersion({
    metricId: data.metricId,
    version: data.version,
    snapshot: JSON.stringify(data.snapshot),
    changedByAgentId: data.changedByAgentId ?? null,
  });
  if (!row) throw new Error("Failed to create metric version");
  return rowToMetricVersion(row);
}

export async function getMetricVersions(metricId: string): Promise<MetricVersion[]> {
  const rows = await getStorage().repos.pages.listMetricVersions(metricId);
  return rows.map(rowToMetricVersion);
}

export async function getMetricVersion(
  metricId: string,
  version: number,
): Promise<MetricVersion | null> {
  const row = await getStorage().repos.pages.findMetricVersion(metricId, version);
  return row ? rowToMetricVersion(row) : null;
}

// ============================================================================
// Prompt Template Operations
// ============================================================================

type PromptTemplateHistoryRow = {
  id: string;
  templateId: string;
  version: number;
  body: string;
  state: string;
  changedBy: string | null;
  changedAt: string;
  changeReason: string | null;
};

function rowToPromptTemplateHistory(row: PromptTemplateHistoryRow): PromptTemplateHistory {
  return {
    id: row.id,
    templateId: row.templateId,
    version: row.version,
    body: row.body,
    state: row.state,
    changedBy: row.changedBy ?? null,
    changedAt: row.changedAt,
    changeReason: row.changeReason ?? null,
  };
}

/**
 * List prompt templates with optional filters.
 */
export async function getPromptTemplates(filters?: {
  eventType?: string;
  scope?: string;
  scopeId?: string;
  isDefault?: boolean;
}): Promise<PromptTemplate[]> {
  const rows = await getStorage().repos.promptTemplates.listPromptTemplates(filters ?? {});
  return rows.map(rowToPromptTemplate);
}

/**
 * Get a single prompt template by ID.
 */
export async function getPromptTemplateById(id: string): Promise<PromptTemplate | null> {
  const row = await getStorage().repos.promptTemplates.findPromptTemplate(id);
  return row ? rowToPromptTemplate(row) : null;
}

/**
 * Upsert a prompt template. Inserts or updates by (eventType, scope, scopeId) unique constraint.
 * Creates a history entry on both insert and update.
 */
export async function upsertPromptTemplate(data: PromptTemplateUpsert): Promise<PromptTemplate> {
  const now = new Date().toISOString();
  const scopeId = data.scope === "global" ? null : (data.scopeId ?? null);
  const state = data.state ?? "enabled";
  const changedBy = data.changedBy ?? data.createdBy ?? null;
  const changeReason = data.changeReason ?? null;

  // One transaction around the existence check and both writes: the
  // synchronous version ran them without yielding the event loop.
  const storage = getStorage();
  const templates = storage.repos.promptTemplates;
  const row = await storage.transaction(async () => {
    // Manual check for existing entry because SQLite's UNIQUE constraint
    // treats NULL != NULL, so ON CONFLICT never fires when scopeId is NULL (global scope).
    const existing = await templates.findPromptTemplateAtScope(data.eventType, data.scope, scopeId);

    if (existing) {
      // If upserting at global scope and existing record has isDefault=true, flip it to false
      const newIsDefault =
        data.scope === "global" && existing.isDefault === 1 ? false : existing.isDefault === 1;
      const newVersion = existing.version + 1;

      const updated = await templates.updatePromptTemplateRecord(existing.id, {
        body: data.body,
        state,
        isDefault: newIsDefault,
        version: newVersion,
        updatedAt: now,
      });

      // Create history entry for the update
      await templates.insertPromptTemplateHistory({
        id: crypto.randomUUID(),
        templateId: existing.id,
        version: newVersion,
        body: data.body,
        state,
        changedBy,
        changedAt: now,
        changeReason,
      });
      return updated;
    }

    const created = newPromptTemplateRows(data, scopeId, now);
    const inserted = await templates.insertPromptTemplate(created.row);
    // Create history entry for the insert
    await templates.insertPromptTemplateHistory(created.history);
    return inserted;
  });

  if (!row) throw new Error("Failed to upsert prompt template");
  return rowToPromptTemplate(row);
}

/**
 * Delete a prompt template by ID. Guards against deleting default templates.
 * Does NOT delete history rows (intentional for audit trail).
 */
export async function deletePromptTemplate(id: string): Promise<boolean> {
  const existing = await getStorage().repos.promptTemplates.findPromptTemplate(id);

  if (!existing) return false;
  if (existing.isDefault === 1) {
    throw new Error(
      "Cannot delete a default prompt template. Use resetPromptTemplateToDefault instead.",
    );
  }

  return (await getStorage().repos.promptTemplates.deletePromptTemplate(id)) > 0;
}

/**
 * Reset a prompt template to its default state.
 * Sets body to defaultBody, isDefault=true, state='enabled', bumps version.
 */
export async function resetPromptTemplateToDefault(
  id: string,
  defaultBody: string,
): Promise<PromptTemplate> {
  const now = new Date().toISOString();
  // One transaction: the synchronous version read and wrote without yielding.
  const storage = getStorage();
  const templates = storage.repos.promptTemplates;
  const row = await storage.transaction(async () => {
    const existing = await templates.findPromptTemplate(id);
    if (!existing) throw new Error(`Prompt template ${id} not found`);

    const reset = resetPromptTemplateRows(id, existing.version, defaultBody, now);
    const updated = await templates.updatePromptTemplateRecord(id, reset.update);
    if (!updated) throw new Error("Failed to reset prompt template to default");

    // Create history entry
    await templates.insertPromptTemplateHistory(reset.history);
    return updated;
  });

  return rowToPromptTemplate(row);
}

/**
 * Get version history for a prompt template, ordered by version DESC.
 */
export async function getPromptTemplateHistory(
  templateId: string,
): Promise<PromptTemplateHistory[]> {
  const rows = await getStorage().repos.promptTemplates.listPromptTemplateHistory(templateId);
  return rows.map(rowToPromptTemplateHistory);
}

/**
 * Resolve the best prompt template for a given eventType using scope precedence.
 *
 * Two-pass resolution:
 *   Pass 1 (exact match): Try exact eventType at agent → repo → global scope.
 *   Pass 2 (wildcard): Generate wildcards from eventType (e.g. "github.pull_request.*", "github.*")
 *     and try each at agent → repo → global scope.
 *
 * Exact match at ANY scope always beats wildcard at ANY scope.
 *
 * State behavior:
 *   - 'enabled': return the template
 *   - 'skip_event': return { skip: true }
 *   - 'default_prompt_fallback': continue to next scope level
 */
export async function resolvePromptTemplate(
  eventType: string,
  agentId?: string,
  repoId?: string,
): Promise<{ template: PromptTemplate } | { skip: true } | null> {
  const templates = getStorage().repos.promptTemplates;

  // Try resolution at the scope chain for a given eventType string
  const tryResolve = async (
    et: string,
  ): Promise<{ template: PromptTemplate } | { skip: true } | "continue"> => {
    // Build scope chain: agent → repo → global
    const scopeChain: Array<{ scope: "global" | "agent" | "repo"; scopeId: string | null }> = [];
    if (agentId) scopeChain.push({ scope: "agent", scopeId: agentId });
    if (repoId) scopeChain.push({ scope: "repo", scopeId: repoId });
    scopeChain.push({ scope: "global", scopeId: null });

    for (const { scope, scopeId } of scopeChain) {
      const row = await templates.findPromptTemplateAtScope(et, scope, scopeId);
      if (!row) continue;

      if (row.state === "enabled") {
        return { template: rowToPromptTemplate(row) };
      }
      if (row.state === "skip_event") {
        return { skip: true };
      }
      // default_prompt_fallback: continue to next scope
    }

    return "continue";
  };

  // Pass 1: exact match
  const exactResult = await tryResolve(eventType);
  if (exactResult !== "continue") return exactResult;

  // Pass 2: wildcard matching
  // e.g. "github.pull_request.review_submitted" → ["github.pull_request.*", "github.*"]
  const parts = eventType.split(".");
  const wildcards: string[] = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    wildcards.push(`${parts.slice(0, i).join(".")}.*`);
  }

  for (const wildcard of wildcards) {
    const wildcardResult = await tryResolve(wildcard);
    if (wildcardResult !== "continue") return wildcardResult;
  }

  return null;
}

/**
 * Checkout a prompt template to a specific version from history.
 * Copies body and state from the history entry into the live record, bumps version.
 */
export async function checkoutPromptTemplate(
  id: string,
  targetVersion: number,
): Promise<PromptTemplate> {
  const now = new Date().toISOString();

  // One transaction around read, version computation and both writes. A
  // concurrent upsert (or a second checkout) between the read and the UPDATE
  // would otherwise reuse the same `existing.version + 1`, leaving two
  // prompt_template_history rows at one version (no UNIQUE on
  // (templateId, version)) so a later checkout restores whichever body the
  // index scan reaches first.
  const storage = getStorage();
  const templates = storage.repos.promptTemplates;
  const row = await storage.transaction(async () => {
    const existing = await templates.findPromptTemplate(id);
    if (!existing) throw new Error(`Prompt template ${id} not found`);

    const historyEntry = await templates.findPromptTemplateHistoryVersion(id, targetVersion);
    if (!historyEntry)
      throw new Error(`No history entry at version ${targetVersion} for template ${id}`);

    const newVersion = existing.version + 1;

    const updated = await templates.setPromptTemplateContent(id, {
      body: historyEntry.body,
      state: historyEntry.state,
      version: newVersion,
      updatedAt: now,
    });

    if (!updated) throw new Error("Failed to checkout prompt template");

    // Create history entry for the checkout
    await templates.insertPromptTemplateHistory({
      id: crypto.randomUUID(),
      templateId: id,
      version: newVersion,
      body: historyEntry.body,
      state: historyEntry.state,
      changedBy: null,
      changedAt: now,
      changeReason: `Checked out from version ${targetVersion}`,
    });

    return updated;
  });

  return rowToPromptTemplate(row);
}

// ─── Channel Activity Cursors ─────────────────────────────────────────────────

export interface ChannelActivityCursor {
  channelId: string;
  lastSeenTs: string;
  updatedAt: string;
}

function rowToChannelActivityCursor(row: ChannelActivityCursorRow): ChannelActivityCursor {
  return {
    channelId: row.channelId,
    lastSeenTs: row.lastSeenTs,
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export async function getAllChannelActivityCursors(): Promise<ChannelActivityCursor[]> {
  const rows = await getStorage().repos.messaging.listChannelActivityCursors();
  return rows.map(rowToChannelActivityCursor);
}

export async function getChannelActivityCursor(
  channelId: string,
): Promise<ChannelActivityCursor | null> {
  const row = await getStorage().repos.messaging.findChannelActivityCursor(channelId);
  return row ? rowToChannelActivityCursor(row) : null;
}

export async function upsertChannelActivityCursor(
  channelId: string,
  lastSeenTs: string,
): Promise<void> {
  await getStorage().repos.messaging.upsertChannelActivityCursor(channelId, lastSeenTs);
}

// ============================================================================
// Approval Requests
// ============================================================================

export interface ApprovalRequest {
  id: string;
  title: string;
  questions: unknown[];
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  sourceTaskId: string | null;
  approvers: unknown;
  status: "pending" | "approved" | "rejected" | "timeout" | "cancelled";
  responses: unknown | null;
  approvals: ApprovalVote[] | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  notificationChannels: unknown[] | null;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

type ApprovalRequestRow = NonNullable<Awaited<ReturnType<WorkflowsRepo["findApprovalById"]>>>;

function rowToApprovalRequest(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    title: row.title,
    questions: JSON.parse(row.questions),
    workflowRunId: row.workflowRunId,
    workflowRunStepId: row.workflowRunStepId,
    sourceTaskId: row.sourceTaskId,
    approvers: JSON.parse(row.approvers),
    status: row.status as ApprovalRequest["status"],
    // Sealed at rest: workflow recovery and HITL resume read the exact answer.
    responses: row.responses ? openSealedJson(row.responses) : null,
    approvals: row.approvals ? JSON.parse(row.approvals) : null,
    resolvedBy: row.resolvedBy,
    resolvedAt: normalizeDate(row.resolvedAt),
    resolutionReason: row.resolutionReason,
    timeoutSeconds: row.timeoutSeconds,
    expiresAt: normalizeDate(row.expiresAt),
    notificationChannels: row.notificationChannels ? JSON.parse(row.notificationChannels) : null,
    createdBy: row.created_by ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export async function createApprovalRequest(data: {
  id: string;
  title: string;
  questions: unknown[];
  approvers: unknown;
  workflowRunId?: string;
  workflowRunStepId?: string;
  sourceTaskId?: string;
  timeoutSeconds?: number;
  notificationChannels?: unknown[];
  createdBy?: string;
  requireActionableWorkflow?: boolean;
}): Promise<ApprovalRequest> {
  const now = new Date().toISOString();
  const expiresAt = data.timeoutSeconds
    ? new Date(Date.now() + data.timeoutSeconds * 1000).toISOString()
    : null;

  const row = await getStorage().transaction(async () => {
    let status: ApprovalRequest["status"] = "pending";
    let resolutionReason: string | null = null;
    // A request linked to an existing run, with or without a step, is born
    // cancelled unless the run is live and its tree is not cancelled: a
    // pending request in a cancelled tree would be open work no cancel may
    // leave behind. A missing run is refused only on the workflow (HITL) path.
    const actionable = data.requireActionableWorkflow && data.workflowRunStepId;
    const run = data.workflowRunId ? await getWorkflowRun(data.workflowRunId, "display") : null;
    if (data.workflowRunId && (run || actionable)) {
      const step = actionable ? await getWorkflowRunStep(data.workflowRunStepId!) : undefined;
      if (!run || (run.status !== "running" && run.status !== "waiting")) {
        status = "cancelled";
        resolutionReason = run?.error ?? `Workflow run is ${run?.status ?? "missing"}`;
      } else if (
        step !== undefined &&
        (!step || step.runId !== run.id || step.status !== "running")
      ) {
        status = "cancelled";
        resolutionReason = `Human-in-the-loop step is ${step?.status ?? "missing"}`;
      } else {
        const blocked = await getRunLineageBlock(run.id);
        if (blocked) {
          status = "cancelled";
          resolutionReason = blocked;
        }
      }
    }

    return getStorage().repos.workflows.insertApproval({
      id: data.id,
      title: scrubSecrets(data.title),
      questions: scrubJsonValue(data.questions),
      workflowRunId: data.workflowRunId ?? null,
      workflowRunStepId: data.workflowRunStepId ?? null,
      sourceTaskId: data.sourceTaskId ?? null,
      approvers: JSON.stringify(data.approvers),
      status,
      resolutionReason: resolutionReason == null ? null : scrubSecrets(resolutionReason),
      resolvedAt: status === "cancelled" ? now : null,
      timeoutSeconds: data.timeoutSeconds ?? null,
      expiresAt,
      notificationChannels: data.notificationChannels
        ? JSON.stringify(data.notificationChannels)
        : null,
      createdBy: data.createdBy ?? null,
      now,
    });
  });

  return rowToApprovalRequest(row!);
}

export async function getApprovalRequestById(id: string): Promise<ApprovalRequest | null> {
  const row = await getStorage().repos.workflows.findApprovalById(id);
  return row ? rowToApprovalRequest(row) : null;
}

export async function resolveApprovalRequest(
  id: string,
  data: {
    status: "approved" | "rejected" | "timeout";
    responses?: unknown;
    approvals?: ApprovalVote[];
    resolvedBy?: string;
    resolutionReason?: string;
  },
  options?: { requireActionableWorkflow?: boolean },
): Promise<ApprovalRequest | null> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.workflows.resolveApproval(
    id,
    {
      status: data.status,
      // Sealed, not scrubbed: recovery resumes the workflow from this answer,
      // so it must stay byte-exact. Votes are diagnostic and get redacted.
      responses: data.responses ? sealJson(data.responses) : null,
      approvals: data.approvals ? scrubApprovalVotesJson(data.approvals) : null,
      resolvedBy: data.resolvedBy ?? null,
      resolutionReason: data.resolutionReason == null ? null : scrubSecrets(data.resolutionReason),
      now,
    },
    options?.requireActionableWorkflow === true,
  );
  if (!row) return null;
  const resolved = rowToApprovalRequest(row);
  scheduleApprovalCardUpdates([resolved]);
  return resolved;
}

// Cancels 1 pending request. The `status = 'pending'` guard lets a concurrent
// human answer win; null means the row was not pending.
export async function cancelApprovalRequestById(
  id: string,
  data: { reason: string; resolvedBy: string | null },
): Promise<ApprovalRequest | null> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.workflows.cancelApproval(
    id,
    scrubSecrets(data.reason),
    data.resolvedBy,
    now,
  );
  if (!row) return null;
  const cancelled = rowToApprovalRequest(row);
  scheduleApprovalCardUpdates([cancelled]);
  return cancelled;
}

export async function cancelPendingApprovalRequestsForRun(
  workflowRunId: string,
  reason: string,
): Promise<ApprovalRequest[]> {
  const now = new Date().toISOString();
  const rows = await getStorage().repos.workflows.cancelPendingApprovalsOfRun(
    workflowRunId,
    scrubSecrets(reason),
    now,
  );
  const cancelled = rows.map(rowToApprovalRequest);
  scheduleApprovalCardUpdates(cancelled);
  return cancelled;
}

export async function listCancelledApprovalRequestsForRun(
  workflowRunId: string,
): Promise<ApprovalRequest[]> {
  const rows = await getStorage().repos.workflows.listCancelledApprovalsOfRun(workflowRunId);
  return rows.map(rowToApprovalRequest);
}

export async function listCancelledApprovalRequestsForStep(
  workflowRunStepId: string,
): Promise<ApprovalRequest[]> {
  const rows = await getStorage().repos.workflows.listCancelledApprovalsOfStep(workflowRunStepId);
  return rows.map(rowToApprovalRequest);
}

/**
 * Lease one Slack side effect of a settled request. `cancellationNotificationClaims`
 * holds every such claim: the cancellation thread reply (`<channel>:<ts>`) and the
 * in-place card edit (`card:<channel>:<ts>`), so a retry never repeats a delivered one.
 * `anyTerminal` claims on every terminal status, not only `cancelled`.
 */
export async function claimApprovalCancellationNotification(
  id: string,
  notificationKey: string,
  options?: { anyTerminal?: boolean },
): Promise<{ approval: ApprovalRequest; leaseToken: string } | null> {
  const anyTerminal = options?.anyTerminal === true;
  const workflows = getStorage().repos.workflows;
  return getStorage().transaction(async () => {
    const row = await workflows.findSettledApproval(id, anyTerminal);
    if (!row) return null;
    const claims = row.cancellationNotificationClaims
      ? (JSON.parse(row.cancellationNotificationClaims) as Record<
          string,
          "delivered" | { claimedAt: string; leaseToken: string }
        >)
      : {};
    const existing = claims[notificationKey];
    if (existing === "delivered") return null;
    if (
      existing &&
      typeof existing !== "string" &&
      Date.now() - new Date(existing.claimedAt).getTime() < 60_000
    ) {
      return null;
    }

    const now = new Date().toISOString();
    const leaseToken = crypto.randomUUID();
    claims[notificationKey] = { claimedAt: now, leaseToken };
    await workflows.setApprovalNotificationClaims(id, JSON.stringify(claims), now, anyTerminal);
    return { approval: rowToApprovalRequest(row), leaseToken };
  });
}

export async function completeApprovalCancellationNotificationClaim(
  id: string,
  notificationKey: string,
  leaseToken: string,
): Promise<void> {
  await updateApprovalCancellationNotificationClaim(id, notificationKey, leaseToken, "delivered");
}

export async function releaseApprovalCancellationNotificationClaim(
  id: string,
  notificationKey: string,
  leaseToken: string,
): Promise<void> {
  await updateApprovalCancellationNotificationClaim(id, notificationKey, leaseToken, null);
}

async function updateApprovalCancellationNotificationClaim(
  id: string,
  notificationKey: string,
  leaseToken: string,
  value: "delivered" | null,
): Promise<void> {
  const workflows = getStorage().repos.workflows;
  await getStorage().transaction(async () => {
    const row = await workflows.getApprovalNotificationClaims(id);
    const claims = row?.claims
      ? (JSON.parse(row.claims) as Record<
          string,
          "delivered" | { claimedAt: string; leaseToken: string }
        >)
      : {};
    const current = claims[notificationKey];
    if (!current || typeof current === "string" || current.leaseToken !== leaseToken) {
      return;
    }
    if (value === null) delete claims[notificationKey];
    else claims[notificationKey] = value;
    await workflows.setApprovalNotificationClaims(
      id,
      JSON.stringify(claims),
      new Date().toISOString(),
      true,
    );
  });
}

export async function updateApprovalRequestNotifications(
  id: string,
  notificationChannels: Array<{ channel: string; target: string; messageTs?: string }>,
): Promise<void> {
  const now = new Date().toISOString();
  await getStorage().repos.workflows.setApprovalNotificationChannels(
    id,
    JSON.stringify(notificationChannels),
    now,
  );
}

export async function listApprovalRequests(
  filters?: ApprovalRequestListFilters,
): Promise<ApprovalRequest[]> {
  const rows = await getStorage().repos.workflows.listApprovals(approvalListFilter(filters));
  return rows.map(rowToApprovalRequest);
}

export interface StuckApprovalRun {
  runId: string;
  stepId: string;
  nodeId: string;
  workflowId: string;
  approvalId: string;
  approvalStatus: string;
  approvalResponses: string | null;
  expiresAt: string | null;
}

export async function getStuckApprovalRuns(): Promise<StuckApprovalRun[]> {
  const rows = await getStorage().repos.workflows.listStuckApprovalRuns();
  return rows.map((row) => ({
    ...row,
    approvalResponses:
      row.approvalResponses === null ? null : JSON.stringify(openSealedJson(row.approvalResponses)),
  }));
}

export async function getApprovalRequestByStepId(stepId: string): Promise<ApprovalRequest | null> {
  const row = await getStorage().repos.workflows.findApprovalByStepId(stepId);
  return row ? rowToApprovalRequest(row) : null;
}

// Called by timeoutExpiredApprovalRequests in src/be/approval-sweeps.ts on each heartbeat tick.
export async function getExpiredPendingApprovals(opts?: {
  now?: string;
}): Promise<ApprovalRequest[]> {
  const rows = await getStorage().repos.workflows.listExpiredPendingApprovals(
    opts?.now ?? new Date().toISOString(),
  );
  return rows.map(rowToApprovalRequest);
}

// Pending requests with no explicit deadline created before `cutoff`. Served
// by idx_approval_requests_pending_created (migration 166). Called by
// autoCancelStaleApprovalRequests in src/be/approval-sweeps.ts.
export async function getStaleApprovalRequests(opts: {
  cutoff: string;
}): Promise<ApprovalRequest[]> {
  const rows = await getStorage().repos.workflows.listStalePendingApprovals(opts.cutoff);
  return rows.map(rowToApprovalRequest);
}

// ============================================================================
// Wait States (workflow `wait` node side table)
// ============================================================================
//
// Mirrors approval-request helpers above. Time-mode rows carry `wakeUpAt`;
// event-mode rows carry `eventName` + optional `eventFilter` (object or
// arrow-fn body string) and optional `expiresAt`. `resolveWaitState` is the
// race-safe transition gate — concurrent callers (poller + bus listener)
// rely on `WHERE status='pending'` so only the first one wins.

type WaitStateRowDb = NonNullable<Awaited<ReturnType<WorkflowsRepo["findWaitStateById"]>>>;

function rowToWaitState(row: WaitStateRowDb): WaitStateRow {
  let parsedFilter: WaitStateRow["eventFilter"] = null;
  if (row.eventFilter !== null) {
    // eventFilter is stored as JSON: either an object or a JSON-encoded string.
    try {
      const decoded = JSON.parse(row.eventFilter);
      // Accept both shapes — string filter (arrow-fn body) or object filter.
      if (typeof decoded === "string" || (typeof decoded === "object" && decoded !== null)) {
        parsedFilter = decoded as WaitStateRow["eventFilter"];
      }
    } catch {
      parsedFilter = null;
    }
  }
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    workflowRunStepId: row.workflowRunStepId,
    mode: row.mode as WaitMode,
    wakeUpAt: normalizeDate(row.wakeUpAt),
    eventName: row.eventName,
    eventFilter: parsedFilter,
    expiresAt: normalizeDate(row.expiresAt),
    status: row.status as WaitStateStatus,
    firedPayload: row.firedPayload ? JSON.parse(row.firedPayload) : null,
    resolvedAt: normalizeDate(row.resolvedAt),
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
    eventScope: (row.eventScope as "run" | "global") ?? "run",
  };
}

export interface CreateWaitStateInput {
  id: string;
  workflowRunId: string;
  workflowRunStepId: string;
  mode: WaitMode;
  wakeUpAt?: string | null;
  eventName?: string | null;
  eventFilter?: Record<string, unknown> | string | null;
  expiresAt?: string | null;
  scope?: "run" | "global";
}

export async function createWaitState(input: CreateWaitStateInput): Promise<WaitStateRow> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.workflows.insertWaitState({
    id: input.id,
    workflowRunId: input.workflowRunId,
    workflowRunStepId: input.workflowRunStepId,
    mode: input.mode,
    wakeUpAt: input.wakeUpAt ?? null,
    eventName: input.eventName ?? null,
    eventFilter:
      input.eventFilter !== undefined && input.eventFilter !== null
        ? JSON.stringify(input.eventFilter)
        : null,
    expiresAt: input.expiresAt ?? null,
    eventScope: input.scope ?? "run",
    now,
  });
  return rowToWaitState(row!);
}

export async function getWaitStateById(id: string): Promise<WaitStateRow | null> {
  const row = await getStorage().repos.workflows.findWaitStateById(id);
  return row ? rowToWaitState(row) : null;
}

/**
 * Idempotency lookup — mirrors `getApprovalRequestByStepId`. A re-execution of
 * the same wait node finds its existing row instead of inserting a duplicate.
 */
export async function getWaitStateByStepId(stepId: string): Promise<WaitStateRow | null> {
  const row = await getStorage().repos.workflows.findWaitStateByStepId(stepId);
  return row ? rowToWaitState(row) : null;
}

/**
 * Scan for waits the poller should resume now:
 *   - mode='time' with `wakeUpAt <= now`, OR
 *   - mode='event' with non-null `expiresAt <= now` (timeout branch).
 */
export async function getDueWaitStates(): Promise<WaitStateRow[]> {
  const rows = await getStorage().repos.workflows.listDueWaitStates();
  return rows.map(rowToWaitState);
}

/**
 * Distinct `eventName` values across pending event-mode waits. Used at boot
 * by the wait-bus subscription system to register one listener per event name.
 */
export async function getPendingEventWaitNames(): Promise<string[]> {
  return getStorage().repos.workflows.listPendingEventWaitNames();
}

/**
 * Find pending event-mode waits matching `eventName`. Optional `runId` narrows
 * to a single run for run-scoped signals. The Phase 3 listener applies the
 * declarative/JS filter on top of this; the DB query is the cheap pre-filter.
 */
export async function getPendingWaitsByEvent(
  eventName: string,
  runId?: string,
): Promise<WaitStateRow[]> {
  const rows = await getStorage().repos.workflows.listPendingWaitsByEvent(eventName, runId);
  return rows.map(rowToWaitState);
}

/**
 * Atomic state transition: pending → fired|timeout. Returns `{updated: true}`
 * iff the caller won the race (UPDATE matched a pending row). Concurrent
 * callers see `{updated: false}` and should bail without further side effects.
 */
export async function resolveWaitState(
  id: string,
  data: { status: Exclude<WaitStateStatus, "pending">; firedPayload?: unknown },
): Promise<{ updated: boolean; row: WaitStateRow | null }> {
  const now = new Date().toISOString();
  const row = await getStorage().repos.workflows.resolveWaitState(
    id,
    data.status,
    data.firedPayload !== undefined ? JSON.stringify(data.firedPayload) : null,
    now,
  );
  return { updated: row !== null, row: row ? rowToWaitState(row) : null };
}

export interface StuckWaitRun {
  runId: string;
  stepId: string;
  nodeId: string;
  workflowId: string;
  waitId: string;
  waitMode: string;
  waitStatus: string;
  wakeUpAt: string | null;
  expiresAt: string | null;
  firedPayload: string | null;
}

/**
 * Recovery scan: workflow runs in `waiting` whose wait_state is either
 *   (a) already non-pending — signal arrived / timeout fired while down and
 *       the in-memory bus event was lost, OR
 *   (b) still pending but overdue (`wakeUpAt`/`expiresAt` already past).
 *
 * Case (b) overlaps with the wait-poller's first tick after boot, but explicit
 * recovery avoids the up-to-5s startup latency window for stuck runs.
 */
export async function getStuckWaitRuns(): Promise<StuckWaitRun[]> {
  return getStorage().repos.workflows.listStuckWaitRuns();
}

// ============================================================================
// Skills
// ============================================================================

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    type: row.type as SkillType,
    scope: row.scope as SkillScope,
    ownerAgentId: row.ownerAgentId,
    sourceUrl: row.sourceUrl,
    sourceRepo: row.sourceRepo,
    sourcePath: row.sourcePath,
    sourceBranch: row.sourceBranch,
    sourceHash: row.sourceHash,
    isComplex: row.isComplex === 1,
    allowedTools: row.allowedTools,
    model: row.model,
    effort: row.effort,
    context: row.context,
    agent: row.agent,
    disableModelInvocation: row.disableModelInvocation === 1,
    userInvocable: row.userInvocable === 1,
    version: row.version,
    isEnabled: row.isEnabled === 1,
    systemDefault: row.systemDefault === 1,
    invocationCount: row.invocationCount,
    lastInvokedAt: row.lastInvokedAt,
    createdByAgentId: row.createdByAgentId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    lastFetchedAt: row.lastFetchedAt,
  };
}

type AgentSkillRow = {
  id: string;
  agentId: string;
  skillId: string;
  isActive: number;
  installedAt: string;
};

function rowToAgentSkill(row: AgentSkillRow): AgentSkill {
  return {
    id: row.id,
    agentId: row.agentId,
    skillId: row.skillId,
    isActive: row.isActive === 1,
    installedAt: row.installedAt,
  };
}

function rowToSkillWithInstall(row: SkillWithInstallRow): SkillWithInstallInfo {
  return {
    ...rowToSkill(row),
    isActive: row.isActive === 1,
    installedAt: row.installedAt,
  };
}

function rowToSkillFile(row: SkillFileRow): SkillFile {
  return {
    id: row.id,
    skillId: row.skillId,
    path: row.path,
    content: row.content,
    mimeType: row.mimeType,
    isBinary: row.isBinary === 1,
    size: row.size,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export type SkillFileInput = {
  path: string;
  content: string;
  mimeType?: string;
  isBinary?: boolean;
  size?: number | null;
};

export type SkillFileManifestEntry = Omit<SkillFile, "content">;
type NormalizedSkillFileInput = {
  path: string;
  content: string;
  mimeType: string;
  isBinary: boolean;
  size: number;
};

export const SKILL_FILE_LIMITS = {
  maxCount: Number(process.env.SKILL_FILES_MAX_COUNT ?? 100),
  maxTotalBytes: Number(process.env.SKILL_FILES_MAX_TOTAL_BYTES ?? 10 * 1024 * 1024),
  maxFileBytes: Number(process.env.SKILL_FILES_MAX_FILE_BYTES ?? 500 * 1024),
};

const BINARY_SKILL_FILE_PLACEHOLDER = "[binary file - not synced]";

export function normalizeSkillFilePath(path: string): string {
  const raw = path.trim().replace(/\\/g, "/");
  if (!raw) throw new Error("File path is required");
  if (raw.startsWith("/")) throw new Error("File path must be relative");

  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("File path is required");
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("File path cannot contain traversal segments");
  }

  const normalized = parts.join("/");
  if (normalized === "SKILL.md") {
    throw new Error("SKILL.md is stored on the skill record, not in skill_files");
  }
  return normalized;
}

function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function normalizeSkillFileInput(input: SkillFileInput): NormalizedSkillFileInput {
  const path = normalizeSkillFilePath(input.path);
  const isBinary = input.isBinary === true;
  const content = isBinary ? input.content || BINARY_SKILL_FILE_PLACEHOLDER : input.content;
  const size = input.size ?? byteSize(content);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error("File size must be a non-negative number");
  }
  if (size > SKILL_FILE_LIMITS.maxFileBytes) {
    throw new Error(`File ${path} exceeds max size ${SKILL_FILE_LIMITS.maxFileBytes}`);
  }

  return {
    path,
    content,
    mimeType: input.mimeType ?? "text/plain",
    isBinary,
    size,
  };
}

async function assertSkillFileLimits(
  skillId: string,
  incoming: SkillFileInput[],
  replaceAll: boolean,
): Promise<void> {
  const existing = replaceAll ? [] : await listSkillFileManifest(skillId);
  const byPath = new Map(existing.map((file) => [file.path, file.size ?? 0]));

  for (const input of incoming) {
    const normalized = normalizeSkillFileInput(input);
    byPath.set(normalized.path, normalized.size);
  }

  if (byPath.size > SKILL_FILE_LIMITS.maxCount) {
    throw new Error(`Skill file count exceeds max ${SKILL_FILE_LIMITS.maxCount}`);
  }

  const total = [...byPath.values()].reduce((sum, size) => sum + size, 0);
  if (total > SKILL_FILE_LIMITS.maxTotalBytes) {
    throw new Error(`Skill files exceed max total size ${SKILL_FILE_LIMITS.maxTotalBytes}`);
  }
}

export interface SkillInsert {
  name: string;
  description: string;
  content: string;
  type?: SkillType;
  scope?: SkillScope;
  ownerAgentId?: string;
  sourceUrl?: string;
  sourceRepo?: string;
  sourcePath?: string;
  sourceBranch?: string;
  sourceHash?: string;
  isComplex?: boolean;
  allowedTools?: string;
  model?: string;
  effort?: string;
  context?: string;
  agent?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  systemDefault?: boolean;
  /** Defaults to true. Extensions create their skills disabled. */
  isEnabled?: boolean;
  /** Audit: the creating agent and person. Seeds leave both NULL. */
  createdByAgentId?: string | null;
  createdBy?: string | null;
}

/**
 * DEFERRED (transaction rule): called from `skillsSeeder.apply()`
 * (src/be/seed-skills/index.ts), inside its synchronous
 * `getDb().transaction()` callback — stays on the raw sync handle.
 */
export async function createSkill(data: SkillInsert): Promise<Skill> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getStorage().repos.skills.insertSkill({
    id,
    name: data.name,
    description: data.description,
    content: data.content,
    type: data.type ?? "personal",
    scope: data.scope ?? "agent",
    ownerAgentId: data.ownerAgentId ?? null,
    sourceUrl: data.sourceUrl ?? null,
    sourceRepo: data.sourceRepo ?? null,
    sourcePath: data.sourcePath ?? null,
    sourceBranch: data.sourceBranch ?? "main",
    sourceHash: data.sourceHash ?? null,
    isComplex: !!data.isComplex,
    allowedTools: data.allowedTools ?? null,
    model: data.model ?? null,
    effort: data.effort ?? null,
    context: data.context ?? null,
    agent: data.agent ?? null,
    disableModelInvocation: !!data.disableModelInvocation,
    userInvocable: data.userInvocable !== false,
    isEnabled: data.isEnabled !== false,
    systemDefault: !!data.systemDefault,
    createdAt: now,
    lastUpdatedAt: now,
    createdByAgentId: data.createdByAgentId ?? null,
    updatedByAgentId: data.createdByAgentId ?? null,
    created_by: data.createdBy ?? null,
    updated_by: data.createdBy ?? null,
  });

  if (!row) throw new Error("Failed to create skill");
  return rowToSkill(row);
}

/** Optional skill fields; `updateSkill` writes null to clear them. */
type NullableSkillField =
  | "allowedTools"
  | "model"
  | "effort"
  | "context"
  | "agent"
  | "sourceUrl"
  | "sourceRepo"
  | "sourcePath"
  | "sourceHash";

export async function updateSkill(
  id: string,
  updates: Partial<Omit<SkillInsert, NullableSkillField | "createdByAgentId" | "createdBy">> & {
    [K in NullableSkillField]?: string | null;
  } & {
    isEnabled?: boolean;
    lastFetchedAt?: string;
    /**
     * Audit pair for a user-intent write: pass both (null = unknown) so they
     * describe the same write. Omitted (seed and system writes) leaves them untouched.
     */
    updatedBy?: string | null;
    updatedByAgentId?: string | null;
  },
): Promise<Skill | null> {
  const existing = await getSkillById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const nullable = (value: string | null | undefined) =>
    value === undefined ? undefined : (value ?? null);
  // Bumps the version when content changes.
  const row = await getStorage().repos.skills.updateSkill(
    id,
    {
      name: updates.name,
      description: updates.description,
      content: updates.content,
      scope: updates.scope,
      isEnabled: updates.isEnabled,
      systemDefault: updates.systemDefault,
      allowedTools: nullable(updates.allowedTools),
      model: nullable(updates.model),
      effort: nullable(updates.effort),
      context: nullable(updates.context),
      agent: nullable(updates.agent),
      disableModelInvocation: updates.disableModelInvocation,
      userInvocable: updates.userInvocable,
      sourceUrl: nullable(updates.sourceUrl),
      sourceRepo: nullable(updates.sourceRepo),
      sourcePath: nullable(updates.sourcePath),
      sourceBranch:
        updates.sourceBranch === undefined ? undefined : (updates.sourceBranch ?? "main"),
      sourceHash: nullable(updates.sourceHash),
      isComplex: updates.isComplex,
      lastFetchedAt: updates.lastFetchedAt,
      updated_by: updates.updatedBy,
      updatedByAgentId: updates.updatedByAgentId,
    },
    now,
  );

  return row ? rowToSkill(row) : null;
}

async function bumpSkillVersion(skillId: string, now = new Date().toISOString()) {
  await getStorage().repos.skills.bumpSkillVersion(skillId, now);
}

export async function listSkillFileManifest(skillId: string): Promise<SkillFileManifestEntry[]> {
  const rows = await getStorage().repos.skills.listSkillFiles(skillId);
  return rows.map((row) => {
    const { content: _content, ...manifest } = rowToSkillFile(row);
    return manifest;
  });
}

export async function getSkillFiles(skillId: string): Promise<SkillFile[]> {
  const rows = await getStorage().repos.skills.listSkillFiles(skillId);
  return rows.map(rowToSkillFile);
}

export async function getSkillFile(skillId: string, path: string): Promise<SkillFile | null> {
  const normalizedPath = normalizeSkillFilePath(path);
  const row = await getStorage().repos.skills.findSkillFile(skillId, normalizedPath);
  return row ? rowToSkillFile(row) : null;
}

/** Single-file upsert. */
export async function upsertSkillFile(skillId: string, input: SkillFileInput): Promise<SkillFile> {
  const payload = normalizeSkillFileInput(input);
  await assertSkillFileLimits(skillId, [payload], false);
  return await upsertSkillFileUnchecked(
    skillId,
    payload,
    crypto.randomUUID(),
    new Date().toISOString(),
    true,
  );
}

async function upsertSkillFileUnchecked(
  skillId: string,
  payload: NormalizedSkillFileInput,
  id: string,
  now: string,
  bumpVersion: boolean,
): Promise<SkillFile> {
  const row = await getStorage().repos.skills.upsertSkillFile({
    id,
    skillId,
    path: payload.path,
    content: payload.content,
    mimeType: payload.mimeType,
    isBinary: !!payload.isBinary,
    size: payload.size,
    createdAt: now,
    lastUpdatedAt: now,
  });

  if (!row) throw new Error("Failed to upsert skill file");
  if (bumpVersion) await bumpSkillVersion(skillId, now);
  return rowToSkillFile(row);
}

export async function upsertSkillFiles(
  skillId: string,
  files: SkillFileInput[],
): Promise<SkillFile[]> {
  if (files.length === 0) return [];
  const normalized = files.map(normalizeSkillFileInput);
  await assertSkillFileLimits(skillId, normalized, false);

  const now = new Date().toISOString();
  return await getStorage().transaction(async () => {
    const rows: SkillFile[] = [];
    for (const file of normalized) {
      rows.push(await upsertSkillFileUnchecked(skillId, file, crypto.randomUUID(), now, false));
    }
    await bumpSkillVersion(skillId, now);
    return rows;
  });
}

export async function deleteSkillFile(skillId: string, path: string): Promise<boolean> {
  const normalizedPath = normalizeSkillFilePath(path);
  const changes = await getStorage().repos.skills.deleteSkillFile(skillId, normalizedPath);
  if (changes > 0) {
    await bumpSkillVersion(skillId);
    return true;
  }
  return false;
}

export async function deleteSkill(id: string): Promise<boolean> {
  return (await getStorage().repos.skills.deleteSkill(id)) > 0;
}

export async function getSkillById(id: string): Promise<Skill | null> {
  const row = await getStorage().repos.skills.findSkillById(id);
  return row ? rowToSkill(row) : null;
}

export async function getSkillByName(
  name: string,
  scope: SkillScope,
  ownerAgentId?: string,
): Promise<Skill | null> {
  const row = await getStorage().repos.skills.findSkillByName(name, scope, ownerAgentId ?? "");
  return row ? rowToSkill(row) : null;
}

export interface SkillFilters {
  type?: SkillType;
  scope?: SkillScope;
  ownerAgentId?: string;
  isEnabled?: boolean;
  search?: string;
  limit?: number;
  includeContent?: boolean;
}

export async function listSkills(filters?: SkillFilters): Promise<Skill[]> {
  const rows = await getStorage().repos.skills.listSkills({
    type: filters?.type,
    scope: filters?.scope,
    ownerAgentId: filters?.ownerAgentId,
    isEnabled: filters?.isEnabled,
    search: filters?.search,
    limit: filters?.limit,
    slim: filters?.includeContent === false,
  });
  return rows.map(rowToSkill);
}

/**
 * Ranked skill search (see searchSkillRowsRanked). Falls back to the unranked
 * substring match when the ranked query finds nothing, e.g. a partial word or
 * a query of only stopwords. The fallback also ranks an exact name first.
 */
export async function searchSkills(
  query: string,
  limit = 20,
  includeContent = true,
): Promise<Skill[]> {
  const ranked = await searchSkillRowsRanked<SkillRow>(
    query,
    limit,
    includeContent === false ? SKILL_SLIM_COLUMNS : "skills.*",
  );
  if (ranked.length > 0) return ranked.map(rowToSkill);

  const tokens = query.split(/\s+/).filter(Boolean);
  const rows = await getStorage().repos.skills.searchSkillsBySubstring(
    tokens,
    query.trim(),
    limit,
    includeContent === false,
  );
  return rows.map(rowToSkill);
}

export async function installSkill(agentId: string, skillId: string): Promise<AgentSkill> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getStorage().repos.agents.installSkill(id, agentId, skillId, now);

  if (!row) throw new Error("Failed to install skill");
  return rowToAgentSkill(row);
}

export async function getSystemDefaultSkills(): Promise<Skill[]> {
  const rows = await getStorage().repos.skills.listSystemDefaultSkills();
  return rows.map(rowToSkill);
}

export async function installSystemDefaultSkillsForAgent(agentId: string): Promise<AgentSkill[]> {
  const skills = await getSystemDefaultSkills();
  const installed: AgentSkill[] = [];
  for (const skill of skills) {
    installed.push(await installSkill(agentId, skill.id));
  }
  return installed;
}

export async function uninstallSkill(agentId: string, skillId: string): Promise<boolean> {
  return (await getStorage().repos.agents.uninstallSkill(agentId, skillId)) > 0;
}

export async function getAgentSkills(
  agentId: string,
  activeOnly = true,
): Promise<SkillWithInstallInfo[]> {
  const rows = await getStorage().repos.skills.listAgentSkills(agentId, activeOnly);

  // Deduplicate by name — personal skills take precedence (already sorted first)
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      if (seen.has(r.name)) return false;
      seen.add(r.name);
      return true;
    })
    .map(rowToSkillWithInstall);
}

export async function toggleAgentSkill(
  agentId: string,
  skillId: string,
  isActive: boolean,
): Promise<boolean> {
  return (await getStorage().repos.agents.setSkillActive(agentId, skillId, isActive)) > 0;
}

// ── MCP Servers ──────────────────────────────────────────────────────────

type AgentMcpServerRow = {
  id: string;
  agentId: string;
  mcpServerId: string;
  isActive: number;
  installedAt: string;
};

function rowToMcpServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope as McpServerScope,
    ownerAgentId: row.ownerAgentId,
    transport: row.transport as McpServerTransport,
    command: row.command,
    args: row.args,
    url: row.url,
    headers: row.headers,
    envConfigKeys: row.envConfigKeys,
    headerConfigKeys: row.headerConfigKeys,
    extraAuthorizeParams: row.extraAuthorizeParams,
    authMethod: (row.authMethod as McpServer["authMethod"]) ?? "static",
    isEnabled: row.isEnabled === 1,
    version: row.version,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

function rowToAgentMcpServer(row: AgentMcpServerRow): AgentMcpServer {
  return {
    id: row.id,
    agentId: row.agentId,
    mcpServerId: row.mcpServerId,
    isActive: row.isActive === 1,
    installedAt: row.installedAt,
  };
}

function rowToMcpServerWithInstall(row: McpServerWithInstallRow): McpServerWithInstallInfo {
  return {
    ...rowToMcpServer(row),
    isActive: row.isActive === 1,
    installedAt: row.installedAt,
  };
}

export interface McpServerInsert {
  name: string;
  transport: McpServerTransport;
  description?: string;
  scope?: McpServerScope;
  ownerAgentId?: string;
  command?: string;
  args?: string;
  url?: string;
  headers?: string;
  envConfigKeys?: string;
  headerConfigKeys?: string;
  extraAuthorizeParams?: string;
}

export async function createMcpServer(data: McpServerInsert): Promise<McpServer> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getStorage().repos.mcpServers.insertMcpServer({
    id,
    name: data.name,
    description: data.description ?? null,
    scope: data.scope ?? "agent",
    ownerAgentId: data.ownerAgentId ?? null,
    transport: data.transport,
    command: data.command ?? null,
    args: data.args ?? null,
    url: data.url ?? null,
    headers: data.headers ?? null,
    envConfigKeys: data.envConfigKeys ?? null,
    headerConfigKeys: data.headerConfigKeys ?? null,
    extraAuthorizeParams: data.extraAuthorizeParams ?? null,
    createdAt: now,
    lastUpdatedAt: now,
  });

  if (!row) throw new Error("Failed to create MCP server");
  return rowToMcpServer(row);
}

/** Shared by HTTP and MCP-tool creation paths so each new server emits once. */
export async function emitMcpServerConnectedTelemetry(): Promise<void> {
  try {
    const count = await getStorage().repos.mcpServers.countMcpServers();
    emitIntegrationConnected("other", undefined, count === 1);
  } catch {
    // Telemetry must never break MCP server creation.
  }
}

export async function updateMcpServer(
  id: string,
  updates: Partial<McpServerInsert> & {
    isEnabled?: boolean;
    authMethod?: McpServer["authMethod"];
  },
): Promise<McpServer | null> {
  const existing = await getMcpServerById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const nullable = (value: string | null | undefined) =>
    value === undefined ? undefined : (value ?? null);
  // Config changes (command, args, url, headers, env/header keys, authorize
  // params, transport) bump the version.
  const row = await getStorage().repos.mcpServers.updateMcpServer(
    id,
    {
      name: updates.name,
      description: nullable(updates.description),
      scope: updates.scope,
      transport: updates.transport,
      command: nullable(updates.command),
      args: nullable(updates.args),
      url: nullable(updates.url),
      headers: nullable(updates.headers),
      envConfigKeys: nullable(updates.envConfigKeys),
      headerConfigKeys: nullable(updates.headerConfigKeys),
      extraAuthorizeParams: nullable(updates.extraAuthorizeParams),
      isEnabled: updates.isEnabled,
      ownerAgentId: nullable(updates.ownerAgentId),
      authMethod: updates.authMethod,
    },
    now,
  );

  return row ? rowToMcpServer(row) : null;
}

export type DeleteMcpServerResult = {
  deleted: boolean;
  deletedScriptConnectionCount: number;
};

export async function deleteMcpServer(id: string): Promise<DeleteMcpServerResult> {
  const storage = getStorage();
  const existing = await storage.repos.mcpServers.findMcpServerById(id);
  if (!existing) return { deleted: false, deletedScriptConnectionCount: 0 };

  return await storage.transaction(async () => {
    const deleted = await storage.repos.mcpServers.deleteMcpServerCascade(id);
    return {
      deleted: deleted.servers > 0,
      deletedScriptConnectionCount: deleted.scriptConnections,
    };
  });
}

export async function getMcpServerById(id: string): Promise<McpServer | null> {
  const row = await getStorage().repos.mcpServers.findMcpServerById(id);
  return row ? rowToMcpServer(row) : null;
}

export async function getMcpServerByName(
  name: string,
  scope: McpServerScope,
  ownerAgentId: string | null,
): Promise<McpServer | null> {
  const row = await getStorage().repos.mcpServers.findMcpServerByName(
    name,
    scope,
    ownerAgentId ?? "",
  );
  return row ? rowToMcpServer(row) : null;
}

export interface McpServerFilters {
  scope?: McpServerScope;
  ownerAgentId?: string;
  transport?: McpServerTransport;
  isEnabled?: boolean;
  search?: string;
}

export async function listMcpServers(filters?: McpServerFilters): Promise<McpServer[]> {
  const rows = await getStorage().repos.mcpServers.listMcpServers(filters ?? {});
  return rows.map(rowToMcpServer);
}

export async function installMcpServer(
  agentId: string,
  mcpServerId: string,
): Promise<AgentMcpServer> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getStorage().repos.agents.installMcpServer(id, agentId, mcpServerId, now);

  if (!row) throw new Error("Failed to install MCP server");
  return rowToAgentMcpServer(row);
}

export async function uninstallMcpServer(agentId: string, mcpServerId: string): Promise<boolean> {
  return (await getStorage().repos.agents.uninstallMcpServer(agentId, mcpServerId)) > 0;
}

export async function getAgentMcpServers(
  agentId: string,
  activeOnly = true,
): Promise<McpServerWithInstallInfo[]> {
  const rows = await getStorage().repos.mcpServers.listAgentMcpServers(agentId, activeOnly);
  return rows.map(rowToMcpServerWithInstall);
}

// ============================================================================
// Context Usage Snapshots
// ============================================================================

function rowToContextSnapshot(row: ContextSnapshotRow): ContextSnapshot {
  return {
    id: row.id,
    taskId: row.taskId,
    agentId: row.agentId,
    sessionId: row.sessionId,
    contextUsedTokens: row.contextUsedTokens ?? undefined,
    contextTotalTokens: row.contextTotalTokens ?? undefined,
    contextPercent: row.contextPercent ?? undefined,
    eventType: row.eventType as ContextSnapshotEventType,
    compactTrigger: (row.compactTrigger as "auto" | "manual" | "auto-inferred" | null) ?? undefined,
    preCompactTokens: row.preCompactTokens ?? undefined,
    cumulativeInputTokens: row.cumulativeInputTokens,
    cumulativeOutputTokens: row.cumulativeOutputTokens,
    contextFormula: (row.contextFormula as ContextSnapshot["contextFormula"]) ?? undefined,
    createdAt: row.createdAt,
  };
}

export interface CreateContextSnapshotInput {
  taskId: string;
  agentId: string;
  sessionId: string;
  contextUsedTokens?: number;
  contextTotalTokens?: number;
  contextPercent?: number;
  eventType: ContextSnapshotEventType;
  compactTrigger?: "auto" | "manual" | "auto-inferred";
  preCompactTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  // Migration 063 — adapter-supplied formula tag.
  contextFormula?: ContextSnapshot["contextFormula"];
}

export async function createContextSnapshot(
  input: CreateContextSnapshotInput,
): Promise<ContextSnapshot> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const tasks = getStorage().repos.tasks;

  await tasks.insertContextSnapshot({
    id,
    taskId: input.taskId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    contextUsedTokens: input.contextUsedTokens ?? null,
    contextTotalTokens: input.contextTotalTokens ?? null,
    contextPercent: input.contextPercent ?? null,
    eventType: input.eventType,
    compactTrigger: input.compactTrigger ?? null,
    preCompactTokens: input.preCompactTokens ?? null,
    cumulativeInputTokens: input.cumulativeInputTokens ?? 0,
    cumulativeOutputTokens: input.cumulativeOutputTokens ?? 0,
    contextFormula: input.contextFormula ?? null,
    createdAt: now,
  });

  // Update aggregate columns on agent_tasks. Migration 063: peakContextTokens is
  // monotonic-max across snapshots (Claude Code's status-line "peak context").
  // contextWindowSize is set by the FIRST snapshot that carries one (Phase 10).
  await tasks.applyContextSnapshotToTask(input.taskId, {
    contextPercent: input.contextPercent ?? null,
    contextUsedTokens: input.contextUsedTokens ?? null,
    contextTotalTokens: input.contextTotalTokens ?? null,
    compaction: input.eventType === "compaction",
  });

  return {
    id,
    taskId: input.taskId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    contextUsedTokens: input.contextUsedTokens,
    contextTotalTokens: input.contextTotalTokens,
    contextPercent: input.contextPercent,
    eventType: input.eventType,
    compactTrigger: input.compactTrigger,
    preCompactTokens: input.preCompactTokens,
    cumulativeInputTokens: input.cumulativeInputTokens ?? 0,
    cumulativeOutputTokens: input.cumulativeOutputTokens ?? 0,
    contextFormula: input.contextFormula,
    createdAt: now,
  };
}

export async function getContextSnapshotsByTaskId(
  taskId: string,
  limit = 500,
): Promise<ContextSnapshot[]> {
  const rows = await getStorage().repos.tasks.listContextSnapshots({ taskId }, limit);
  return rows.map(rowToContextSnapshot);
}

export async function getContextSnapshotsBySessionId(
  sessionId: string,
  limit = 500,
): Promise<ContextSnapshot[]> {
  const rows = await getStorage().repos.tasks.listContextSnapshots({ sessionId }, limit);
  return rows.map(rowToContextSnapshot);
}

export interface ContextSummary {
  compactionCount: number;
  peakContextPercent: number | null;
  // Migration 063: renamed from totalContextTokensUsed.
  peakContextTokens: number | null;
  contextWindowSize: number | null;
  snapshotCount: number;
}

export async function getContextSummaryByTaskId(taskId: string): Promise<ContextSummary> {
  const task = await getTaskById(taskId);
  const snapshotCount = await getStorage().repos.tasks.countContextSnapshots(taskId);

  return {
    compactionCount: task?.compactionCount ?? 0,
    peakContextPercent: task?.peakContextPercent ?? null,
    peakContextTokens: task?.peakContextTokens ?? null,
    contextWindowSize: task?.contextWindowSize ?? null,
    snapshotCount,
  };
}

// ─── API Key Pool Tracking ───────────────────────────────────────────────────

export interface ApiKeyStatus {
  id: string;
  keyType: string;
  keySuffix: string;
  keyIndex: number;
  scope: string;
  scopeId: string | null;
  status: string;
  rateLimitedUntil: string | null;
  /** The spend cap behind the current rate limit, or null for an ordinary one. */
  spendCap: SpendCap | null;
  lastUsedAt: string | null;
  lastRateLimitAt: string | null;
  totalUsageCount: number;
  rateLimitCount: number;
  /** Optional human-friendly label set from the dashboard. */
  name: string | null;
  /** Auto-derived harness provider (claude/pi/codex) — see deriveProviderFromKeyType. */
  provider: string;
  /** Latest provider-emitted rate-limit window snapshots, keyed by window type. */
  rateLimitWindows: RateLimitWindowTelemetry;
  providerAccount: ProviderAccountTelemetry | null;
  /** Subscription plan id (`SUBSCRIPTION_PLANS`), when known. */
  plan: string | null;
  planSource: PlanSource | null;
  detectedPlanRaw: string | null;
  /** When the CLI last rejected a model with `credits_required` on this key. */
  lastSeatMismatchAt: string | null;
  /** Model family of that rejection (`fable`, `opus`, ...). */
  lastSeatMismatchModel: string | null;
  /** Auth failures in a row since the last success or clear. */
  consecutiveAuthFailures: number;
  lastAuthFailureAt: string | null;
  lastValidationError: string | null;
  lastValidationFailedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseRateLimitWindowsJson(value: string | null | undefined): RateLimitWindowTelemetry {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RateLimitWindowTelemetry;
    }
  } catch {
    // Ignore malformed historical values; telemetry is best-effort.
  }
  return {};
}

function rowToApiKeyStatus(row: ApiKeyStatusRow): ApiKeyStatus {
  return {
    ...row,
    planSource: row.planSource as PlanSource | null,
    rateLimitWindows: parseRateLimitWindowsJson(row.rateLimitWindows),
    providerAccount: parseProviderAccount(row.providerAccount),
    spendCap: row.spendCap ? (JSON.parse(row.spendCap) as SpendCap) : null,
  };
}

export interface AvailableKeyIndicesResult {
  availableIndices: number[];
  rejectedIndices: number[];
  /** Indices excluded only by an active model-scoped window block (not key-wide). */
  modelBlockedIndices: number[];
  /** ISO of the earliest resetsAt among modelBlockedIndices, or null when none. */
  earliestModelResetAt: string | null;
  /** Indices excluded because the key's subscription plan cannot run the model family. */
  seatBlockedIndices: number[];
  /** Rate-limited indices whose limit is a provider spend cap: no retry helps before it resets. */
  spendCappedIndices: number[];
  authFailureFence: number; // highest `authFailureSeq` among these rows
  /**
   * Usage per pool position (`keyUsageFromWindows`: max of the live 5h and 7d
   * utilization, 0 when unobserved or reset). Ranks admissible keys only.
   */
  keyUsage: number[];
  /**
   * Pace delta per pool position (`keyPaceFromWindows`: max of used minus elapsed
   * share over the live 5h, 7d and `modelFamily` weekly windows, 0 when none).
   * Ranks admissible keys under the `pace` strategy only.
   */
  keyPace: number[];
  /**
   * `in_progress` tasks per pool position whose `credentialKeyType` is this key
   * type and whose `credentialKeySuffix` is the position's suffix. Breaks ties
   * within the usage band; it never excludes a key.
   */
  activeSessions: number[];
}

/**
 * Get available (non-rate-limited) key indices for a credential type.
 * Automatically clears expired rate limits before returning.
 *
 * When `modelFamily` has a weekly window (fable/opus/sonnet), a key whose
 * `rateLimitWindows` carries an active rejected window for that family is
 * excluded from `availableIndices` and reported in `modelBlockedIndices`
 * instead — the key itself stays `available` for every other model. A key
 * whose `plan` cannot run the family (`planAllowsModelFamily`) is excluded
 * and reported in `seatBlockedIndices`, also when it is key-wide or
 * model-window blocked; a seat block has no reset time.
 *
 * With `keySuffixes` (the caller's own pool, in order), rows are matched by
 * key suffix instead of the stored `keyIndex`, across every scope: a key has
 * one state wherever it is pooled, and a key at the same index in another
 * agent's pool is never blocked by it. A suffix listed more than once is read
 * by `keyIndex` in `scope`/`scopeId`, as without the list. Returned indices
 * are positions in `keySuffixes`. Without it, rows of `scope`/`scopeId` are
 * read by `keyIndex`.
 */
export async function getAvailableKeyIndices(
  keyType: string,
  totalKeys: number,
  scope = "global",
  scopeId: string | null = null,
  modelFamily?: ModelFamily,
  keySuffixes?: string[],
): Promise<AvailableKeyIndicesResult> {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const keys = getStorage().repos.config;
  const effectiveScopeId = scopeId ?? "";
  const suffixes = keySuffixes?.length ? keySuffixes : undefined;
  const rowFilter = suffixes
    ? { keyType, suffixes }
    : { keyType, scope, scopeId: effectiveScopeId };

  // Auto-clear expired rate limits. Never an auth bench: only `clearAuthBench` lifts it.
  await keys.clearExpiredRateLimits(rowFilter, now, CODEX_AUTH_FAILURE_BENCH_THRESHOLD);

  const rows = await keys.listAdmissionRows(rowFilter);
  // Pool positions a row applies to: the position holding its suffix, or its stored index.
  // A suffix held by several pool members cannot tell them apart, so it falls back to
  // the index read: only a row of the requested scope, at its stored index.
  const positionsOf = (row: (typeof rows)[number]): number[] => {
    if (!suffixes) return [row.keyIndex];
    const positions = suffixes.flatMap((suffix, i) => (suffix === row.keySuffix ? [i] : []));
    if (positions.length < 2) return positions;
    const sameScope = row.scope === scope && row.scopeId === effectiveScopeId;
    return sameScope && positions.includes(row.keyIndex) ? [row.keyIndex] : [];
  };

  const blockedIndices = new Set(
    rows.filter((r) => r.status === "rate_limited").flatMap(positionsOf),
  );
  const spendCappedIndices = [
    ...new Set(rows.filter((r) => r.status === "rate_limited" && r.spendCap).flatMap(positionsOf)),
  ];
  const rejectedIndices = [
    ...new Set(rows.filter((row) => row.lastValidationFailedAt !== null).flatMap(positionsOf)),
  ];
  for (const index of rejectedIndices) blockedIndices.add(index);

  const modelBlockedIndices: number[] = [];
  let earliestModelResetsAtSec: number | undefined;
  if (modelFamily) {
    for (const row of rows) {
      // A key already blocked key-wide doesn't need a separate model-block
      // entry — it's excluded from availableIndices either way, and
      // modelBlockedIndices means "excluded only by a model-scoped block".
      const positions = positionsOf(row).filter(
        (i) => !blockedIndices.has(i) && !modelBlockedIndices.includes(i),
      );
      if (positions.length === 0) continue;
      const block = activeModelBlock(
        parseRateLimitWindowsJson(row.rateLimitWindows),
        modelFamily,
        nowMs,
      );
      if (!block) continue;
      modelBlockedIndices.push(...positions);
      if (earliestModelResetsAtSec === undefined || block.resetsAt < earliestModelResetsAtSec) {
        earliestModelResetsAtSec = block.resetsAt;
      }
    }
  }
  const modelBlockedSet = new Set(modelBlockedIndices);

  // A seat block is a plan fact: report it even when the key is also key-wide
  // or model-window blocked, or the temporary block hides it from admission
  // and the fallback pick can select a key that cannot run the model.
  const seatBlockedIndices: number[] = [];
  if (modelFamily) {
    for (const row of rows) {
      if (planAllowsModelFamily(row.plan, modelFamily)) continue;
      for (const i of positionsOf(row)) {
        if (!seatBlockedIndices.includes(i)) seatBlockedIndices.push(i);
      }
    }
  }
  const seatBlockedSet = new Set(seatBlockedIndices);

  const availableIndices: number[] = [];
  for (let i = 0; i < totalKeys; i++) {
    if (blockedIndices.has(i) || modelBlockedSet.has(i) || seatBlockedSet.has(i)) continue;
    availableIndices.push(i);
  }

  // A position several rows apply to (one key pooled in several scopes) takes the highest reading.
  const keyUsage = new Array<number>(totalKeys).fill(0);
  // The most over-pace reading wins; a position with no live window reads 0.
  const keyPace = new Array<number | undefined>(totalKeys).fill(undefined);
  for (const row of rows) {
    const windows = parseRateLimitWindowsJson(row.rateLimitWindows);
    const usage = keyUsageFromWindows(windows, nowMs);
    const pace = keyPaceFromWindows(windows, nowMs, modelFamily);
    for (const i of positionsOf(row)) {
      if (i < 0 || i >= totalKeys) continue;
      keyUsage[i] = Math.max(keyUsage[i]!, usage);
      if (pace !== undefined) keyPace[i] = Math.max(keyPace[i] ?? Number.NEGATIVE_INFINITY, pace);
    }
  }

  // Running sessions per position. A task stamps its key suffix at session start
  // (`recordKeyUsage`), so this moves within seconds, before any usage report.
  // Without `keySuffixes`, a position takes the suffix of its stored row in scope.
  const suffixAt = (i: number): string | undefined =>
    suffixes
      ? suffixes[i]
      : rows.find((r) => r.keyIndex === i && r.scope === scope && r.scopeId === effectiveScopeId)
          ?.keySuffix;
  const positionSuffixes = Array.from({ length: totalKeys }, (_, i) => suffixAt(i));
  const distinctSuffixes = [...new Set(positionSuffixes.filter((s): s is string => !!s))];
  const sessionsBySuffix = new Map<string, number>();
  if (distinctSuffixes.length > 0) {
    const counts = await getStorage().repos.tasks.countInProgressByCredentialSuffix(
      keyType,
      distinctSuffixes,
    );
    for (const { suffix, n } of counts) sessionsBySuffix.set(suffix, n);
  }
  const activeSessions = positionSuffixes.map((s) => (s ? (sessionsBySuffix.get(s) ?? 0) : 0));

  return {
    availableIndices,
    rejectedIndices,
    modelBlockedIndices,
    seatBlockedIndices,
    spendCappedIndices,
    earliestModelResetAt:
      earliestModelResetsAtSec !== undefined
        ? new Date(earliestModelResetsAtSec * 1000).toISOString()
        : null,
    authFailureFence: Math.max(0, ...rows.map((r) => r.authFailureSeq)),
    keyUsage,
    keyPace: keyPace.map((pace) => pace ?? 0),
    activeSessions,
  };
}

/**
 * Record that a key was used for a task (upsert key status + update task).
 */
export async function recordKeyUsage(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  taskId: string | null,
  scope = "global",
  scopeId: string | null = null,
  /** Plan id the worker detected on the credential (for example from the Codex JWT). */
  reportedPlan: string | null = null,
  planRaw?: string | null,
): Promise<{ planChanged: boolean }> {
  const now = new Date().toISOString();
  const storage = getStorage();
  const keys = storage.repos.config;
  return storage.transaction(async () => {
    // A local copy: a replayed attempt (decision D6) must start from the report.
    let plan = reportedPlan;
    const effectiveScopeId = scopeId ?? "";

    // Upsert key status record. Sets `provider` on insert (auto-derived from
    // keyType, see deriveProviderFromKeyType in src/utils/credentials.ts).
    // The `name` column is left null on insert and only set via the
    // setApiKeyName API endpoint when the user manually labels the key.
    const provider = deriveProviderFromKeyType(keyType);
    await keys.upsertKeyUsage(
      { keyType, keySuffix, scope, scopeId: effectiveScopeId },
      keyIndex,
      provider,
      now,
    );

    const ambiguousPro =
      keyType === "CODEX_OAUTH" &&
      (plan === "chatgpt_pro" || plan === "chatgpt_pro_5x" || plan === "chatgpt_pro_500");
    let planChanged = false;
    const rawIdentity = planRaw
      ? scrubSecrets(planRaw).slice(0, 80)
      : keyType === "CODEX_OAUTH" && plan === "chatgpt_pro"
        ? "pro"
        : null;
    // A legacy plan report must not retain a contradictory raw claim.
    if (rawIdentity || plan) {
      await keys.setDetectedPlanRaw(keyType, keySuffix, rawIdentity);
    }
    if (ambiguousPro || (keyType === "CODEX_OAUTH" && planRaw && !codexPlanFromClaim(planRaw))) {
      plan = null;
      planChanged = (await keys.setDetectedPlan(keyType, keySuffix, null)) > 0;
    }
    // A detected plan replaces an estimate, never a plan the operator picked.
    if (plan) {
      planChanged = (await keys.setDetectedPlan(keyType, keySuffix, plan)) > 0;
    }

    // Record which key was used on the task
    if (taskId) {
      await storage.repos.tasks.setTaskCredentialKey(taskId, keySuffix, keyType);
    }
    return { planChanged };
  });
}

/**
 * Set the subscription plan of a credential on all its scope rows, as picked
 * by the operator. `null` removes the manual choice, so the next detection
 * applies again. Returns false when no row exists for the credential.
 */
export async function setApiKeyPlan(
  keyType: string,
  keySuffix: string,
  plan: string | null,
): Promise<boolean> {
  const now = new Date().toISOString();
  return (await getStorage().repos.config.setManualPlan(keyType, keySuffix, plan, now)) > 0;
}

/**
 * Mark a key as rate-limited until a retry-after timestamp; never shortens an auth-failure bench.
 * `spendCap` records a provider spend limit behind it; an ordinary rate limit clears it.
 */
export async function markKeyRateLimited(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  rateLimitedUntil: string,
  scope = "global",
  scopeId: string | null = null,
  spendCap: SpendCap | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const provider = deriveProviderFromKeyType(keyType);
  await getStorage().repos.config.markRateLimited(
    { keyType, keySuffix, scope, scopeId: effectiveScopeId },
    {
      keyIndex,
      rateLimitedUntil,
      spendCap: spendCap ? JSON.stringify(spendCap) : null,
      provider,
      now,
      benchThreshold: CODEX_AUTH_FAILURE_BENCH_THRESHOLD,
    },
  );
}

export interface KeyAuthFailureResult {
  consecutiveAuthFailures: number;
  benched: boolean;
  rateLimitedUntil: string | null;
}

/** Count an auth failure, ordered by `authFailureSeq`; at the threshold, bench (extend only). */
export async function recordKeyAuthFailure(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  scope = "global",
  scopeId: string | null = null,
): Promise<KeyAuthFailureResult> {
  const effectiveScopeId = scopeId ?? "";
  const provider = deriveProviderFromKeyType(keyType);
  const storage = getStorage();
  const keys = storage.repos.config;
  const ref: ApiKeyRef = { keyType, keySuffix, scope, scopeId: effectiveScopeId };
  return await storage.transaction(async () => {
    const now = new Date().toISOString();
    const source = "report-auth-failure";
    const row = await keys.recordAuthFailure(ref, keyIndex, provider, now);
    if (!row) throw new Error("Failed to record auth failure");
    const { consecutiveAuthFailures } = row;
    if (consecutiveAuthFailures < CODEX_AUTH_FAILURE_BENCH_THRESHOLD) {
      return { consecutiveAuthFailures, benched: false, rateLimitedUntil: row.rateLimitedUntil };
    }
    let benchedUntil = new Date(Date.parse(now) + CODEX_AUTH_FAILURE_BENCH_MS).toISOString();
    if (row.rateLimitedUntil && Date.parse(row.rateLimitedUntil) > Date.parse(benchedUntil)) {
      benchedUntil = row.rateLimitedUntil;
    }
    await keys.benchKey(ref, benchedUntil, now);
    await upsertKv({
      namespace: CODEX_AUTH_WATCH_NAMESPACE,
      key: codexAuthBenchMarkerKey(keySuffix),
      valueType: "json",
      value: { keyIndex, keyType, benchedAt: now, benchedUntil, lastFailAt: now, source },
      expiresAt: Date.parse(benchedUntil) + 86_400_000,
    });
    return { consecutiveAuthFailures, benched: true, rateLimitedUntil: benchedUntil };
  });
}

/**
 * Persists reported window snapshots for a key. Admission
 * (`getAvailableKeyIndices`) reads these windows, so the read-merge-write
 * runs in one `BEGIN IMMEDIATE` transaction: two concurrent reports for the
 * same key (e.g. a Fable and an Opus rejection) both survive instead of the
 * later write dropping the earlier one.
 */
export async function recordKeyRateLimitWindows(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  windows: RateLimitWindowTelemetry,
  scope = "global",
  scopeId: string | null = null,
  account?: ProviderAccountTelemetry,
  replace: RateLimitReplacement[] = [],
): Promise<void> {
  if (Object.keys(windows).length === 0 && !account && !replace.length) return;

  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const provider = deriveProviderFromKeyType(keyType);
  const storage = getStorage();
  const keys = storage.repos.config;
  const ref: ApiKeyRef = { keyType, keySuffix, scope, scopeId: effectiveScopeId };
  await storage.transaction(async () => {
    const existing = await keys.getRateLimitWindows(ref);
    const { windows: mergedWindows, account: mergedAccount } = applyProviderQuotaReport(
      {
        windows: parseRateLimitWindowsJson(existing?.rateLimitWindows),
        account: parseProviderAccount(existing?.providerAccount),
      },
      scrubProviderQuotaReport({ windows, account, replace }),
    );
    assertProviderQuotaCapacity({ windows: mergedWindows, account: mergedAccount });
    await keys.upsertRateLimitWindows(ref, {
      keyIndex,
      rateLimitWindows: JSON.stringify(mergedWindows),
      providerAccount: mergedAccount ? JSON.stringify(mergedAccount) : null,
      provider,
      now,
    });
  });
}

/**
 * Set or clear the human-friendly `name` label on a pooled credential.
 * Identified by the natural key (keyType + keySuffix + scope + scopeId).
 * Returns true if a row was updated, false if no matching key exists.
 */
export async function setApiKeyName(
  keyType: string,
  keySuffix: string,
  name: string | null,
  scope = "global",
  scopeId: string | null = null,
): Promise<boolean> {
  const changes = await getStorage().repos.config.setKeyName(
    { keyType, keySuffix, scope, scopeId: scopeId ?? "" },
    name,
    new Date().toISOString(),
  );
  return changes > 0;
}

/**
 * Clear a stale rate-limit record after a successful use proves the key is healthy. With
 * `clearAuthBench` + `authFence` (the `authFailureFence` read before the task or credential write),
 * also lift an auth bench, reset the count and delete the Codex bench marker, but never for a
 * failure recorded after the fence. `keyIndex` (slot re-login) also retires the slot's other logins.
 */
export async function clearKeyRateLimit(
  keyType: string,
  keySuffix: string,
  scope = "global",
  scopeId: string | null = null,
  opts: { clearAuthBench?: boolean; keyIndex?: number; authFence?: number } = {},
): Promise<boolean> {
  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const { keyIndex = -1, authFence = null } = opts;
  const clearAuthBench = opts.clearAuthBench === true && authFence !== null;
  const storage = getStorage();
  const keys = storage.repos.config;
  return await storage.transaction(async () => {
    // The key's rows in every scope: `getAvailableKeyIndices` reads them all by suffix.
    const changes = await keys.clearRateLimit(keyType, keySuffix, {
      now,
      liftAuthBench: clearAuthBench,
      authFence,
      benchThreshold: CODEX_AUTH_FAILURE_BENCH_THRESHOLD,
    });
    const cleared = changes > 0;
    if (!clearAuthBench) return cleared;
    const lifted = await keys.liftAuthBench(
      { keyType, keySuffix, scope, scopeId: effectiveScopeId },
      { keyIndex, authFence, now },
    );
    const retired = lifted.filter((suffix) => suffix !== keySuffix);
    if (keyType === "CODEX_OAUTH") {
      for (const suffix of [...(cleared ? [keySuffix] : []), ...retired]) {
        await deleteKv(CODEX_AUTH_WATCH_NAMESPACE, codexAuthBenchMarkerKey(suffix));
      }
    }
    return cleared || retired.length > 0;
  });
}

/**
 * Get all key status records for a credential type.
 */
export async function getKeyStatuses(
  keyType?: string,
  scope?: string,
  scopeId?: string | null,
): Promise<ApiKeyStatus[]> {
  const rows = await getStorage().repos.config.listKeyStatuses({
    keyType,
    scope,
    scopeId: scopeId === undefined ? undefined : (scopeId ?? ""),
  });
  return rows.map(rowToApiKeyStatus);
}

export interface KeyCostSummary {
  keyType: string;
  keySuffix: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  taskCount: number;
}

/**
 * Aggregate cost data using immutable session credentials (legacy rows: the task's).
 */
export async function getKeyCostSummary(keyType?: string): Promise<KeyCostSummary[]> {
  return getStorage().repos.sessions.keyCostSummary(keyType);
}

// ============================================================================
// User Identity Operations
// ============================================================================

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  notes: string | null;
  emailAliases: string | null;
  preferredChannel: string | null;
  timezone: string | null;
  // Phase 064 columns
  metadata: string | null;
  dailyBudgetUsd: number | null;
  status: string;
  mergedIntoUserId: string | null;
  // Migration 344: JSON of UserAvatar. NULL = initials.
  avatar: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? undefined,
    role: row.role ?? undefined,
    notes: row.notes ?? undefined,
    emailAliases: row.emailAliases ? JSON.parse(row.emailAliases) : [],
    preferredChannel: row.preferredChannel ?? "slack",
    timezone: row.timezone ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    dailyBudgetUsd: row.dailyBudgetUsd ?? null,
    status: (row.status as "invited" | "active" | "suspended") ?? "active",
    ...(row.mergedIntoUserId ? { mergedIntoUserId: row.mergedIntoUserId } : {}),
    avatar: parseUserAvatar(row.avatar),
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export async function getUserById(id: string): Promise<User | null> {
  const row = await getStorage().repos.users.findUserById(id);
  return row ? rowToUser(row) : null;
}

export async function getAllUsers(): Promise<User[]> {
  const rows = await getStorage().repos.users.listUsers();
  return rows.map(rowToUser);
}

export async function createUser(data: {
  name: string;
  email?: string;
  role?: string;
  notes?: string;
  emailAliases?: string[];
  preferredChannel?: string;
  timezone?: string;
  metadata?: Record<string, unknown>;
  dailyBudgetUsd?: number | null;
  status?: "invited" | "active" | "suspended";
  avatar?: UserAvatar | null;
}): Promise<User> {
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const storage = getStorage();
  const row = await storage.repos.users.insertUser({
    id,
    name: data.name,
    email: data.email ?? null,
    role: data.role ?? null,
    notes: data.notes ?? null,
    emailAliases: JSON.stringify(data.emailAliases ?? []),
    preferredChannel: data.preferredChannel ?? "slack",
    timezone: data.timezone ?? null,
    metadata: data.metadata !== undefined ? JSON.stringify(data.metadata) : null,
    dailyBudgetUsd: data.dailyBudgetUsd ?? null,
    status: data.status ?? "active",
    avatar: data.avatar ? JSON.stringify(data.avatar) : null,
    now,
  });
  if (!row) throw new Error("Failed to create user");
  // The org's email domain may come from this user (debounced, post-commit).
  storage.afterCommit(scheduleOrgDomainRecompute);
  return rowToUser(row);
}

export async function updateUser(
  id: string,
  data: Partial<{
    name: string;
    email: string | null;
    role: string;
    notes: string;
    emailAliases: string[];
    preferredChannel: string;
    timezone: string;
    metadata: Record<string, unknown> | null;
    dailyBudgetUsd: number | null;
    status: "invited" | "active" | "suspended";
    // null resets to initials.
    avatar: UserAvatar | null;
  }>,
): Promise<User | null> {
  const update: import("@desplega/storage").UserColumnUpdate = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.email !== undefined) update.email = data.email;
  if (data.role !== undefined) update.role = data.role;
  if (data.notes !== undefined) update.notes = data.notes;
  if (data.emailAliases !== undefined) update.emailAliases = JSON.stringify(data.emailAliases);
  if (data.preferredChannel !== undefined) update.preferredChannel = data.preferredChannel;
  if (data.timezone !== undefined) update.timezone = data.timezone;
  if (data.metadata !== undefined)
    update.metadata = data.metadata === null ? null : JSON.stringify(data.metadata);
  if (data.dailyBudgetUsd !== undefined) update.dailyBudgetUsd = data.dailyBudgetUsd;
  if (data.status !== undefined) update.status = data.status;
  if (data.avatar !== undefined)
    update.avatar = data.avatar === null ? null : JSON.stringify(data.avatar);

  if (Object.keys(update).length === 0) return getUserById(id);

  const storage = getStorage();
  const row = await storage.repos.users.updateUser(id, update, new Date().toISOString());
  if (row) {
    storage.afterCommit(() => {
      invalidateTelemetryUserRole(id);
      scheduleOrgDomainRecompute();
    });
  }
  return row ? rowToUser(row) : null;
}

/**
 * Delete a user in one transaction, moving every retained reference to
 * `replacementUserId` (or clearing it). Used by the manage-user tool. The
 * merge route queues the same rewrite as a background job instead
 * (src/be/user-merge-jobs.ts, built on the same SQL from
 * src/be/db/user-references.ts), because on a large database this holds the
 * event loop for minutes.
 */
export async function deleteUser(id: string, replacementUserId?: string): Promise<boolean> {
  if (replacementUserId === id) {
    throw new Error("Replacement user must differ from deleted user");
  }

  return await getStorage().transaction(async () => {
    const users = getStorage().repos.users;
    if (!(await users.userExists(id))) return false;

    if (replacementUserId) {
      if (!(await users.userExists(replacementUserId))) {
        throw new Error("Replacement user not found");
      }
    }

    // Preserve rows that carry user attribution but lack ON DELETE semantics.
    // Schema discovery keeps this correct as new nullable user audit columns are added.
    // Migration 103 accidentally dropped the scheduled_tasks audit FKs while
    // recreating that table, so discover those two known logical references as
    // well until the table is next rebuilt with its original constraints.
    const references = await users.listUserReferenceColumns();
    const replacement = replacementUserId ?? null;
    // The human-free rule only asks whether a task's requester or its workflow
    // run's creator is NULL, so only clearing them (no replacement) can change a
    // stored flag. Gather the tasks now: after the rewrite nothing identifies
    // them. The workflow branch covers roots whose requester was never set.
    const reclassifySeedIds: string[] = replacementUserId
      ? []
      : await getStorage().repos.tasks.listTaskIdsRequestedByUser(id);
    // Workflow context is persisted JSON rather than a relational column, but
    // it exposes the same requester identity to downstream interpolation. Keep
    // it consistent with workflow_runs.created_by inside this transaction.
    // Migration 319 indexes the context requester expression, so these passes
    // touch only this user's runs instead of parsing the JSON of every row
    // (153 s on 493k prod rows). The sealed replay copy is what a resume
    // reads, so rewrite it first, while the scrubbed column still matches.
    const requesterRunIds = await users.listWorkflowRunIdsRequestedBy(id);
    const sealedContexts =
      requesterRunIds.length > 0
        ? await users.listSealedWorkflowContextsRequestedBy(requesterRunIds, id)
        : [];
    for (const row of sealedContexts) {
      let context: Record<string, unknown>;
      try {
        context = openSealedJson(row.context_replay) as Record<string, unknown>;
      } catch {
        // Unreadable replay state fails the run on resume
        // (WorkflowReplayStateError), so the stale id is never replayed.
        continue;
      }
      const swarm = { ...(context.swarm as Record<string, unknown> | undefined) };
      if (swarm.requestedByUserId !== id) continue;
      if (replacementUserId) swarm.requestedByUserId = replacementUserId;
      else delete swarm.requestedByUserId;
      await getStorage().repos.workflows.setRunContextReplay(
        row.id,
        sealJson({ ...context, swarm }),
      );
    }
    if (requesterRunIds.length > 0) {
      await users.rewriteWorkflowRunContextRequester(requesterRunIds, id, replacement);
    }

    // Migration 319 indexes every discovered column (the user-delete-perf test
    // pins the plans), so these are index lookups rather than table scans.
    for (const reference of references) {
      await users.rewriteUserReferenceColumn(reference, id, replacement);
    }

    await reclassifyTaskHumanFree(reclassifySeedIds);

    const deleted = await users.deleteUser(id);
    if (deleted > 0) {
      getStorage().afterCommit(() => {
        invalidateTelemetryUserRole(id);
        scheduleOrgDomainRecompute();
      });
    }
    return deleted > 0;
  });
}

// ============================================================================
// Inbox Item State (per-user dismiss/snooze/done for action-items inbox)
// ============================================================================

function rowToInboxItemState(row: InboxItemStateRow): InboxItemState {
  return {
    id: row.id,
    userId: row.userId,
    itemType: row.itemType as InboxItemType,
    itemId: row.itemId,
    status: row.status as InboxItemStatus,
    snoozeUntil: row.snoozeUntil ?? undefined,
    dismissedAt: row.dismissedAt ?? undefined,
    doneAt: row.doneAt ?? undefined,
    readAt: row.readAt ?? undefined,
    lastReadAt: row.lastReadAt ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export async function listInboxState(opts: {
  userId: string;
  status?: InboxItemStatus;
  itemType?: InboxItemType;
}): Promise<InboxItemState[]> {
  const rows = await getStorage().repos.messaging.listInboxItemStates(opts);
  return rows.map(rowToInboxItemState);
}

export async function upsertInboxState(opts: {
  userId: string;
  itemType: InboxItemType;
  itemId: string;
  status: InboxItemStatus;
  snoozeUntil?: string;
  dismissedAt?: string;
  doneAt?: string;
  /** First-viewed timestamp. Sticky: once set, later calls never clear or move it. */
  readAt?: string;
  lastReadAt?: string | null;
}): Promise<InboxItemState> {
  const now = new Date().toISOString();
  // Auto-derive timestamps from status when not explicitly provided.
  const dismissedAt = opts.dismissedAt ?? (opts.status === "dismissed" ? now : null);
  const doneAt = opts.doneAt ?? (opts.status === "done" ? now : null);
  const snoozeUntil = opts.snoozeUntil ?? null;
  const readAt = opts.readAt ?? null;

  // Upsert via UNIQUE(userId, itemType, itemId). readAt is sticky: the first
  // non-null value written wins on every subsequent conflict.
  // `triageSessionList` in src/be/db/session-tree.ts copies these conflict
  // rules for whole-list triage. Keep the two in step.
  const row = await getStorage().repos.messaging.upsertInboxItemState(
    {
      userId: opts.userId,
      itemType: opts.itemType,
      itemId: opts.itemId,
      status: opts.status,
      snoozeUntil,
      dismissedAt,
      doneAt,
      readAt,
      lastReadAt: opts.lastReadAt ?? null,
      createdAt: now,
      lastUpdatedAt: now,
    },
    opts.lastReadAt !== undefined,
  );
  if (!row) throw new Error("Failed to upsert inbox state");
  return rowToInboxItemState(row);
}

// ============================================================================
// User Favorites (principal-scoped stars for pages, workflows, and schedules)
// ============================================================================

interface UserFavoriteRow {
  id: string;
  favoriteScope: string;
  userId: string | null;
  itemType: string;
  itemId: string;
  createdAt: string;
  lastUpdatedAt: string;
  created_by: string | null;
  updated_by: string | null;
}

function rowToUserFavorite(row: UserFavoriteRow): UserFavorite {
  return {
    id: row.id,
    userId: row.userId ?? undefined,
    itemType: row.itemType as FavoriteItemType,
    itemId: row.itemId,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

export async function listFavorites(opts: {
  favoriteScope: string;
  itemType?: FavoriteItemType;
  itemIds?: string[];
}): Promise<UserFavorite[]> {
  const rows = await getStorage().repos.users.listFavorites(opts);
  return rows.map(rowToUserFavorite);
}

export async function listUserFavorites(opts: {
  userId: string;
  itemType?: FavoriteItemType;
  itemIds?: string[];
}): Promise<UserFavorite[]> {
  return listFavorites({ ...opts, favoriteScope: `user:${opts.userId}` });
}

export async function getFavoriteItemIdSet(opts: {
  favoriteScope: string;
  itemType: FavoriteItemType;
  itemIds?: string[];
}): Promise<Set<string>> {
  const favorites = await listFavorites(opts);
  return new Set(favorites.map((favorite) => favorite.itemId));
}

export async function setFavorite(opts: {
  favoriteScope: string;
  userId?: string | null;
  itemType: FavoriteItemType;
  itemId: string;
  favorite: boolean;
  actorId?: string | null;
}): Promise<UserFavorite | null> {
  // A `key` item id arrives normalized: `PUT /api/favorites` normalizes it and answers 400.
  const itemId = opts.itemId;
  if (!opts.favorite) {
    await getStorage().repos.users.deleteFavorite(opts.favoriteScope, opts.itemType, itemId);
    return null;
  }

  const now = new Date().toISOString();
  const actor = opts.actorId ?? opts.userId ?? opts.favoriteScope;
  const row = await getStorage().repos.users.upsertFavorite({
    favoriteScope: opts.favoriteScope,
    userId: opts.userId ?? null,
    itemType: opts.itemType,
    itemId,
    actor,
    now,
  });
  if (!row) throw new Error("Failed to set favorite");
  return rowToUserFavorite(row);
}

export async function setUserFavorite(opts: {
  userId: string;
  itemType: FavoriteItemType;
  itemId: string;
  favorite: boolean;
  actorUserId?: string | null;
}): Promise<UserFavorite | null> {
  return setFavorite({
    ...opts,
    favoriteScope: `user:${opts.userId}`,
    actorId: opts.actorUserId,
  });
}

export async function withFavoriteFlags<T extends { id: string }>(
  rows: T[],
  opts: { favoriteScope?: string | null; itemType: FavoriteItemType },
): Promise<Array<T & { favorite: boolean }>> {
  if (!opts.favoriteScope || rows.length === 0) {
    return rows.map((row) => ({ ...row, favorite: false }));
  }
  const favoriteIds = await getFavoriteItemIdSet({
    favoriteScope: opts.favoriteScope,
    itemType: opts.itemType,
    itemIds: rows.map((row) => row.id),
  });
  return rows.map((row) => ({ ...row, favorite: favoriteIds.has(row.id) }));
}

// ============================================================================
// Task Templates ("To start" bucket — polymorphic starters registry)
// ============================================================================

function rowToTaskTemplate(row: TaskTemplateRow): TaskTemplate {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {}
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags);
  } catch {}
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    prompt: row.prompt,
    kind: row.kind as TaskTemplateKind,
    payload,
    category: row.category ?? undefined,
    tags,
    createdAt: row.createdAt,
  };
}

export async function listTaskTemplates(opts?: {
  category?: string;
  kind?: TaskTemplateKind;
  query?: string;
}): Promise<TaskTemplate[]> {
  // `query` is a case-insensitive match against title OR description.
  const rows = await getStorage().repos.tasks.listTaskTemplates(opts ?? {});
  return rows.map(rowToTaskTemplate);
}

// ============================================================================
// Sessions — root task chain + recent-sessions list
// ============================================================================

/**
 * Walk the chain rooted at `rootTaskId`, ordered by `createdAt` (root first; `rowid` breaks
 * ties as idx_agent_tasks_created did). `CROSS JOIN` keeps the chain as the outer loop: with
 * a plain JOIN, SQLite scanned all of agent_tasks to skip the sort. Each task carries its
 * `totalCostUsd`, so the session header can total the whole chain, not only the root.
 */
export async function getRootTaskChain(rootTaskId: string): Promise<AgentTask[]> {
  const rows = (await getStorage().repos.sessions.listChainWithCosts(rootTaskId)) as AgentTaskRow[];
  return rows.map(rowToAgentTask);
}

export interface SessionListItem extends SessionRowFields {
  root: AgentTask;
  chainTaskCount: number;
  lastActivityAt: string;
  latestStatus: AgentTaskStatus;
}

/**
 * Slim variant of {@link SessionListItem} — the `root` task is an
 * `AgentTaskSummary` (full `task` text + completion/integration blobs dropped).
 * The session list only renders a brief of the root; the full root + chain are
 * on `GET /api/sessions/{rootTaskId}`.
 */
export interface SessionListItemSummary extends SessionRowFields {
  root: AgentTaskSummary;
  chainTaskCount: number;
  lastActivityAt: string;
  latestStatus: AgentTaskStatus;
}

interface ListRecentSessionsOpts extends SessionFilters {
  limit?: number;
  offset?: number;
  /** Return a slim root task summary instead of the full task. */
  slim?: boolean;
}

export async function listRecentSessions(
  opts?: ListRecentSessionsOpts & { slim?: false },
): Promise<SessionListItem[]>;
export async function listRecentSessions(
  opts: ListRecentSessionsOpts & { slim: true },
): Promise<SessionListItemSummary[]>;
export async function listRecentSessions(
  opts: ListRecentSessionsOpts = {},
): Promise<SessionListItem[] | SessionListItemSummary[]> {
  const rootRows = await listSessionPageRows<
    AgentTaskRow & {
      __chainCount: number;
      __lastActivityAt: string;
      __latestStatus: AgentTaskStatus;
      __readState: SessionReadState | null;
      __snoozeUntil: string | null;
      __needsYou: number;
      __threadRoots: number;
    }
  >(opts);
  const fields = await sessionPageFields(
    rootRows.map((row) => ({
      id: row.id,
      requestedByUserId: row.requestedByUserId ?? undefined,
    })),
  );
  return rootRows.map((row) => ({
    root: opts.slim ? rowToAgentTaskSummary(row) : rowToAgentTask(row),
    chainTaskCount: row.__chainCount,
    lastActivityAt: row.__lastActivityAt,
    latestStatus: row.__latestStatus,
    ...(row.__readState ? { readState: row.__readState } : {}),
    snoozeUntil: row.__snoozeUntil,
    needsYou: !!row.__needsYou,
    groupKey: sessionThreadGroupKey(row.key, row.__threadRoots),
    ...fields.get(row.id),
  }));
}

/** Count roots directly unless a filter needs chain activity or participants. */
export async function countSessions(opts: SessionFilters = {}): Promise<number> {
  return countSessionRoots(opts);
}

// ============================================================================
// Budgets, daily-spend aggregation, and budget-refusal notifications (Phase 2)
// ----------------------------------------------------------------------------
// `budgets` and `budget_refusal_notifications` use INTEGER epoch-ms for their
// `createdAt` / `lastUpdatedAt` columns (deliberate divergence — see migration
// 044). All inserts here use `Date.now()` accordingly.
// ============================================================================

function rowToBudget(row: BudgetRowDb): Budget {
  return {
    scope: row.scope as BudgetScope,
    scopeId: row.scope_id,
    dailyBudgetUsd: row.daily_budget_usd,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

function rowToBudgetRefusalNotification(
  row: BudgetRefusalNotificationRowDb,
): BudgetRefusalNotification {
  return {
    taskId: row.task_id,
    date: row.date,
    agentId: row.agent_id,
    cause: row.cause as BudgetRefusalCause,
    agentSpendUsd: row.agent_spend_usd ?? undefined,
    agentBudgetUsd: row.agent_budget_usd ?? undefined,
    globalSpendUsd: row.global_spend_usd ?? undefined,
    globalBudgetUsd: row.global_budget_usd ?? undefined,
    userSpendUsd: row.user_spend_usd ?? undefined,
    userBudgetUsd: row.user_budget_usd ?? undefined,
    followUpTaskId: row.follow_up_task_id ?? undefined,
    createdAt: row.createdAt,
  };
}

/**
 * Look up a single budget row by (scope, scopeId). Returns `null` when no row
 * exists — callers treat that as "unlimited / no budget configured".
 */
export async function getBudget(scope: BudgetScope, scopeId: string): Promise<Budget | null> {
  const row = await getStorage().repos.sessions.findBudget(scope, scopeId);
  return row ? rowToBudget(row) : null;
}

/**
 * Phase 6: list every budget row in the system. Used by `GET /api/budgets`.
 * Order is `(scope, scope_id)` for stable output across calls.
 */
export async function getBudgets(): Promise<Budget[]> {
  const rows = await getStorage().repos.sessions.listBudgets();
  return rows.map(rowToBudget);
}

/**
 * Phase 6: upsert a budget row. Creates the row if `(scope, scopeId)` does not
 * exist, otherwise updates `daily_budget_usd` and `lastUpdatedAt`. Returns the
 * resulting row in both cases.
 */
export async function upsertBudget(
  scope: BudgetScope,
  scopeId: string,
  dailyBudgetUsd: number,
): Promise<Budget> {
  const now = Date.now();
  await getStorage().repos.sessions.upsertBudget(scope, scopeId, dailyBudgetUsd, now);

  const updated = await getBudget(scope, scopeId);
  if (!updated) {
    throw new Error(
      `upsertBudget: row missing after insert for (scope=${scope}, scopeId=${scopeId})`,
    );
  }
  return updated;
}

/**
 * Phase 6: delete a budget row. Returns `true` if a row was deleted, `false`
 * if `(scope, scopeId)` did not exist.
 */
export async function deleteBudget(scope: BudgetScope, scopeId: string): Promise<boolean> {
  return (await getStorage().repos.sessions.deleteBudget(scope, scopeId)) > 0;
}

// ============================================================================
// Pricing rows (Phase 6 — append-only price book)
// ----------------------------------------------------------------------------
// `pricing` uses INTEGER epoch-ms for `effective_from`, `createdAt`,
// `lastUpdatedAt` (see migration 044). Append-only by design: operators add a
// new row with a later `effective_from` rather than mutating an existing row.
// `getActivePricingRow` resolves the row with the largest
// `effective_from <= atEpochMs`, which is the correct "what price was in
// effect at time T" semantics regardless of insertion order.
// ============================================================================

function rowToPricingRow(row: PricingRowDb): PricingRow {
  return {
    provider: row.provider as PricingProvider,
    model: row.model,
    tokenClass: row.token_class as PricingTokenClass,
    effectiveFrom: row.effective_from,
    pricePerMillionUsd: row.price_per_million_usd,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

/** Phase 6: list every pricing row, latest-effective first. */
export async function getAllPricingRows(): Promise<PricingRow[]> {
  const rows = await getStorage().repos.sessions.listPricingRows();
  return rows.map(rowToPricingRow);
}

/**
 * Phase 6: list every pricing row for a given (provider, model, tokenClass)
 * triple. Order is `effective_from DESC` so newest is first.
 */
export async function getPricingRows(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
): Promise<PricingRow[]> {
  const rows = await getStorage().repos.sessions.listPricingRowsFor(provider, model, tokenClass);
  return rows.map(rowToPricingRow);
}

/**
 * Phase 6: resolve "what price was in effect at time `atEpochMs`" — the row
 * with the largest `effective_from <= atEpochMs`. Returns null when no row
 * matches (model unseeded for that triple at that time). Backed by the
 * `idx_pricing_lookup` index from migration 044.
 */
export async function getActivePricingRow(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
  atEpochMs: number,
): Promise<PricingRow | null> {
  const row = await getStorage().repos.sessions.findActivePricingRow(
    provider,
    model,
    tokenClass,
    atEpochMs,
  );
  return row ? rowToPricingRow(row) : null;
}

export interface InsertPricingRowInput {
  provider: PricingProvider;
  model: string;
  tokenClass: PricingTokenClass;
  effectiveFrom: number;
  pricePerMillionUsd: number;
}

/**
 * Phase 6: insert a new pricing row. Throws on PK collision
 * `(provider, model, token_class, effective_from)` — caller (the HTTP route)
 * translates that into a 409.
 */
export async function insertPricingRow(input: InsertPricingRowInput): Promise<PricingRow> {
  const now = Date.now();
  await getStorage().repos.sessions.insertPricingRow({
    provider: input.provider,
    model: input.model,
    token_class: input.tokenClass,
    effective_from: input.effectiveFrom,
    price_per_million_usd: input.pricePerMillionUsd,
    createdAt: now,
    lastUpdatedAt: now,
  });
  return {
    provider: input.provider,
    model: input.model,
    tokenClass: input.tokenClass,
    effectiveFrom: input.effectiveFrom,
    pricePerMillionUsd: input.pricePerMillionUsd,
    createdAt: now,
    lastUpdatedAt: now,
  };
}

/**
 * Phase 6: delete a pricing row. Returns true if a row was deleted, false if
 * the row did not exist. Discouraged operationally — historical session_costs
 * are not retroactively recomputed — but allowed for typo correction.
 */
export async function deletePricingRow(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
  effectiveFrom: number,
): Promise<boolean> {
  return (
    (await getStorage().repos.sessions.deletePricingRow(
      provider,
      model,
      tokenClass,
      effectiveFrom,
    )) > 0
  );
}

/**
 * Sum of `totalCostUsd` across all `session_costs` rows for a given agent on a
 * given UTC calendar day. `dateUtc` MUST be `'YYYY-MM-DD'` (UTC). Returns 0
 * when no rows exist.
 *
 * Implementation note: we filter on `substr(createdAt, 1, 10) = ?` rather than
 * `date(createdAt / 1000, 'unixepoch') = ?` because `session_costs.createdAt`
 * is TEXT in ISO 8601 format (`'YYYY-MM-DDTHH:MM:SS.SSSZ'`), populated via
 * `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`. The left-anchored `substr` prefix
 * also lets the SQLite optimizer use the existing
 * `idx_session_costs_agent_createdAt` index (verified via EXPLAIN QUERY PLAN
 * in the test suite).
 */
export async function getDailySpendForAgent(agentId: string, dateUtc: string): Promise<number> {
  return getStorage().repos.sessions.dailySpendForAgent(agentId, dateUtc);
}

/**
 * Sum of `totalCostUsd` across all `session_costs` rows for a given UTC
 * calendar day, regardless of agent. `dateUtc` MUST be `'YYYY-MM-DD'` (UTC).
 *
 * NOTE: this query has no `agentId` prefix and therefore does not naturally
 * match the `(agentId, createdAt)` composite index. SQLite's optimizer may
 * pick `idx_session_costs_createdAt` (single-column on `createdAt`) — but
 * because the predicate is `substr(createdAt, 1, 10) = ?` rather than a range
 * scan, the planner often falls back to a full table scan. That is acceptable
 * for V1 daily-spend volumes; if it ever becomes a hotspot, a covering
 * functional index on `substr(createdAt, 1, 10)` would be the fix.
 */
export async function getDailySpendGlobal(dateUtc: string): Promise<number> {
  return getStorage().repos.sessions.dailySpendGlobal(dateUtc);
}

/**
 * Sum of `totalCostUsd` across all `session_costs` rows whose task was
 * requested by a given user on a given UTC calendar day. `dateUtc` MUST be
 * `'YYYY-MM-DD'` (UTC). Costs are joined through `agent_tasks` deliberately;
 * `session_costs` stays task/session-scoped and does not grow a userId column.
 */
export async function getDailySpendForUser(userId: string, dateUtc: string): Promise<number> {
  return getStorage().repos.sessions.dailySpendForUser(userId, dateUtc);
}

export interface RecordBudgetRefusalNotificationInput {
  taskId: string;
  date: string;
  agentId: string;
  cause: BudgetRefusalCause;
  agentSpendUsd?: number;
  agentBudgetUsd?: number;
  globalSpendUsd?: number;
  globalBudgetUsd?: number;
  userSpendUsd?: number;
  userBudgetUsd?: number;
}

/**
 * Idempotent insert of a budget-refusal notification keyed by
 * `(task_id, date)`. Returns `{ inserted: true, row }` on first call for that
 * key, or `{ inserted: false, row }` (with the original row) on subsequent
 * calls — used by the notification path to dedup "the agent told me about
 * this task already" across retries within the same UTC day.
 */
export async function recordBudgetRefusalNotification(
  input: RecordBudgetRefusalNotificationInput,
): Promise<{
  inserted: boolean;
  row: BudgetRefusalNotification;
}> {
  const now = Date.now();
  const inserted = await getStorage().repos.sessions.insertBudgetRefusalNotification({
    task_id: input.taskId,
    date: input.date,
    agent_id: input.agentId,
    cause: input.cause,
    agent_spend_usd: input.agentSpendUsd ?? null,
    agent_budget_usd: input.agentBudgetUsd ?? null,
    global_spend_usd: input.globalSpendUsd ?? null,
    global_budget_usd: input.globalBudgetUsd ?? null,
    user_spend_usd: input.userSpendUsd ?? null,
    user_budget_usd: input.userBudgetUsd ?? null,
    createdAt: now,
  });

  const existing = await getStorage().repos.sessions.findBudgetRefusalNotification(
    input.taskId,
    input.date,
  );

  if (!existing) {
    // Should be unreachable: INSERT OR IGNORE either inserts or leaves an
    // existing row. If we hit this it's a hard schema/runtime invariant break.
    throw new Error(
      `recordBudgetRefusalNotification: row missing after insert for (taskId=${input.taskId}, date=${input.date})`,
    );
  }

  return {
    inserted: inserted > 0,
    row: rowToBudgetRefusalNotification(existing),
  };
}

/**
 * Lookup helper used by tests and by the Phase 5 follow-up-task write-back.
 */
export async function getBudgetRefusalNotification(
  taskId: string,
  date: string,
): Promise<BudgetRefusalNotification | null> {
  const row = await getStorage().repos.sessions.findBudgetRefusalNotification(taskId, date);
  return row ? rowToBudgetRefusalNotification(row) : null;
}

/**
 * List recent budget refusal notifications across all tasks/dates, newest
 * first. Used by the operator dashboard to surface refusals as an
 * actionable feed (parent task → follow-up task link).
 */
export async function getRecentBudgetRefusalNotifications(
  limit = 50,
): Promise<BudgetRefusalNotification[]> {
  const rows = await getStorage().repos.sessions.listRecentBudgetRefusalNotifications(limit);
  return rows.map(rowToBudgetRefusalNotification);
}

/**
 * Boolean observability helper — returns true iff a refusal notification has
 * already been recorded for `(taskId, date)`.
 */
export async function hasBudgetRefusalNotificationToday(
  taskId: string,
  date: string,
): Promise<boolean> {
  return getStorage().repos.sessions.hasBudgetRefusalNotification(taskId, date);
}

/**
 * Phase 5 write-back: link the freshly-created lead-facing follow-up task
 * back to its dedup row so operators can audit "find the lead-facing
 * follow-up that was created when this task was first refused".
 *
 * Idempotent — safe to call multiple times with the same `(taskId, date)`,
 * but only the first refusal per day creates a follow-up task in the first
 * place (see `recordBudgetRefusalNotification` for the dedup invariant).
 */
export async function setBudgetRefusalFollowUpTaskId(
  taskId: string,
  date: string,
  followUpTaskId: string,
): Promise<void> {
  await getStorage().repos.sessions.setBudgetRefusalFollowUpTaskId(taskId, date, followUpTaskId);
}

// ============================================================================
// /status helpers — instance activity + first-task milestone
// ============================================================================

/**
 * Count agents that have heartbeated within the last `minutes` minutes,
 * grouped by lead/worker. Used by the `workers` setup milestone on
 * `GET /status` to flip from `configured` → `verified` only when both a lead
 * and at least one worker are alive.
 *
 * "Recent" defaults to 5 minutes — a multiple of `ACTIVITY_THROTTLE_MS = 5_000`
 * (`src/providers/swarm-events-shared.ts:48-49`) plus margin for missed
 * heartbeats. Agents with `status = 'offline'` are excluded.
 */
export async function getLiveAgentCounts(minutes: number = 5): Promise<{
  leads_alive: number;
  workers_alive: number;
}> {
  const row = await getStorage().repos.agents.countLiveAgents(minutes);
  return {
    leads_alive: row?.leads_alive ?? 0,
    workers_alive: row?.workers_alive ?? 0,
  };
}

/**
 * Leads and workers that can take work right now (status idle or busy). Used
 * by the onboarding signals: the step 6 agents readout uses the same rule,
 * while the `/status` heartbeat window (`lastActivityAt`) lags for idle agents.
 */
export async function getReadyAgentCounts(): Promise<{ leads: number; workers: number }> {
  const row = await getStorage().repos.agents.countReadyAgents();
  return { leads: row?.leads ?? 0, workers: row?.workers ?? 0 };
}

/**
 * Aggregate activity numbers for `GET /status`'s `activity` block.
 * - `agents_online` / `leads_online`: heartbeated within the last 5 minutes.
 * - `recent_tasks_count`: agent_tasks rows created in the last 24 hours.
 *
 * `agents_online` reports total alive agents (leads + workers) so the home
 * page can show a single "online" stat without summing on the client.
 */
export async function getInstanceActivity(): Promise<{
  agents_online: number;
  leads_online: number;
  recent_tasks_count: number;
}> {
  const { leads_alive, workers_alive } = await getLiveAgentCounts(5);
  const recentTasks = await getStorage().repos.tasks.countTasksCreatedLastDay();
  return {
    agents_online: leads_alive + workers_alive,
    leads_online: leads_alive,
    recent_tasks_count: recentTasks,
  };
}

export interface SwarmMetrics {
  tasks: { total: number; by_status: Record<string, number> };
  agents: { total: number; by_status: Record<string, number> };
  workflows: { total: number; enabled: number };
  pages: { total: number };
  sessions: { active: number };
  skills: { total: number };
}

/**
 * Lightweight swarm-wide counts for UI footers/sidebars and MCP context —
 * a single object so callers never have to fetch full list payloads just to
 * count. Pure `COUNT(*)` / `GROUP BY` queries; the `agent_tasks` status
 * grouping rides the indexes added in migration 069.
 */
export async function getSwarmMetrics(): Promise<SwarmMetrics> {
  const repos = getStorage().repos;
  const groupCounts = (
    rows: { status: string; count: number }[],
  ): { total: number; by_status: Record<string, number> } => {
    const by_status: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      by_status[r.status] = r.count;
      total += r.count;
    }
    return { total, by_status };
  };

  const workflowRow = await repos.workflows.countWorkflows();
  const pages = await repos.pages.countPages({});
  const sessions = await repos.agents.countActiveSessions();
  const skills = await repos.skills.countSkills();

  return {
    tasks: groupCounts(await repos.tasks.countTasksByStatus()),
    agents: groupCounts(await repos.agents.countAgentsByStatus()),
    workflows: { total: workflowRow?.total ?? 0, enabled: workflowRow?.enabled ?? 0 },
    pages: { total: pages },
    sessions: { active: sessions },
    skills: { total: skills },
  };
}

/**
 * `first_task` milestone: true once any task has reached `status = 'completed'`.
 * Cheap LIMIT 1 probe; the row's contents don't matter, only existence.
 */
export async function hasFirstCompletedTask(): Promise<boolean> {
  return await getStorage().repos.tasks.hasCompletedTask();
}

// ============================================================================
// KV store (kv_entries)
// ============================================================================
//
// Namespaced key/value with lazy expire-on-read TTL. See:
//   - src/be/migrations/061_kv_store.sql (schema)
//   - src/http/kv.ts                     (REST surface + namespace resolution)
//   - src/tools/kv/*                     (MCP surface)
//
// Conventions:
//   - All sizing / regex validation happens at the HTTP / MCP boundary so the
//     helpers below can assume well-formed inputs.
//   - `value` is stored verbatim in TEXT; helpers decode based on value_type.
//   - "now" is `unixepoch('subsec') * 1000` (unix-ms), consistent with the
//     migration's DEFAULTs — using JS `Date.now()` for the few helpers that
//     need to mention an explicit timestamp keeps the math identical at ms
//     resolution.

interface KvRow {
  namespace: string;
  key: string;
  value: string;
  value_type: KvValueType;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function decodeKvRow(row: KvRow): KvEntry {
  let value: unknown;
  if (row.value_type === "json") {
    try {
      value = JSON.parse(row.value);
    } catch {
      // Stored JSON is corrupt — surface as raw string rather than throwing
      // on read; the row is still recoverable by the caller.
      value = row.value;
    }
  } else if (row.value_type === "integer") {
    value = Number(row.value);
  } else {
    value = row.value;
  }
  return {
    namespace: row.namespace,
    key: row.key,
    value,
    valueType: row.value_type,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeKvValue(value: unknown, valueType: KvValueType): string {
  if (valueType === "json") {
    return JSON.stringify(value);
  }
  if (valueType === "integer") {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
        throw new Error("integer value must be a JS-safe integer");
      }
      return String(value);
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      return value;
    }
    throw new Error("integer value must be a JS-safe integer");
  }
  // 'string'
  if (typeof value !== "string") {
    throw new Error("string value must be a string");
  }
  return value;
}

/**
 * Get a single KV entry. Returns null if missing OR expired; expired rows are
 * deleted inline (single-row DELETE WHERE) so the row count stays bounded over
 * time without a background sweeper.
 */
export async function getKv(namespace: string, key: string): Promise<KvEntry | null> {
  const kv = getStorage().repos.kv;
  const row = (await kv.findEntry(namespace, key)) as KvRow | null;
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    await kv.deleteEntry(namespace, key);
    return null;
  }
  return decodeKvRow(row);
}

/** Delete expired entries in one namespace. Used by internal TTL-backed stores
 * that need proactive cleanup rather than waiting for a point read. */
export async function sweepExpiredKv(namespace: string, now = Date.now()): Promise<number> {
  return await getStorage().repos.kv.deleteExpired(namespace, now);
}

/** Delete expired entries across a namespace family (`prefix` and
 * `prefix:*`). Used by per-agent internal stores whose inactive owners may
 * never return to trigger a namespace-local sweep. */
export async function sweepExpiredKvPrefix(
  prefix: string,
  now = Date.now(),
  /** Rows per DELETE, capped at 50 for multi-MB values. Yields between batches. */
  batchSize = 50,
): Promise<number> {
  batchSize = Math.max(1, Math.min(batchSize, 50));
  const escaped = prefix.replace(/[\\%_]/g, "\\$&");
  // Batched, with a macrotask yield between batches: one DELETE of every
  // expired multi-MB overflow row blocked the event loop for seconds and
  // starved the Slack socket ping. `now` is fixed for the whole sweep, so the
  // batches delete the same row set as one statement. kv_entries is WITHOUT
  // ROWID, so a batch selects the (namespace, key) primary key.
  let removed = 0;
  for (;;) {
    const changes = await getStorage().repos.kv.deleteExpiredInFamilyBatch(
      prefix,
      `${escaped}:%`,
      now,
      batchSize,
    );
    removed += changes;
    if (changes < batchSize) return removed;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Upsert a KV entry. Caller passes the decoded value + valueType; we encode
 * before storing. `expiresAt` is unix-ms (NULL means no expiry).
 *
 * If the key already exists with a different `valueType` we still overwrite —
 * INCR is the only collision-sensitive op and it does its own check.
 */
export async function upsertKv(input: {
  namespace: string;
  key: string;
  value: unknown;
  valueType: KvValueType;
  expiresAt?: number | null;
}): Promise<KvEntry> {
  const encoded = encodeKvValue(input.value, input.valueType);
  const expiresAt = input.expiresAt ?? null;
  const now = Date.now();
  const row = (await getStorage().repos.kv.upsertEntry({
    namespace: input.namespace,
    key: input.key,
    value: encoded,
    value_type: input.valueType,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  })) as KvRow | null;
  if (!row) throw new Error("Failed to upsert kv entry");
  return decodeKvRow(row);
}

/**
 * Insert a KV entry only when the key is absent or expired (mirrors `getKv`'s
 * lazy-expiry semantics). Returns true when this caller created or refreshed
 * the entry, false when a live entry already existed. A single conditional
 * write, so it is safe as a concurrency claim (e.g. webhook dedup) where a
 * get-then-upsert pair would let two concurrent callers both win.
 */
export async function claimKv(input: {
  namespace: string;
  key: string;
  value: unknown;
  valueType: KvValueType;
  expiresAt?: number | null;
}): Promise<boolean> {
  const encoded = encodeKvValue(input.value, input.valueType);
  const expiresAt = input.expiresAt ?? null;
  const now = Date.now();
  const changes = await getStorage().repos.kv.claimEntry(
    {
      namespace: input.namespace,
      key: input.key,
      value: encoded,
      value_type: input.valueType,
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
    },
    now,
  );
  return changes > 0;
}

/**
 * Delete a KV entry. Returns true if a row was removed, false if nothing
 * existed. Does not differentiate expired-but-not-yet-swept from never-existed.
 */
export async function deleteKv(namespace: string, key: string): Promise<boolean> {
  return (await getStorage().repos.kv.deleteEntry(namespace, key)) > 0;
}

export class KvTypeCollisionError extends Error {
  readonly existingType: KvValueType;
  constructor(existingType: KvValueType) {
    super(`Cannot INCR a key with value_type '${existingType}'`);
    this.name = "KvTypeCollisionError";
    this.existingType = existingType;
  }
}

/**
 * Atomically increment an integer KV entry. Creates the entry (set to `by`)
 * if it doesn't exist or has expired. Throws `KvTypeCollisionError` if the
 * existing row's `value_type` is not 'integer' — the HTTP layer maps that to
 * 409.
 */
export async function incrKv(namespace: string, key: string, by: number): Promise<KvEntry> {
  if (!Number.isInteger(by) || !Number.isSafeInteger(by)) {
    throw new Error("INCR `by` must be a JS-safe integer");
  }
  const storage = getStorage();
  const kv = storage.repos.kv;
  return await storage.transaction(async (): Promise<KvEntry> => {
    const existing = (await kv.findEntry(namespace, key)) as KvRow | null;

    const now = Date.now();
    const expired =
      existing?.expires_at !== null &&
      existing !== null &&
      existing.expires_at !== null &&
      existing.expires_at <= now;

    if (!existing || expired) {
      // Insert (or replace if expired). `upsertKv` re-enters the prepared
      // statement cache cheaply; inlining keeps this in one transaction.
      const row = (await kv.upsertEntry({
        namespace,
        key,
        value: String(by),
        value_type: "integer",
        expires_at: null,
        created_at: now,
        updated_at: now,
      })) as KvRow | null;
      if (!row) throw new Error("Failed to insert kv entry on INCR");
      return decodeKvRow(row);
    }

    if (existing.value_type !== "integer") {
      throw new KvTypeCollisionError(existing.value_type);
    }

    const current = Number(existing.value);
    if (!Number.isSafeInteger(current)) {
      throw new Error("Stored integer KV value is not a JS-safe integer");
    }
    const next = current + by;
    if (!Number.isSafeInteger(next)) {
      throw new Error("INCR would overflow JS-safe integer range");
    }

    const row = (await kv.setEntryValue(namespace, key, String(next), now)) as KvRow | null;
    if (!row) throw new Error("Failed to update kv entry on INCR");
    return decodeKvRow(row);
  });
}

/**
 * Smallest string greater than every string that starts with `prefix`, in
 * code-point order (which is SQLite's BINARY order over UTF-8). `null` means
 * no upper bound exists (the prefix is all U+10FFFF).
 */
export function kvPrefixUpperBound(prefix: string): string | null {
  const codePoints = Array.from(prefix);
  while (codePoints.length > 0) {
    const last = codePoints.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) {
      const next = last + 1 === 0xd800 ? 0xe000 : last + 1;
      return codePoints.join("") + String.fromCodePoint(next);
    }
  }
  return null;
}

/**
 * Key-prefix predicate as a range on the (namespace, key) primary key.
 * `key LIKE 'p%'` cannot use that index (LIKE is case-insensitive, the PK is
 * BINARY), so it scanned every row of the namespace. A range seeks straight
 * to the prefix and matches it exactly (case-sensitive).
 */
function kvPrefixCondition(prefix: string | undefined): KvKeyRange {
  if (prefix === undefined || prefix.length === 0) return {};
  const upper = kvPrefixUpperBound(prefix);
  return upper === null ? { from: prefix } : { from: prefix, before: upper };
}

/** Top-level JSON field equality, evaluated in SQLite before rows reach JS. */
export type KvJsonFieldEquals = { field: string; value: string | number | boolean };

function kvJsonFieldConditions(filters: KvJsonFieldEquals[] | undefined): KvJsonFieldFilter[] {
  const out: KvJsonFieldFilter[] = [];
  for (const filter of filters ?? []) {
    // JSON path quoting has no escape for these characters.
    if (/["\\]/.test(filter.field)) {
      throw new Error(`unsupported JSON field name: ${filter.field}`);
    }
    // Only safe integers compare exactly: SQLite parses a stored literal like
    // 1000000000000000100 as an exact INTEGER (and fractions with its own
    // float parser) while the bound JS number is a double, so SQL could drop
    // a row that JS `===` matches. Other numbers are left to the caller.
    if (typeof filter.value === "number" && !Number.isSafeInteger(filter.value)) continue;
    out.push({ path: `$."${filter.field}"`, value: filter.value });
  }
  return out;
}

/**
 * List entries in a namespace, optionally filtered by prefix. Expired rows
 * are filtered out by the SELECT (no inline DELETE — listing should be a
 * stable cursor; sweeping happens on point-reads instead).
 *
 * `jsonFieldEquals` narrows the rows in SQL so non-matching values are never
 * decoded. SQL equality is looser than JS `===` (JSON `true` equals `1`) and
 * numbers that are not safe integers are not filtered at all, so callers that
 * need exact semantics re-check the decoded values.
 *
 * `limit` is capped by the caller (HTTP enforces ≤1000); helper does no extra
 * bounds-check beyond what SQL accepts.
 */
export async function listKv(
  namespace: string,
  opts: {
    prefix?: string;
    limit: number;
    offset: number;
    jsonFieldEquals?: KvJsonFieldEquals[];
    /**
     * Scan only the keys after `keyAfter` (through `keyThrough`, else to the end of the
     * prefix). Replaces the prefix range: one range per column keeps SQLite from
     * walking past the window.
     */
    keyAfter?: string;
    keyThrough?: string;
  },
): Promise<KvEntry[]> {
  const now = Date.now();
  const upper = opts.prefix === undefined ? null : kvPrefixUpperBound(opts.prefix);
  const range: KvKeyRange =
    opts.keyAfter === undefined
      ? kvPrefixCondition(opts.prefix)
      : opts.keyThrough !== undefined
        ? { after: opts.keyAfter, through: opts.keyThrough }
        : upper === null
          ? { after: opts.keyAfter }
          : { after: opts.keyAfter, before: upper };
  const rows = (await getStorage().repos.kv.listLiveEntries(namespace, {
    nowMs: now,
    range,
    jsonFieldEquals: kvJsonFieldConditions(opts.jsonFieldEquals),
    limit: opts.limit,
    offset: opts.offset,
  })) as KvRow[];
  return rows.map(decodeKvRow);
}

/**
 * Count entries in a namespace (optionally with a prefix filter). Expired
 * rows are excluded — same predicate as `listKv`.
 */
export async function countKv(namespace: string, opts: { prefix?: string }): Promise<number> {
  const now = Date.now();
  return await getStorage().repos.kv.countLiveEntries(
    namespace,
    now,
    kvPrefixCondition(opts.prefix),
  );
}

// ─── Script Runs ────────────────────────────────────────────────────────────

function parseJsonColumn(value: string | null): unknown | undefined {
  if (value === null) return undefined;
  return JSON.parse(value);
}

function rowToScriptRun(row: ScriptRunRow): ScriptRun {
  return {
    objectScriptId: row.objectScriptId ?? undefined,
    objectId: row.objectId == null ? undefined : scrubSecrets(row.objectId),
    objectMethod: row.objectMethod ?? undefined,
    id: row.id,
    agentId: row.agentId,
    scriptName: row.scriptName ?? undefined,
    source: row.storedSource ?? row.source,
    // Durable-run args are sealed replay state; callers get the redacted view.
    // The supervisor reads the exact value via getScriptRunExecutionArgs.
    args: sealedJsonForDisplay(row.args),
    kind: row.kind as ScriptRunKind,
    status: row.status as ScriptRunStatus,
    pid: row.pid ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    output: parseJsonColumn(row.output),
    error: row.error ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    requestedByUserId: row.requestedByUserId ?? undefined,
    sourceTaskId: row.sourceTaskId ?? undefined,
  };
}

function rowToScriptRunListItem(row: ScriptRunListRow): ScriptRunListItem {
  return {
    objectScriptId: row.objectScriptId ?? undefined,
    objectId: row.objectId == null ? undefined : scrubSecrets(row.objectId),
    objectMethod: row.objectMethod ?? undefined,
    id: row.id,
    agentId: row.agentId,
    scriptName: row.scriptName ?? undefined,
    kind: row.kind as ScriptRunKind,
    status: row.status as ScriptRunStatus,
    pid: row.pid ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    error: row.error ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    requestedByUserId: row.requestedByUserId ?? undefined,
  };
}

export async function createScriptRun(data: {
  id: string;
  agentId: string;
  source: string;
  args: unknown;
  scriptName?: string;
  idempotencyKey?: string;
  requestedByUserId?: string;
  sourceTaskId?: string;
  createdBy?: string;
  updatedBy?: string;
}): Promise<{ run: ScriptRun; existing: boolean }> {
  const storage = getStorage();
  return storage.transaction(async () => {
    if (data.idempotencyKey) {
      const existing = await storage.repos.scripts.findScriptRunByIdempotencyKey(
        data.idempotencyKey,
      );
      if (existing) return { run: rowToScriptRun(existing), existing: true };
    }

    const sourceHash = await storeScriptRunSource(data.source);
    const row = await storage.repos.scripts.insertScriptRun({
      id: data.id,
      agentId: data.agentId,
      scriptName: data.scriptName ?? null,
      sourceHash,
      // Sealed, not scrubbed: this is the run's execution input. The supervisor
      // launches (and relaunches after a restart or pause) from it, so a
      // redacted value would change what the script receives.
      args: sealJson(data.args ?? null),
      idempotencyKey: data.idempotencyKey ?? null,
      requestedByUserId: data.requestedByUserId ?? null,
      sourceTaskId: data.sourceTaskId ?? null,
      created_by: data.createdBy ?? null,
      updated_by: data.updatedBy ?? data.createdBy ?? null,
      // ISO like finishedAt and the inline path, not the column's datetime('now') default.
      startedAt: new Date().toISOString(),
    });
    if (!row) throw new Error("Failed to create script run");
    return { run: rowToScriptRun({ ...row, storedSource: data.source }), existing: false };
  });
}

// Persist a synchronous inline run (POST /api/scripts/run) as an already-terminal
// row. Unlike createScriptRun these never get a journal and never use the
// idempotencyKey column (inline idempotency lives in the kv table).
export async function recordInlineScriptRun(data: {
  id: string;
  agentId: string;
  source: string;
  args: unknown;
  scriptName?: string;
  objectScriptId?: string;
  objectId?: string;
  objectMethod?: string;
  status: "completed" | "failed";
  output?: unknown;
  error?: ScrubbedText;
  startedAt: string;
  finishedAt: string;
  requestedByUserId?: string;
  createdBy?: string;
  /** Set when this run originated from an external API endpoint (POST /api/x/script/<id>). */
  apiEndpointId?: string | null;
}): Promise<ScriptRun> {
  // The run already executed, so args and output are a record, not an input:
  // redact them here so every caller is covered.
  const args = scrubJsonValue(data.args ?? null);
  const output = data.output === undefined ? null : scrubJsonValue(data.output);
  const provenance = getCurrentRunProvenance();
  const storage = getStorage();
  return storage.transaction(async () => {
    const sourceHash = await storeScriptRunSource(data.source);
    const row = await storage.repos.scripts.insertInlineScriptRun({
      id: data.id,
      agentId: data.agentId,
      scriptName: data.scriptName ?? null,
      sourceHash,
      args,
      status: data.status,
      output,
      error: data.error ?? null,
      startedAt: data.startedAt,
      finishedAt: data.finishedAt,
      requestedByUserId: data.requestedByUserId ?? null,
      created_by: data.createdBy ?? null,
      updated_by: data.createdBy ?? null,
      apiEndpointId: data.apiEndpointId ?? null,
      // A run called through another script run's token (a nested
      // ctx.swarm.script_run) records that run and its workflow step.
      sourceStepId: provenance?.sourceStepId ?? null,
      parentScriptRunId: provenance?.sourceScriptRunId ?? null,
      objectScriptId: data.objectScriptId ?? null,
      objectId: data.objectId ?? null,
      objectMethod: data.objectMethod ?? null,
    });
    if (!row) throw new Error("Failed to record inline script run");
    return rowToScriptRun({ ...row, storedSource: data.source });
  });
}

export async function getScriptRun(id: string): Promise<ScriptRun | null> {
  const row = await getStorage().repos.scripts.findScriptRun(id);
  return row ? rowToScriptRun(row) : null;
}

export async function getScriptRunByIdempotencyKey(
  idempotencyKey: string,
): Promise<ScriptRun | null> {
  const row = await getStorage().repos.scripts.findScriptRunByIdempotencyKey(idempotencyKey);
  return row ? rowToScriptRun(row) : null;
}

export async function listScriptRuns(
  opts?: ScriptRunFilter & { limit?: number; offset?: number },
): Promise<ScriptRunListItem[]> {
  const rows = await getStorage().repos.scripts.listScriptRuns(
    opts ?? {},
    opts?.limit ?? 50,
    opts?.offset ?? 0,
  );
  return rows.map(rowToScriptRunListItem);
}

export async function countScriptRuns(opts?: ScriptRunFilter): Promise<number> {
  return await getStorage().repos.scripts.countScriptRuns(opts ?? {});
}

export async function countActiveScriptRuns(): Promise<number> {
  return await getStorage().repos.scripts.countActiveScriptRuns();
}

export type ScriptRunPatch = Partial<{
  status: ScriptRunStatus;
  pid: number | null;
  finishedAt: string | null;
  output: unknown;
  error: string | null;
  lastHeartbeatAt: string | null;
  updatedBy: string | null;
}>;

function scriptRunUpdateSets(patch: ScriptRunPatch): ScriptRunColumnUpdate {
  return {
    status: patch.status,
    pid: patch.pid,
    finishedAt: patch.finishedAt,
    // Every script_runs UPDATE builds its SET list here, so this is the
    // chokepoint for the output and error columns. Output is a record of the
    // finished run (nothing re-reads it as input), so redaction is safe.
    output:
      "output" in patch
        ? patch.output === undefined
          ? null
          : scrubJsonValue(patch.output)
        : undefined,
    error:
      patch.error === undefined
        ? undefined
        : patch.error === null
          ? null
          : scrubSecrets(patch.error),
    last_heartbeat_at: patch.lastHeartbeatAt,
    updated_by: patch.updatedBy,
  };
}

export async function updateScriptRun(id: string, patch: ScriptRunPatch): Promise<void> {
  await getStorage().repos.scripts.updateScriptRun(id, scriptRunUpdateSets(patch));
}

/**
 * Terminal-guarded variant of `updateScriptRun`: the UPDATE re-checks the
 * status its caller read, so a run that reached a terminal state in between
 * is not rewritten. Callers read the run, then await (process termination,
 * request parsing), so their own guard is advisory only: an operator cancel
 * and the harness's own final status POST can otherwise both pass it and the
 * loser overwrites the winner ("completed" stored as "cancelled" or the
 * reverse). Returns false when nothing was claimed, which callers map to
 * their already-terminal no-op branch. Heartbeat and pid writes keep using
 * plain `updateScriptRun`.
 */
export async function updateScriptRunIfNotTerminal(
  id: string,
  patch: ScriptRunPatch,
): Promise<boolean> {
  return await updateScriptRunGuarded(id, patch, "not-terminal");
}

/**
 * Same claim, narrower guard: only a run still `running` is written. The
 * supervisor's exit handler reads the run and then awaits, so a final status
 * posted by the harness (or a pause) in that window must win over the
 * exit-code-derived status.
 */
export async function updateScriptRunIfRunning(
  id: string,
  patch: ScriptRunPatch,
): Promise<boolean> {
  return await updateScriptRunGuarded(id, patch, "running");
}

async function updateScriptRunGuarded(
  id: string,
  patch: ScriptRunPatch,
  guard: "not-terminal" | "running",
): Promise<boolean> {
  return (
    (await getStorage().repos.scripts.updateScriptRun(id, scriptRunUpdateSets(patch), guard)) > 0
  );
}

export async function getRunningScriptRuns(): Promise<ScriptRun[]> {
  const rows = await getStorage().repos.scripts.listActiveScriptRuns();
  return rows.map(rowToScriptRun);
}

// ─── Script Run Journal ─────────────────────────────────────────────────────

function rowToScriptRunJournalEntry(
  row: ScriptRunJournalRow,
  view: "display" | "replay" = "display",
): ScriptRunJournalEntry {
  const open = view === "replay" ? openSealedJson : sealedJsonForDisplay;
  return {
    id: row.id,
    runId: row.runId,
    stepKey: row.stepKey,
    stepType: row.stepType,
    config: JSON.parse(row.config),
    status: row.status as "completed" | "failed",
    result: row.result === null ? undefined : open(row.result),
    error: row.error ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
  };
}

/**
 * One journal step with its exact `result`, for the harness replay route only.
 * Everything that shows a journal to a person uses listScriptRunJournalSteps.
 */
export async function getScriptRunJournalStep(
  runId: string,
  stepKey: string,
): Promise<ScriptRunJournalEntry | null> {
  const row = await getStorage().repos.scripts.findScriptRunJournalStep(runId, stepKey);
  return row ? rowToScriptRunJournalEntry(row, "replay") : null;
}

export async function upsertScriptRunJournalStep(data: {
  runId: string;
  stepKey: string;
  stepType: string;
  config: unknown;
  status: "completed" | "failed";
  result?: unknown;
  error?: ScrubbedText;
  durationMs?: number;
}): Promise<void> {
  // `config` is diagnostic only (the step GET never returns it), so it is
  // redacted. `result` is sealed instead: the harness replays it verbatim as
  // the step's return value on resume, so redaction would change what later
  // steps see.
  await getStorage().repos.scripts.insertScriptRunJournalStep({
    id: crypto.randomUUID(),
    runId: data.runId,
    stepKey: data.stepKey,
    stepType: data.stepType,
    config: scrubJsonValue(data.config ?? {}),
    status: data.status,
    result: data.result !== undefined ? sealJson(data.result) : null,
    error: data.error ?? null,
    durationMs: data.durationMs ?? null,
  });
}

export async function listScriptRunJournalSteps(runId: string): Promise<ScriptRunJournalEntry[]> {
  const rows = await getStorage().repos.scripts.listScriptRunJournalSteps(runId);
  return rows.map((row) => rowToScriptRunJournalEntry(row));
}

export async function countScriptRunJournalSteps(runId: string): Promise<number> {
  return await getStorage().repos.scripts.countScriptRunJournalSteps(runId);
}

export async function countScriptRunJournalAgentTaskSteps(runId: string): Promise<number> {
  return await getStorage().repos.scripts.countScriptRunJournalSteps(runId, "agent-task");
}
