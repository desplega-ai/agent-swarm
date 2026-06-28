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
      intent: string;
      scope?: "all" | "agent" | "swarm";
      limit?: number;
      source?: string;
    }): Promise<unknown>;
    memory_get(args: { memoryId: string; intent: string }): Promise<unknown>;
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
      idempotencyKey?: string;
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
    tracker_syncStatus(args?: Record<string, unknown>): Promise<unknown>;
    tracker_linkTask(args: {
      taskId: string;
      externalId: string;
      provider?: string;
    }): Promise<unknown>;
    tracker_unlink(args: { taskId: string }): Promise<unknown>;
    tracker_mapAgent(args: {
      agentId: string;
      externalId: string;
      provider?: string;
    }): Promise<unknown>;

    // --- write: memory ---
    memory_delete(args: { id: string }): Promise<unknown>;
    memory_edit(args: {
      memoryId?: string;
      key?: string;
      scope?: "agent" | "swarm";
      mode?: "replace" | "exact";
      content?: string;
      oldString?: string;
      newString?: string;
      intent: string;
      expectedVersion?: number;
    }): Promise<unknown>;
    inject_learning(args: {
      content: string;
      name?: string;
      scope?: "agent" | "swarm";
      source?: string;
      tags?: string[];
    }): Promise<unknown>;

    // --- write: tasks ---
    task_send(args: Record<string, unknown>): Promise<unknown>;
    task_cancel(args: { taskId: string }): Promise<unknown>;
    task_action(args: Record<string, unknown>): Promise<unknown>;

    // --- write: config ---
    config_set(args: {
      key: string;
      value: unknown;
      scope?: "global" | "agent" | "repo";
      scopeId?: string;
      isSecret?: boolean;
    }): Promise<unknown>;
    config_delete(args: { id: string }): Promise<unknown>;

    // --- write: slack ---
    slack_post(args: { channelId: string; message: string; blocks?: unknown }): Promise<unknown>;
    slack_reply(args: {
      channelId?: string;
      threadTs?: string;
      message: string;
      taskId?: string;
    }): Promise<unknown>;
    slack_startThread(args: { channelId: string; message: string }): Promise<unknown>;
    slack_uploadFile(args: Record<string, unknown>): Promise<unknown>;
    slack_downloadFile(args: { url: string }): Promise<unknown>;

    // --- write: messaging (internal) ---
    message_post(args: { channel?: string; content: string; to?: string }): Promise<unknown>;

    // --- write: profiles ---
    profile_update(args: Record<string, unknown>): Promise<unknown>;

    // --- write: services ---
    service_register(args: Record<string, unknown>): Promise<unknown>;
    service_unregister(args: { name: string }): Promise<unknown>;
    service_updateStatus(args: {
      name: string;
      status: "starting" | "healthy" | "unhealthy" | "stopped";
    }): Promise<unknown>;

    // --- write: schedules ---
    schedule_create(args: Record<string, unknown>): Promise<unknown>;
    schedule_update(args: Record<string, unknown>): Promise<unknown>;
    schedule_delete(args: { id: string }): Promise<unknown>;
    schedule_runNow(args: { id: string }): Promise<unknown>;

    // --- write: workflows ---
    workflow_create(args: Record<string, unknown>): Promise<unknown>;
    workflow_update(args: Record<string, unknown>): Promise<unknown>;
    workflow_patch(args: Record<string, unknown>): Promise<unknown>;
    workflow_patchNode(args: Record<string, unknown>): Promise<unknown>;
    workflow_delete(args: { id: string }): Promise<unknown>;
    workflow_trigger(args: { id: string; triggerData?: Record<string, unknown> }): Promise<unknown>;
    workflow_retryRun(args: { id: string }): Promise<unknown>;
    workflow_cancelRun(args: { id: string }): Promise<unknown>;

    // --- write: prompt templates ---
    prompt_set(args: Record<string, unknown>): Promise<unknown>;
    prompt_delete(args: { id: string }): Promise<unknown>;
    prompt_preview(args: Record<string, unknown>): Promise<unknown>;

    // --- write: scripts ---
    script_upsert(args: {
      name: string;
      source: string;
      description?: string;
      intent?: string;
      scope?: ScriptScope;
      fsMode?: ScriptFsMode;
    }): Promise<unknown>;
    script_delete(args: { name: string; scope?: ScriptScope }): Promise<unknown>;
    script_queryTypes(args: { name: string; scope?: ScriptScope }): Promise<unknown>;
    script_launchRun(args: {
      source: string;
      args?: unknown;
      idempotencyKey?: string;
      scriptName?: string;
      requestedByUserId?: string;
    }): Promise<unknown>;
    script_getRun(args: { id: string }): Promise<unknown>;
    script_listRuns(args?: {
      status?: "running" | "paused" | "completed" | "failed" | "cancelled" | "aborted_limit";
      agentId?: string;
      limit?: number;
      offset?: number;
    }): Promise<unknown>;

    // --- write: repos ---
    repo_update(args: Record<string, unknown>): Promise<unknown>;

    // --- write: agent ---
    agent_join(args: {
      name: string;
      role?: string;
      description?: string;
      capabilities?: string[];
      requestedId?: string;
      lead?: boolean;
    }): Promise<unknown>;
    user_manage(args: Record<string, unknown>): Promise<unknown>;

    // --- skills ---
    skill_list(args?: {
      scope?: string;
      scopeId?: string;
      includeBuiltin?: boolean;
    }): Promise<unknown>;
    skill_get(args: { id: string }): Promise<unknown>;
    skill_getFile(args: { skillId: string; path: string }): Promise<unknown>;
    skill_search(args: { query: string; limit?: number }): Promise<unknown>;
    skill_create(args: Record<string, unknown>): Promise<unknown>;
    skill_update(args: Record<string, unknown>): Promise<unknown>;
    skill_delete(args: { id: string }): Promise<unknown>;
    skill_install(args: Record<string, unknown>): Promise<unknown>;
    skill_uninstall(args: Record<string, unknown>): Promise<unknown>;
    skill_publish(args: Record<string, unknown>): Promise<unknown>;

    // --- mcp servers ---
    mcpServer_list(args?: Record<string, unknown>): Promise<unknown>;
    mcpServer_get(args: { id: string }): Promise<unknown>;
    mcpServer_create(args: Record<string, unknown>): Promise<unknown>;
    mcpServer_update(args: Record<string, unknown>): Promise<unknown>;
    mcpServer_delete(args: { id: string }): Promise<unknown>;
    mcpServer_install(args: Record<string, unknown>): Promise<unknown>;
    mcpServer_uninstall(args: Record<string, unknown>): Promise<unknown>;

    // --- pages & metrics ---
    page_create(args: Record<string, unknown>): Promise<unknown>;
    metric_create(args: Record<string, unknown>): Promise<unknown>;

    // --- human input ---
    request_humanInput(args: Record<string, unknown>): Promise<unknown>;
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

  export interface ScriptRunContext {
    id: string;
    agentId: string;
    args: unknown;
  }

  export interface ScriptWorkflowSteps {
    rawLlm(
      label: string,
      config: { prompt: string; model?: string; schema?: Record<string, unknown> },
    ): Promise<unknown>;
    agentTask(
      label: string,
      config: {
        template?: string;
        task?: string;
        agentId?: string;
        tags?: string[];
        priority?: number;
        offerMode?: boolean;
        dir?: string;
        vcsRepo?: string;
        model?: string;
        parentTaskId?: string;
        requestedByUserId?: string;
        outputSchema?: Record<string, unknown>;
      },
    ): Promise<unknown>;
    swarmScript(
      label: string,
      config: {
        name?: string;
        scriptName?: string;
        source?: string;
        args?: unknown;
        scope?: ScriptScope;
        fsMode?: ScriptFsMode;
        intent?: string;
        idempotencyKey?: string;
      },
    ): Promise<unknown>;
    humanInTheLoop(): Promise<never>;
  }

  export interface ScriptContext {
    run?: ScriptRunContext;
    step?: ScriptWorkflowSteps;
    swarm: SwarmSdk & { config: SwarmConfig };
    stdlib: ScriptStdlib;
    logger: ScriptLogger;
  }

  // biome-ignore lint/suspicious/noExplicitAny: scripts may narrow their args type at the entrypoint.
  export type ScriptMain = (args: any, ctx: ScriptContext) => unknown | Promise<unknown>;
}
