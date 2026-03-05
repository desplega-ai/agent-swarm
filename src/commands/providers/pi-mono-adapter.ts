import { SessionErrorTracker } from "../../utils/error-tracker.ts";
import { parsePiModelIdentifier, validatePiAuthForModel } from "./pi-config.ts";
import type {
  ProviderAdapter,
  ProviderRunHandle,
  ProviderSessionTask,
  ProviderStartContext,
} from "./types.ts";

type PiSessionLike = {
  sessionId?: string;
  id?: string;
  messages?: unknown[];
  subscribe?: (listener: (event: unknown) => void) => () => void;
  prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
  abort?: () => Promise<void>;
  getSessionStats?: () => Record<string, unknown>;
};

function tryNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractUsageFromPiStats(stats: Record<string, unknown> | undefined): {
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

function getSessionId(session: PiSessionLike): string | null {
  if (typeof session.sessionId === "string" && session.sessionId.length > 0) {
    return session.sessionId;
  }
  if (typeof session.id === "string" && session.id.length > 0) {
    return session.id;
  }
  return null;
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
      try {
        validatePiAuthForModel(context.model, context.env);

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
              list?: (
                cwd: string,
                sessionDir?: string,
              ) => Promise<Array<{ id?: string; path?: string }>>;
              open?: (path: string, sessionDir?: string) => unknown;
              inMemory?: (cwd: string, sessionDir?: string) => unknown;
            }
          | undefined;
        const AuthStorage = piSdk.AuthStorage as { create?: () => unknown } | undefined;
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

        let sessionManager: unknown;
        const resumeSessionId = context.resumeSessionId;
        if (resumeSessionId && SessionManager?.list && SessionManager?.open) {
          const sessions = await SessionManager.list(cwd);
          const match = sessions.find(
            (session) => typeof session.id === "string" && session.id.startsWith(resumeSessionId),
          );
          if (match?.path) {
            sessionManager = SessionManager.open(match.path);
          }
        }

        if (!sessionManager && SessionManager?.inMemory) {
          sessionManager = SessionManager.inMemory(cwd);
        }

        const authStorage = AuthStorage?.create ? AuthStorage.create() : undefined;
        const modelRegistry = ModelRegistry ? new ModelRegistry(authStorage) : undefined;
        const model = getModel ? getModel(providerId, modelId) : undefined;

        const createOptions: Record<string, unknown> = {};
        if (sessionManager) createOptions.sessionManager = sessionManager;
        if (authStorage) createOptions.authStorage = authStorage;
        if (modelRegistry) createOptions.modelRegistry = modelRegistry;
        if (model) createOptions.model = model;

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

        let unsubscribe: (() => void) | undefined;
        if (typeof session.subscribe === "function") {
          unsubscribe = session.subscribe((event: unknown) => {
            const line = JSON.stringify(event);
            writer.write(`${line}\n`);
            void context.onEvent({
              type: "stream_line",
              provider: "pi",
              line,
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

        const stats =
          typeof session.getSessionStats === "function"
            ? (session.getSessionStats() as Record<string, unknown>)
            : undefined;
        const usage = extractUsageFromPiStats(stats);

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
          durationMs: tryNumber(stats?.durationMs),
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
