import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SessionErrorTracker } from "../../utils/error-tracker.ts";
import { parsePiModelIdentifier, validatePiAuthForModel } from "./pi-config.ts";
import {
  extractHookBlockDecision,
  type HookInvocation,
  mapPiSdkEventToHookInvocations,
  mapProviderEventToHookLifecycle,
} from "./runtime-hook-bridge.ts";
import type {
  ProviderAdapter,
  ProviderRunHandle,
  ProviderSessionTask,
  ProviderStartContext,
} from "./types.ts";

const HOOK_SCRIPT_PATH = new URL("../../hooks/hook.ts", import.meta.url).pathname;
const HOOK_SCRIPT_RELATIVE = "src/hooks/hook.ts";

type PiSessionLike = {
  sessionId?: string;
  id?: string;
  messages?: unknown[];
  subscribe?: (listener: (event: unknown) => void) => () => void;
  prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
  abort?: () => Promise<void>;
  getSessionStats?: () => Record<string, unknown>;
};

interface PiUsageSnapshot {
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  numTurns?: number;
}

type PiResourceLoaderLike = {
  reload?: () => Promise<void>;
};

function tryNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function extractUsageFromPiStats(stats: Record<string, unknown> | undefined): {
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  numTurns?: number;
} {
  if (!stats) {
    return {};
  }

  const cost = (stats.cost ?? {}) as Record<string, unknown>;

  return {
    totalCostUsd: tryNumber(cost.total),
    inputTokens: tryNumber(stats.inputTokens) ?? tryNumber(stats.input),
    outputTokens: tryNumber(stats.outputTokens) ?? tryNumber(stats.output),
    cacheReadTokens: tryNumber(stats.cacheReadTokens) ?? tryNumber(stats.cacheRead),
    cacheWriteTokens: tryNumber(stats.cacheWriteTokens) ?? tryNumber(stats.cacheWrite),
    numTurns: tryNumber(stats.turns),
  };
}

export function extractUsageFromUsageRecord(
  usage: Record<string, unknown> | undefined,
): PiUsageSnapshot {
  if (!usage) {
    return {};
  }

  const cost = (usage.cost ?? {}) as Record<string, unknown>;

  return {
    totalCostUsd: tryNumber(usage.totalCostUsd) ?? tryNumber(cost.total),
    inputTokens: tryNumber(usage.inputTokens) ?? tryNumber(usage.input),
    outputTokens: tryNumber(usage.outputTokens) ?? tryNumber(usage.output),
    cacheReadTokens: tryNumber(usage.cacheReadTokens) ?? tryNumber(usage.cacheRead),
    cacheWriteTokens: tryNumber(usage.cacheWriteTokens) ?? tryNumber(usage.cacheWrite),
  };
}

export function extractUsageFromPiEvent(event: unknown): PiUsageSnapshot {
  if (!event || typeof event !== "object") {
    return {};
  }

  const record = event as Record<string, unknown>;
  const eventType = typeof record.type === "string" ? record.type : undefined;

  const rootUsage = extractUsageFromUsageRecord(
    record.usage && typeof record.usage === "object"
      ? (record.usage as Record<string, unknown>)
      : undefined,
  );

  const messageUsage = extractUsageFromUsageRecord(
    record.message &&
      typeof record.message === "object" &&
      (record.message as Record<string, unknown>).usage &&
      typeof (record.message as Record<string, unknown>).usage === "object"
      ? ((record.message as Record<string, unknown>).usage as Record<string, unknown>)
      : undefined,
  );

  const assistantPartialUsage = extractUsageFromUsageRecord(
    record.assistantMessageEvent &&
      typeof record.assistantMessageEvent === "object" &&
      (record.assistantMessageEvent as Record<string, unknown>).partial &&
      typeof (record.assistantMessageEvent as Record<string, unknown>).partial === "object" &&
      ((record.assistantMessageEvent as Record<string, unknown>).partial as Record<string, unknown>)
        .usage &&
      typeof (
        (record.assistantMessageEvent as Record<string, unknown>).partial as Record<string, unknown>
      ).usage === "object"
      ? ((
          (record.assistantMessageEvent as Record<string, unknown>).partial as Record<
            string,
            unknown
          >
        ).usage as Record<string, unknown>)
      : undefined,
  );

  const snapshot: PiUsageSnapshot = {
    totalCostUsd:
      assistantPartialUsage.totalCostUsd ?? messageUsage.totalCostUsd ?? rootUsage.totalCostUsd,
    inputTokens:
      assistantPartialUsage.inputTokens ?? messageUsage.inputTokens ?? rootUsage.inputTokens,
    outputTokens:
      assistantPartialUsage.outputTokens ?? messageUsage.outputTokens ?? rootUsage.outputTokens,
    cacheReadTokens:
      assistantPartialUsage.cacheReadTokens ??
      messageUsage.cacheReadTokens ??
      rootUsage.cacheReadTokens,
    cacheWriteTokens:
      assistantPartialUsage.cacheWriteTokens ??
      messageUsage.cacheWriteTokens ??
      rootUsage.cacheWriteTokens,
  };

  if (eventType === "turn_end") {
    snapshot.numTurns = 1;
  }

  return snapshot;
}

export function mergeUsageSnapshots(
  base: PiUsageSnapshot,
  update: PiUsageSnapshot,
): PiUsageSnapshot {
  const maxNumber = (a?: number, b?: number): number | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.max(a, b);
  };

  return {
    totalCostUsd: maxNumber(base.totalCostUsd, update.totalCostUsd),
    inputTokens: maxNumber(base.inputTokens, update.inputTokens),
    outputTokens: maxNumber(base.outputTokens, update.outputTokens),
    cacheReadTokens: maxNumber(base.cacheReadTokens, update.cacheReadTokens),
    cacheWriteTokens: maxNumber(base.cacheWriteTokens, update.cacheWriteTokens),
    numTurns: (base.numTurns ?? 0) + (update.numTurns ?? 0) || undefined,
  };
}

function getSessionId(session: PiSessionLike): string | null {
  if (typeof session.sessionId === "string" && session.sessionId.length > 0) {
    return session.sessionId;
  }
  if (typeof session.id === "string" && session.id.length > 0) {
    return session.id;
  }
  return null;
}

async function resolveHookScriptPath(
  context: ProviderStartContext,
): Promise<string | null> {
  const candidates = [
    HOOK_SCRIPT_PATH,
    join(process.cwd(), HOOK_SCRIPT_RELATIVE),
    context.env.WORKSPACE_DIR ? join(context.env.WORKSPACE_DIR, HOOK_SCRIPT_RELATIVE) : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }

  return null;
}

async function resolveHookCommand(context: ProviderStartContext): Promise<string[]> {
  const binaryCandidates = [
    "/usr/local/bin/agent-swarm",
    Bun.which("agent-swarm"),
    process.execPath?.includes("agent-swarm") ? process.execPath : undefined,
  ].filter((value, index, list): value is string => Boolean(value) && list.indexOf(value) === index);

  for (const binaryPath of binaryCandidates) {
    if (await Bun.file(binaryPath).exists()) {
      return [binaryPath, "hook"];
    }
  }

  const hookScriptPath = await resolveHookScriptPath(context);
  if (hookScriptPath) {
    return ["bun", hookScriptPath];
  }

  throw new Error("Unable to locate agent-swarm hook entrypoint");
}

async function resolvePiMcpAdapterExtensionFactory(
  context: ProviderStartContext,
): Promise<((api: unknown) => void) | null> {
  const candidatePaths = [
    context.env.PI_MCP_ADAPTER_PATH,
    context.env.PI_MCP_ADAPTER_DIR ? join(context.env.PI_MCP_ADAPTER_DIR, "index.ts") : undefined,
    join(process.cwd(), "node_modules", "pi-mcp-adapter", "index.ts"),
    "/opt/pi-mcp-adapter/index.ts",
  ].filter((value): value is string => Boolean(value));

  for (const candidatePath of candidatePaths) {
    if (!(await Bun.file(candidatePath).exists())) {
      continue;
    }

    try {
      const module = (await import(candidatePath)) as { default?: unknown };
      if (typeof module.default === "function") {
        return module.default as (api: unknown) => void;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pi] Failed to load MCP adapter from ${candidatePath}: ${message}`);
    }
  }

  return null;
}

async function runHookInvocation(
  context: ProviderStartContext,
  invocation: HookInvocation,
): Promise<{ blocked: boolean; reason?: string }> {
  const payload = {
    hook_event_name: invocation.hookEventName,
    session_id: context.sessionId,
    ...invocation.payload,
  };

  const command = await resolveHookCommand(context);

  const proc = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...context.env,
      ...(context.apiUrl ? { MCP_BASE_URL: context.apiUrl } : {}),
      ...(context.apiKey ? { API_KEY: context.apiKey } : {}),
      ...(context.agentId ? { AGENT_ID: context.agentId } : {}),
      ...(context.taskFilePath ? { TASK_FILE: context.taskFilePath } : {}),
    },
  });

  if (proc.stdin) {
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
    proc.stdin.end();
  }

  const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  await proc.exited;

  if (stderr.trim()) {
    console.warn(`[pi-hook] ${stderr.trim()}`);
  }

  return extractHookBlockDecision(stdout);
}

async function runLifecycleHooks(
  context: ProviderStartContext,
  hookEventNames: Array<"SessionStart" | "PreToolUse" | "PostToolUse" | "Stop">,
): Promise<void> {
  for (const hookEventName of hookEventNames) {
    await runHookInvocation(context, {
      hookEventName,
      payload: {},
    });
  }
}

export class PiMonoAdapter implements ProviderAdapter {
  readonly provider = "pi" as const;

  buildResumeContext(task: ProviderSessionTask, parentTask?: ProviderSessionTask) {
    const sessionId =
      task.runtimeMetadata?.sessionId ||
      task.claudeSessionId ||
      parentTask?.runtimeMetadata?.sessionId ||
      parentTask?.claudeSessionId;

    return {
      sessionId,
      additionalArgs: [],
    };
  }

  async cancel(runHandle: ProviderRunHandle): Promise<void> {
    await runHandle.cancel();
  }

  async startRun(context: ProviderStartContext): Promise<ProviderRunHandle> {
    const writer = Bun.file(context.logFile).writer();
    const errorTracker = new SessionErrorTracker();

    let sessionAbort: (() => Promise<void>) | null = null;

    const promise = (async () => {
      let exitCode = 0;
      const promptStartedAt = Date.now();
      try {
        validatePiAuthForModel(context.model, context.env);

        // Pi SDK reads some paths/credentials directly from process.env.
        const envForwardKeys = [
          "PI_PACKAGE_DIR",
          "PI_CODING_AGENT_DIR",
          "PI_AGENT_DIR",
          "ANTHROPIC_API_KEY",
          "OPENROUTER_API_KEY",
          "OPENAI_API_KEY",
        ] as const;
        for (const key of envForwardKeys) {
          const value = context.env[key];
          if (value && !process.env[key]) {
            process.env[key] = value;
          }
        }

        const piSdk = (await import("@mariozechner/pi-coding-agent")) as Record<string, unknown>;
        const piAi = (await import("@mariozechner/pi-ai")) as Record<string, unknown>;

        const createAgentSession = piSdk.createAgentSession as
          | ((options?: Record<string, unknown>) => Promise<unknown>)
          | undefined;

        if (!createAgentSession) {
          throw new Error("@mariozechner/pi-coding-agent does not export createAgentSession()");
        }

        const SessionManager = piSdk.SessionManager as
          | {
              create?: (cwd: string, sessionDir?: string) => unknown;
              list?: (
                cwd: string,
                sessionDir?: string,
              ) => Promise<Array<{ id?: string; path?: string }>>;
              open?: (path: string, sessionDir?: string) => unknown;
              inMemory?: (cwd: string, sessionDir?: string) => unknown;
            }
          | undefined;
        const AuthStorage = piSdk.AuthStorage as { create?: () => unknown } | undefined;
        const DefaultResourceLoader = piSdk.DefaultResourceLoader as
          | (new (options?: Record<string, unknown>) => PiResourceLoaderLike)
          | undefined;
        const ModelRegistry = piSdk.ModelRegistry as
          | (new (
              ...args: unknown[]
            ) => unknown)
          | undefined;
        const getModel = piAi.getModel as
          | ((providerId: string, modelId: string) => unknown)
          | undefined;

        const { providerId, modelId } = parsePiModelIdentifier(context.model);

        const cwd = context.env.WORKSPACE_DIR || process.cwd();
        const sessionDir = context.env.PI_SESSION_DIR || join(cwd, ".pi-sessions");
        const homeDir = context.env.HOME || process.env.HOME;
        const agentDir =
          context.env.PI_AGENT_DIR ||
          context.env.PI_CODING_AGENT_DIR ||
          (homeDir ? join(homeDir, ".pi", "agent") : undefined);
        await mkdir(sessionDir, { recursive: true });

        let sessionManager: unknown;
        const resumeSessionId = context.resumeSessionId;
        if (resumeSessionId && SessionManager?.list && SessionManager?.open) {
          const sessions = await SessionManager.list(cwd, sessionDir);
          const match = sessions.find(
            (session) => typeof session.id === "string" && session.id.startsWith(resumeSessionId),
          );
          if (match?.path) {
            sessionManager = SessionManager.open(match.path, sessionDir);
          }
        }

        if (!sessionManager && SessionManager?.create) {
          sessionManager = SessionManager.create(cwd, sessionDir);
        }

        if (!sessionManager && SessionManager?.inMemory) {
          sessionManager = SessionManager.inMemory(cwd);
        }

        const authStorage = AuthStorage?.create ? AuthStorage.create() : undefined;
        const runtimeAuthStorage = authStorage as
          | { setRuntimeApiKey?: (provider: string, apiKey: string) => void }
          | undefined;
        if (typeof runtimeAuthStorage?.setRuntimeApiKey === "function") {
          const runtimeKeys: Array<[string, string | undefined]> = [
            ["anthropic", context.env.ANTHROPIC_API_KEY],
            ["openrouter", context.env.OPENROUTER_API_KEY],
            ["openai", context.env.OPENAI_API_KEY],
          ];

          for (const [providerId, key] of runtimeKeys) {
            if (!key) continue;
            runtimeAuthStorage.setRuntimeApiKey(providerId, key);
          }
        }

        const modelRegistry = ModelRegistry ? new ModelRegistry(authStorage) : undefined;
        const model = getModel ? getModel(providerId, modelId) : undefined;
        const createResourceLoader = async (): Promise<unknown> => {
          if (!DefaultResourceLoader) {
            return undefined;
          }

          const extensionFactories: Array<(api: unknown) => void> = [];
          const mcpAdapterFactory = await resolvePiMcpAdapterExtensionFactory(context);
          if (mcpAdapterFactory) {
            extensionFactories.push(mcpAdapterFactory);
          } else {
            console.warn("[pi] MCP adapter extension unavailable; running without MCP bridge");
          }

          const additionalSkillPaths: string[] = [];
          if (homeDir) {
            additionalSkillPaths.push(join(homeDir, ".claude", "skills"));
          }

          const loaderOptions: Record<string, unknown> = {
            cwd,
            ...(agentDir ? { agentDir } : {}),
            ...(context.systemPrompt ? { appendSystemPrompt: context.systemPrompt } : {}),
            ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
            ...(additionalSkillPaths.length > 0 ? { additionalSkillPaths } : {}),
          };

          const loader = new DefaultResourceLoader(loaderOptions);
          if (typeof loader.reload === "function") {
            await loader.reload();
          }
          return loader;
        };
        const resourceLoader = await createResourceLoader();

        const createOptions: Record<string, unknown> = {};
        createOptions.cwd = cwd;
        if (agentDir) createOptions.agentDir = agentDir;
        if (sessionManager) createOptions.sessionManager = sessionManager;
        if (authStorage) createOptions.authStorage = authStorage;
        if (modelRegistry) createOptions.modelRegistry = modelRegistry;
        if (model) createOptions.model = model;
        if (resourceLoader) createOptions.resourceLoader = resourceLoader;

        const result = (await createAgentSession(createOptions)) as
          | { session?: PiSessionLike }
          | PiSessionLike;

        const session: PiSessionLike =
          typeof result === "object" && result !== null && "session" in result
            ? (result as { session?: PiSessionLike }).session || {}
            : (result as PiSessionLike);

        const sessionId = getSessionId(session) || crypto.randomUUID();

        await context.onEvent({
          type: "session_init",
          provider: "pi",
          sessionId,
        });

        await runLifecycleHooks(
          context,
          mapProviderEventToHookLifecycle({
            type: "session_init",
            provider: "pi",
            sessionId,
          }),
        );

        let unsubscribe: (() => void) | undefined;
        let eventQueue = Promise.resolve();
        let eventQueueError: Error | null = null;
        let observedUsage: PiUsageSnapshot = {};
        if (typeof session.subscribe === "function") {
          unsubscribe = session.subscribe((event: unknown) => {
            eventQueue = eventQueue
              .then(async () => {
                const line = JSON.stringify(event);
                writer.write(`${line}\n`);

                observedUsage = mergeUsageSnapshots(observedUsage, extractUsageFromPiEvent(event));

                await context.onEvent({
                  type: "stream_line",
                  provider: "pi",
                  line,
                });

                const hookInvocations = mapPiSdkEventToHookInvocations(event);
                for (const hookInvocation of hookInvocations) {
                  const decision = await runHookInvocation(context, hookInvocation);

                  if (decision.blocked && hookInvocation.hookEventName === "PreToolUse") {
                    await context.onEvent({
                      type: "provider_error",
                      provider: "pi",
                      error: `Hook blocked tool execution: ${decision.reason || "no reason provided"}`,
                    });
                    await sessionAbort?.();
                    throw new Error(
                      `Hook blocked tool execution: ${decision.reason || "no reason provided"}`,
                    );
                  }
                }
              })
              .catch((error) => {
                eventQueueError = error instanceof Error ? error : new Error(String(error));
              });
          });
        }

        if (typeof session.abort === "function") {
          sessionAbort = async () => {
            await session.abort?.();
          };
        }

        if (typeof session.prompt !== "function") {
          throw new Error("pi session is missing prompt() function");
        }

        await session.prompt(context.prompt);
        await eventQueue;

        if (eventQueueError) {
          throw eventQueueError;
        }

        const stats =
          typeof session.getSessionStats === "function"
            ? (session.getSessionStats() as Record<string, unknown>)
            : undefined;
        const statsUsage = extractUsageFromPiStats(stats);
        const usage = {
          totalCostUsd: statsUsage.totalCostUsd ?? observedUsage.totalCostUsd,
          inputTokens: statsUsage.inputTokens ?? observedUsage.inputTokens,
          outputTokens: statsUsage.outputTokens ?? observedUsage.outputTokens,
          cacheReadTokens: statsUsage.cacheReadTokens ?? observedUsage.cacheReadTokens,
          cacheWriteTokens: statsUsage.cacheWriteTokens ?? observedUsage.cacheWriteTokens,
          numTurns: statsUsage.numTurns ?? observedUsage.numTurns,
        };

        await context.onEvent({
          type: "result",
          provider: "pi",
          totalCostUsd: usage.totalCostUsd,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          },
          durationMs: tryNumber(stats?.durationMs) ?? Math.max(Date.now() - promptStartedAt, 0),
          numTurns: usage.numTurns,
          isError: false,
          raw: stats,
        });

        unsubscribe?.();
      } catch (error) {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        errorTracker.addApiError("pi_provider_error", message);
        await context.onEvent({
          type: "provider_error",
          provider: "pi",
          error: message,
        });
      } finally {
        await runLifecycleHooks(
          context,
          mapProviderEventToHookLifecycle({
            type: "process_exit",
            provider: "pi",
            exitCode,
          }),
        );

        await context.onEvent({
          type: "process_exit",
          provider: "pi",
          exitCode,
        });
        await writer.end();
      }

      return {
        exitCode,
        errorTracker,
      };
    })();

    return {
      taskId: context.taskId || crypto.randomUUID(),
      provider: "pi",
      promise,
      cancel: async () => {
        if (sessionAbort) {
          await sessionAbort();
        }
      },
    };
  }
}
