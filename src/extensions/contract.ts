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
