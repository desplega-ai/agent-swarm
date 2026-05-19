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
    memory_search(args: {
      query: string;
      scope?: "all" | "agent" | "swarm";
      limit?: number;
      source?: string;
    }): Promise<unknown>;
    memory_get(args: { memoryId: string }): Promise<unknown>;
    memory_rate(args: { id: string; useful: boolean; note?: string }): Promise<unknown>;
    task_list(args?: Record<string, unknown>): Promise<unknown>;
    task_get(args: { taskId: string }): Promise<unknown>;
    task_storeProgress(args: Record<string, unknown>): Promise<unknown>;
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
    repo_list(args?: Record<string, unknown>): Promise<unknown>;
    schedule_list(args?: Record<string, unknown>): Promise<unknown>;
    script_search(args: { query?: string; scope?: ScriptScope; limit?: number }): Promise<unknown>;
    script_run(args: {
      name?: string;
      source?: string;
      args?: unknown;
      intent?: string;
      scope?: ScriptScope;
      fsMode?: ScriptFsMode;
    }): Promise<unknown>;
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
