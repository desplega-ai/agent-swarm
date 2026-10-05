// biome-ignore-all lint/suspicious/noConfusingVoidType: Extension handlers may explicitly return no result.
import type { SwarmSdk } from "swarm-sdk";
import type { z } from "zod";
import type { RequestInfo } from "../tools/utils";
import type { ActiveSession, AgentTask, CreateTaskOptions } from "../types";

export type Runtime = "api" | "worker";

export interface ExtensionScriptAsset {
  name: string;
  file: string;
  description: string;
  intent?: string;
}

export interface ExtensionScheduleAsset {
  name: string;
  description?: string;
  script: string;
  cronExpression?: string;
  intervalMs?: number;
  timezone?: string;
  args?: Record<string, unknown>;
}

export interface ExtensionWorkflowAsset {
  file: string;
}

export interface ExtensionSkillAsset {
  dir: string;
}

export interface ExtensionManifest {
  $schema?: string;
  name: string;
  description: string;
  version: string;
  runtime: Runtime;
  assets: {
    hooks: string;
    scripts?: readonly ExtensionScriptAsset[];
    schedules?: readonly ExtensionScheduleAsset[];
    workflows?: readonly ExtensionWorkflowAsset[];
    skills?: readonly ExtensionSkillAsset[];
  };
  homepage?: string;
  author?: string;
}

export interface HooksModule {
  default: SwarmExtension;
  config?: z.ZodTypeAny;
}

export interface ExtensionState {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  incr(key: string, by?: number): Promise<number>;
  del(key: string): Promise<void>;
}

export interface ExtensionLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

type ConfigFor<M extends ExtensionManifest> = M extends {
  config: infer C extends z.ZodTypeAny;
}
  ? z.infer<C>
  : Record<string, unknown>;

export interface ApiCtx<Config = Record<string, unknown>> {
  swarm: SwarmSdk;
  state: ExtensionState;
  config: Config;
  log: ExtensionLogger;
  signal: AbortSignal;
  event: {
    name: keyof SwarmEventMap;
    at: string;
    extension: { id: string; version: number };
  };
}

export interface WorkerCtx<Config = Record<string, unknown>> extends Omit<ApiCtx<Config>, "swarm"> {
  swarm: SwarmSdk;
  worker: { agentId: string; taskId: string; harness: string };
}

export type CtxFor<M extends ExtensionManifest> = M["runtime"] extends "api"
  ? ApiCtx<ConfigFor<M>>
  : WorkerCtx<ConfigFor<M>>;

export type PreResult<Modify> =
  | void
  | { action: "continue" }
  | { action: "modify"; data: Modify }
  | { action: "block"; reason: string };

export type TaskCreateOrigin =
  | "rest"
  | "app"
  | "mcp"
  | "slack"
  | "schedule"
  | "workflow"
  | "webhook"
  | "followUp"
  | `extension:${string}`;

export interface TaskCreateEvent {
  options: CreateTaskOptions;
  description: string;
  origin: TaskCreateOrigin;
  requestInfo?: RequestInfo;
}

export type TaskCreateModify = Partial<
  Pick<
    CreateTaskOptions,
    | "agentId"
    | "creatorAgentId"
    | "source"
    | "taskType"
    | "tags"
    | "priority"
    | "dependsOn"
    | "offeredTo"
    | "vcsProvider"
    | "vcsRepo"
    | "vcsEventType"
    | "vcsNumber"
    | "vcsCommentId"
    | "vcsAuthor"
    | "vcsUrl"
    | "vcsInstallationId"
    | "vcsNodeId"
    | "agentmailInboxId"
    | "agentmailMessageId"
    | "agentmailThreadId"
    | "mentionMessageId"
    | "mentionChannelId"
    | "dir"
    | "model"
    | "modelTier"
    | "effort"
    | "outputSchema"
    | "followUpConfig"
    | "bypassTrackerContextDedup"
  >
> & { description?: string };

export interface TaskFollowUpEvent {
  completedTask: AgentTask;
  status: "completed" | "failed";
  output?: string;
  failureReason?: string;
  workerAgentId: string;
  leadAgentId: string;
  summary: string;
}

export type TaskFollowUpModify = Partial<
  Pick<CreateTaskOptions, "agentId" | "priority" | "followUpConfig">
> & { description?: string };

export interface SlackRouteEvent {
  channelId: string;
  userId: string;
  text: string;
  threadTs?: string;
  botMentioned: boolean;
  threadContext?: { channelId: string; threadTs: string };
}

export interface SlackRouteModify {
  target: { kind: "agent"; agentId: string } | { kind: "lead" } | { kind: "broadcast" };
}

export type HeartbeatClassification = "no-session" | "stale-session" | "fresh-stalled";
export type HeartbeatAction = "supersede-resume" | "fail" | "record";

export interface HeartbeatRemediateEvent {
  task: AgentTask;
  session?: ActiveSession;
  classification: HeartbeatClassification;
  proposedAction: HeartbeatAction;
  reason: string;
  taskAgeMs: number;
  sessionHeartbeatAgeMs?: number;
}

export interface HeartbeatRemediateModify {
  proposedAction: HeartbeatAction;
}

export interface ToolCallEvent {
  tool: string;
  args: unknown;
  requestInfo: RequestInfo;
}

export interface ToolCallModify {
  args: unknown;
}

export interface TaskEvent {
  task: AgentTask;
}

export interface TaskCompletedEvent extends TaskEvent {
  output: string;
}

export interface TaskFailedEvent extends TaskEvent {
  failureReason: string;
}

export interface TaskSupersededEvent extends TaskEvent {
  supersededBy: string;
}

export interface TaskProgressEvent extends TaskEvent {
  progress: string;
}

export interface SlackMessageEvent {
  channelId: string;
  userId: string;
  text: string;
  threadTs?: string;
  taskId?: string;
}

/**
 * A person answered an approval request. Fires for workflow and standalone
 * requests. Timeouts and cancellations do not emit it today.
 */
export interface ApprovalResolvedEvent {
  requestId: string;
  status: "approved" | "rejected" | "timeout" | "cancelled";
  responses: Record<string, unknown> | null;
  /** Set when a workflow human-in-the-loop step asked. Absent for a standalone request. */
  workflowRunId?: string;
  workflowRunStepId?: string;
  /** The task whose agent asked, for a standalone request. */
  sourceTaskId?: string;
}

/** A task was refused because a daily spend budget is used up. */
export interface TaskBudgetRefusedEvent extends TaskEvent {
  /** The agent the task was refused for. */
  agentId: string;
  /** Which budget refused it. The matching spend and budget fields are set. */
  cause: "agent" | "global" | "user";
  agentSpendUsd?: number;
  agentBudgetUsd?: number;
  globalSpendUsd?: number;
  globalBudgetUsd?: number;
  userSpendUsd?: number;
  userBudgetUsd?: number;
  /** ISO 8601 time the daily budget resets. */
  resetAt: string;
}

/** An inbound AgentMail message. */
export interface EmailReceivedEvent {
  inboxId: string;
  /** The From header as sent. */
  from: string;
  subject: string;
  /** The text body, or the HTML when there is no text, cut to 500 characters with `...` appended. */
  body: string;
  threadId: string;
  messageId: string;
}

/** An inbound Kapso (WhatsApp) message. */
export interface KapsoMessageEvent {
  phoneNumberId: string;
  conversationId?: string;
  messageId: string;
  from?: string;
  /** Kapso message type, such as `text` or `image`. */
  type?: string;
  /** The text, or a placeholder naming the type for a non-text message. */
  text: string;
}

export type VcsProvider = "github" | "gitlab" | "azure-devops";

/**
 * The provider object the event is about, as the provider names it. GitLab
 * calls a pull request a merge request, and a comment a `note`.
 */
export type VcsEventKind =
  | "pull_request"
  | "merge_request"
  | "issue"
  | "issue_comment"
  | "note"
  | "pull_request_review"
  | "pipeline";

/**
 * A webhook event from a connected code host. `action` is the provider's own
 * value: `opened`, `closed`, `synchronize`, `merge`, `created`, `commented`, or,
 * for a pipeline, its status such as `success` or `failed`. Fields a kind does
 * not carry are absent.
 */
export interface VcsEvent {
  provider: VcsProvider;
  kind: VcsEventKind;
  action: string;
  /** `owner/name` on GitHub and GitLab, the repository URL on Azure DevOps. */
  repo: string;
  /** The PR, merge request, or issue number. Absent for a pipeline outside a merge request. */
  number?: number;
  title?: string;
  body?: string | null;
  /** Login of the user behind the event. Set for pull requests, merge requests, and Azure DevOps comments. */
  author?: string;
  url?: string;
  merged?: boolean;
  changedFiles?: number;
  /** The review verdict, on a pull request review. */
  reviewState?: string;
}

export interface ToolCallCompletedEvent extends ToolCallEvent {
  result: unknown;
  durationMs: number;
}

export interface SwarmEventMap {
  "pre.task.create": {
    event: TaskCreateEvent;
    modify: TaskCreateModify;
    result: PreResult<TaskCreateModify>;
  };
  "pre.task.followUp": {
    event: TaskFollowUpEvent;
    modify: TaskFollowUpModify;
    result: PreResult<TaskFollowUpModify>;
  };
  "pre.slack.route": {
    event: SlackRouteEvent;
    modify: SlackRouteModify;
    result: PreResult<SlackRouteModify>;
  };
  "pre.heartbeat.remediate": {
    event: HeartbeatRemediateEvent;
    modify: HeartbeatRemediateModify;
    result: PreResult<HeartbeatRemediateModify>;
  };
  "pre.tool.call": {
    event: ToolCallEvent;
    modify: ToolCallModify;
    result: PreResult<ToolCallModify>;
  };
  "post.task.created": { event: TaskEvent; modify: never; result: void };
  "post.task.completed": { event: TaskCompletedEvent; modify: never; result: void };
  "post.task.failed": { event: TaskFailedEvent; modify: never; result: void };
  "post.task.cancelled": { event: TaskEvent; modify: never; result: void };
  "post.task.superseded": { event: TaskSupersededEvent; modify: never; result: void };
  "post.task.progress": { event: TaskProgressEvent; modify: never; result: void };
  "post.slack.message": { event: SlackMessageEvent; modify: never; result: void };
  "post.approval.resolved": { event: ApprovalResolvedEvent; modify: never; result: void };
  "post.task.budgetRefused": { event: TaskBudgetRefusedEvent; modify: never; result: void };
  "post.email.received": { event: EmailReceivedEvent; modify: never; result: void };
  "post.kapso.message": { event: KapsoMessageEvent; modify: never; result: void };
  "post.vcs.event": { event: VcsEvent; modify: never; result: void };
  "post.tool.call": { event: ToolCallCompletedEvent; modify: never; result: void };
}

export interface ExtensionApi<
  M extends ExtensionManifest = ExtensionManifest & { runtime: "api" },
> {
  on<E extends keyof SwarmEventMap>(
    event: E,
    handler: (
      event: SwarmEventMap[E]["event"],
      ctx: CtxFor<M>,
    ) => Promise<SwarmEventMap[E]["result"]> | SwarmEventMap[E]["result"],
    opts?: { priority?: number },
  ): void;
}

export type SwarmExtension<M extends ExtensionManifest = ExtensionManifest & { runtime: "api" }> = (
  api: ExtensionApi<M>,
) => void;

export { block, modify } from "./contract-runtime";
