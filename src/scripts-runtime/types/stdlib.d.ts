declare module "stdlib" {
  export interface Redacted<T> {
    readonly __redactedBrand?: T;
    toString(): "<redacted>";
    toJSON(): "<redacted>";
  }
  export const Redacted: {
    value<T>(self: Redacted<T>): T;
    meta<T>(self: Redacted<T>): { type: "system" | "user"; isSecret: boolean };
    isSecret<T>(self: Redacted<T>): boolean;
  };
  export function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  export function fetchJson(input: string | URL | Request, init?: RequestInit): Promise<unknown>;
  export function grep(pattern: string, files?: string | string[]): Promise<string>;
  export function glob(pattern: string): Promise<string[]>;
  export function table(rows: Array<Record<string, unknown>>): string;
}

declare module "swarm-sdk" {
  export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };
  export type ScriptScope = "agent" | "global";
  export type ScriptFsMode = "none" | "workspace-rw";

  export interface Redacted<T> {
    readonly __redactedBrand?: T;
    toString(): "<redacted>";
    toJSON(): "<redacted>";
  }

  export interface RedactedStatic {
    value<T>(self: Redacted<T>): T;
    meta<T>(self: Redacted<T>): { type: "system" | "user"; isSecret: boolean };
    isSecret<T>(self: Redacted<T>): boolean;
  }

  export interface SwarmConfig {
    apiKey: Redacted<string>;
    agentId: Redacted<string>;
    mcpBaseUrl: Redacted<string>;
    get<T = string>(key: string): Redacted<T> | undefined;
  }

  export interface SwarmSdk {
    // --- memory ---
    memory_search(args: {
      query: string;
      scope?: "all" | "agent" | "swarm";
      limit?: number;
      source?: string;
    }): Promise<unknown>;
    memory_get(args: { memoryId: string }): Promise<unknown>;
    memory_rate(args: { id: string; useful: boolean; note?: string }): Promise<unknown>;
    // --- tasks ---
    task_list(args?: Record<string, unknown>): Promise<unknown>;
    task_get(args: { taskId: string }): Promise<unknown>;
    task_storeProgress(args: Record<string, unknown>): Promise<unknown>;
    task_poll(args?: Record<string, unknown>): Promise<unknown>;
    // --- kv ---
    kv_get(args: { key: string; namespace?: string }): Promise<unknown>;
    kv_set(args: {
      key: string;
      value: unknown;
      namespace?: string;
      ttlSeconds?: number;
      valueType?: "string" | "json" | "integer";
    }): Promise<unknown>;
    kv_del(args: { key: string; namespace?: string }): Promise<unknown>;
    kv_incr(args: { key: string; by?: number; namespace?: string }): Promise<unknown>;
    kv_list(args?: { prefix?: string; namespace?: string; limit?: number }): Promise<unknown>;
    // --- repos ---
    repo_list(args?: Record<string, unknown>): Promise<unknown>;
    // --- schedules ---
    schedule_list(args?: Record<string, unknown>): Promise<unknown>;
    // --- scripts ---
    script_search(args: { query?: string; scope?: ScriptScope; limit?: number }): Promise<unknown>;
    script_run(args: {
      name?: string;
      source?: string;
      args?: unknown;
      intent?: string;
      scope?: ScriptScope;
      fsMode?: ScriptFsMode;
    }): Promise<unknown>;
    // --- swarm / agent ---
    swarm_get(args?: { includeFull?: boolean }): Promise<unknown>;
    agent_info(args?: Record<string, unknown>): Promise<unknown>;
    metrics_get(args?: Record<string, unknown>): Promise<unknown>;
    user_resolve(args?: {
      kind?: string;
      externalId?: string;
      email?: string;
      userId?: string;
    }): Promise<unknown>;
    db_query(args: { sql: string; params?: unknown[] }): Promise<unknown>;
    // --- config ---
    config_get(args?: {
      agentId?: string;
      repoId?: string;
      key?: string;
      includeSecrets?: boolean;
    }): Promise<unknown>;
    config_list(args?: {
      scope?: "global" | "agent" | "repo";
      scopeId?: string;
      key?: string;
      includeSecrets?: boolean;
    }): Promise<unknown>;
    // --- slack ---
    slack_read(args?: {
      inboxMessageId?: string;
      taskId?: string;
      channelId?: string;
      threadTs?: string;
      limit?: number;
      includeFiles?: boolean;
    }): Promise<unknown>;
    slack_listChannels(args?: {
      types?: Array<"public" | "private" | "dm" | "mpim">;
      limit?: number;
    }): Promise<unknown>;
    // --- messaging ---
    message_read(args?: {
      channel?: string;
      limit?: number;
      since?: string;
      unreadOnly?: boolean;
      mentionsOnly?: boolean;
      markAsRead?: boolean;
    }): Promise<unknown>;
    // --- services ---
    service_list(args?: {
      agentId?: string;
      name?: string;
      status?: "starting" | "healthy" | "unhealthy" | "stopped";
      includeOwn?: boolean;
    }): Promise<unknown>;
    // --- context / profiles ---
    context_history(args?: {
      agentId?: string;
      field?: "soulMd" | "identityMd" | "toolsMd" | "claudeMd" | "setupScript";
      limit?: number;
    }): Promise<unknown>;
    context_diff(args: { versionId: string; compareToVersionId?: string }): Promise<unknown>;
    // --- workflows ---
    workflow_list(args?: { enabled?: boolean; includeFull?: boolean }): Promise<unknown>;
    workflow_get(args: { id: string }): Promise<unknown>;
    workflow_listRuns(args: {
      workflowId: string;
      status?: "running" | "waiting" | "completed" | "failed" | "skipped" | "cancelled";
    }): Promise<unknown>;
    workflow_getRun(args: { id: string }): Promise<unknown>;
    // --- prompt templates ---
    prompt_list(args?: {
      eventType?: string;
      scope?: "global" | "agent" | "repo";
      scopeId?: string;
      isDefault?: boolean;
    }): Promise<unknown>;
    prompt_get(args: { id: string }): Promise<unknown>;
    // --- tracker ---
    tracker_status(args?: Record<string, unknown>): Promise<unknown>;
  }

  export interface ScriptStdlib {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
    fetchJson(input: string | URL | Request, init?: RequestInit): Promise<unknown>;
    grep(pattern: string, files?: string | string[]): Promise<string>;
    glob(pattern: string): Promise<string[]>;
    table(rows: Array<Record<string, unknown>>): string;
    Redacted: RedactedStatic;
  }

  export interface ScriptLogger extends Console {}

  export interface ScriptContext {
    swarm: SwarmSdk & { config: SwarmConfig };
    stdlib: ScriptStdlib;
    logger: ScriptLogger;
  }

  // biome-ignore lint/suspicious/noExplicitAny: scripts may narrow their args type at the entrypoint.
  export type ScriptMain = (args: any, ctx: ScriptContext) => unknown | Promise<unknown>;
}
