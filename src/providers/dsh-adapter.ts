import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_TIER_MAP } from "../types";
import {
  CONTEXT_FORMULA,
  clampContextPercent,
  getContextWindowSize,
} from "../utils/context-window";
import { addDshStepUsage, type DshStepUsage, normalizeDshStepUsage } from "../utils/dsh-usage";
import { swarmRuntimeInstanceId } from "../utils/multi-runtime";
import {
  getOpenRouterAttributionHeaders,
  getOpenRouterBaseUrl,
} from "../utils/openrouter-base-url";
import {
  detachedProcessGroup,
  registerProcessGroup,
  terminateProcessGroup,
} from "../utils/process-group";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";
import { resolveSlashSkillPrompt } from "./codex-skill-resolver";
import {
  applyReasoningEffort,
  type ReasoningEffort,
  reasoningCapability,
} from "./reasoning-effort";
import type {
  CostData,
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

// npm's `latest` is older and lacks the JSON/stdin contract used here.
export const DSH_PACKAGE = "@deepseek-ai/dsh@0.2.1-alpha.2";

export function checkDshCredentials(env: Record<string, string | undefined>): CredStatus {
  return env.DEEPSEEK_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim()
    ? { ready: true, missing: [], satisfiedBy: "env" }
    : {
        ready: false,
        missing: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"],
        hint: "Set DEEPSEEK_API_KEY or OPENROUTER_API_KEY for dsh.",
      };
}

/** What the adapter resolved before spawning; dsh's stream never echoes it back. */
interface DshRun {
  /** The swarm model string (`openrouter/<id>` or a bare DeepSeek id). */
  model: string;
  /** dsh route the patch selected: `openrouter` or `deepseek-official`. */
  route: string;
  /** Model id dsh sends on that route. */
  modelId: string;
  reasoningEffort: ReasoningEffort | null;
  taskId: string;
  agentId: string;
}

/** Catalog key for the context-window lookup: the direct API's ids live under `deepseek/`. */
function contextWindowKey(model: string): string {
  return model.startsWith("openrouter/") ? model : `deepseek/${model}`;
}

/** MCP server name; dsh exposes its tools as `mcp__agent-swarm__<tool>`. */
const DSH_MCP_SERVER_NAME = "agent-swarm";
/** Patch entry id of the inserted MCP client; dsh names it in activation errors. */
const DSH_MCP_ENTRY_ID = "swarm-mcp";

/**
 * pi-ai treats a hand-declared OpenRouter model as non-reasoning, so every
 * effort but `off` fails with UNSUPPORTED_REASONING_EFFORT. Declare the levels
 * the catalog lists for the model, each sent to OpenRouter under its own name.
 */
function openRouterEfforts(model: string): Record<string, string> {
  return Object.fromEntries(
    reasoningCapability("dsh", model).levels.map((level) => [level, level]),
  );
}

class DshSession implements ProviderSession {
  sessionId: string | undefined;
  private listeners: ((event: ProviderEvent) => void)[] = [];
  private pending: ProviderEvent[] = [];
  private output: string | undefined;
  private failure: string | undefined;
  private stderr = "";
  private aborted = false;
  private completion: Promise<ProviderResult>;
  private readonly startedAt = Date.now();
  private readonly contextWindow: number;
  /** Highest dsh turn seen. A dsh turn runs one or more steps (model calls). */
  private turns = 0;
  private tokens: DshStepUsage | undefined;
  /** dsh tool_result carries only the call id; the runner wants the tool name. */
  private toolNames = new Map<string, string>();

  constructor(
    private proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private directory: string,
    prompt: string,
    private runInfo: DshRun,
  ) {
    this.contextWindow = getContextWindowSize(contextWindowKey(runInfo.model));
    // The stream carries no model id, so log what the patch told dsh to call.
    this.emit({
      type: "raw_log",
      content: JSON.stringify({
        type: "model",
        provider: runInfo.route,
        model: runInfo.modelId,
        ...(runInfo.reasoningEffort ? { reasoningEffort: runInfo.reasoningEffort } : {}),
      }),
    });
    this.completion = this.run(prompt);
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    for (const event of this.pending.splice(0)) listener(event);
  }

  private emit(event: ProviderEvent): void {
    if (this.listeners.length === 0) this.pending.push(event);
    else for (const listener of this.listeners) listener(event);
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return;
    const clean = scrubSecrets(line);
    this.emit({ type: "raw_log", content: clean });
    try {
      const event = JSON.parse(clean);
      if (event.type === "session" && typeof event.sessionId === "string") {
        this.sessionId = event.sessionId;
        this.emit({ type: "session_init", sessionId: event.sessionId, provider: "dsh" });
      } else if (event.type === "text" && typeof event.text === "string") {
        this.emit({ type: "message", role: "assistant", content: event.text });
      } else if (event.type === "final" && typeof event.text === "string") {
        this.output = event.text;
      } else if (event.type === "error" && typeof event.message === "string") {
        this.failure = event.message;
      } else if (event.type === "tool_call" && typeof event.tool === "string") {
        // The runner turns tool_start into readable task progress, as for the
        // other harnesses. dsh phase names (step_end, ...) are not progress.
        const toolCallId = String(event.callId ?? "");
        this.toolNames.set(toolCallId, event.tool);
        this.emit({
          type: "tool_start",
          toolCallId,
          toolName: event.tool,
          args: event.input ?? {},
        });
      } else if (event.type === "tool_result") {
        const toolCallId = String(event.callId ?? "");
        const toolName = this.toolNames.get(toolCallId) ?? "tool";
        this.toolNames.delete(toolCallId);
        this.emit({ type: "tool_end", toolCallId, toolName, result: event.result });
      } else if (event.type === "status" && typeof event.phase === "string") {
        if (typeof event.turn === "number") this.turns = Math.max(this.turns, event.turn);
        if (event.phase === "step_end") this.recordStep(event.usage);
        if (event.phase === "turn_end" && event.reason?.kind !== "completed") {
          this.failure =
            typeof event.reason?.error?.message === "string"
              ? event.reason.error.message
              : `dsh turn ended: ${event.reason?.kind ?? "unknown"}`;
        }
      }
    } catch {
      this.failure = "dsh emitted invalid JSON output";
    }
  }

  private recordStep(usage: unknown): void {
    const step = normalizeDshStepUsage(usage);
    if (!step) return;
    this.tokens = addDshStepUsage(this.tokens, step);
    const { input, output, cacheRead, cacheWrite } = step;
    // One step is one model call, so its prompt plus reply is the context in use.
    const used = input + cacheRead + cacheWrite + output;
    if (used > 0) {
      this.emit({
        type: "context_usage",
        contextUsedTokens: used,
        contextTotalTokens: this.contextWindow,
        contextPercent: clampContextPercent(used, this.contextWindow) ?? 0,
        outputTokens: output,
        contextFormula: CONTEXT_FORMULA,
      });
    }
  }

  private buildCost(isError: boolean): CostData | undefined {
    if (!this.sessionId || !this.tokens) return undefined;
    return {
      sessionId: this.sessionId,
      taskId: this.runInfo.taskId,
      agentId: this.runInfo.agentId,
      // dsh reports tokens, not money; the API prices them from the dsh rows.
      totalCostUsd: 0,
      inputTokens: this.tokens.input,
      outputTokens: this.tokens.output,
      cacheReadTokens: this.tokens.cacheRead,
      cacheWriteTokens: this.tokens.cacheWrite,
      reasoningOutputTokens: this.tokens.reasoning,
      durationMs: Date.now() - this.startedAt,
      // dsh turns, matching the log viewer's turn rows; steps are model calls.
      numTurns: this.turns,
      model: this.runInfo.model,
      isError,
      provider: "dsh",
    };
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        this.consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    this.consumeLine(buffer + decoder.decode());
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      const content = scrubSecrets(decoder.decode(chunk, { stream: true }));
      this.stderr = (this.stderr + content).slice(-8000);
      this.emit({ type: "raw_stderr", content });
      // dsh downgrades a failed plugin to a "did not activate" warning even
      // with failOnStartupError, then runs on without the swarm tools. A
      // session that cannot reach store-progress must not pass as healthy.
      if (
        !this.failure &&
        this.stderr.includes(`${DSH_MCP_ENTRY_ID} (@deepseek-ai/dsh-mcp-client)`)
      ) {
        this.failure = `dsh could not connect to the swarm MCP server: ${this.stderr.trim().slice(0, 500)}`;
        await terminateProcessGroup(this.proc.pid);
      }
    }
  }

  private async run(prompt: string): Promise<ProviderResult> {
    try {
      const [exitCode] = await Promise.all([
        this.proc.exited,
        this.readStdout(),
        this.readStderr(),
        (async () => {
          this.proc.stdin.write(prompt);
          await this.proc.stdin.end();
        })(),
      ]);
      const isError = this.aborted || exitCode !== 0 || !!this.failure || this.output === undefined;
      const failureReason = isError
        ? this.aborted
          ? "dsh session aborted"
          : this.failure || this.stderr.trim() || `dsh exited ${exitCode} without a final result`
        : undefined;
      if (failureReason) this.emit({ type: "error", message: failureReason });
      const cost = this.buildCost(isError);
      if (cost) this.emit({ type: "result", cost, output: this.output, isError });
      return {
        exitCode: isError ? exitCode || 1 : 0,
        sessionId: this.sessionId,
        cost,
        output: this.output,
        isError,
        failureReason,
        appliedReasoningEffort: this.runInfo.reasoningEffort,
      };
    } catch (error) {
      await terminateProcessGroup(this.proc.pid);
      const failureReason = scrubSecrets(String(error));
      this.emit({ type: "error", message: failureReason });
      return {
        exitCode: 1,
        sessionId: this.sessionId,
        cost: this.buildCost(true),
        isError: true,
        failureReason,
      };
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  waitForCompletion(): Promise<ProviderResult> {
    return this.completion;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    await terminateProcessGroup(this.proc.pid);
  }
}

export class DshAdapter implements ProviderAdapter {
  readonly name = "dsh";
  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasToolSearch: false,
    nativeSkillDiscovery: false,
    hasLocalEnvironment: true,
    steerModes: [],
  };

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const env = { ...process.env, ...config.env };
    if (!checkDshCredentials(env).ready) {
      throw new Error("dsh requires DEEPSEEK_API_KEY or OPENROUTER_API_KEY");
    }
    const model = config.model || DEFAULT_MODEL_TIER_MAP.dsh.regular;
    const openrouter = model.startsWith("openrouter/");
    const modelId = openrouter ? model.slice("openrouter/".length) : model;
    const keyEnv = openrouter ? "OPENROUTER_API_KEY" : "DEEPSEEK_API_KEY";
    if (!modelId.trim()) throw new Error("dsh requires a model ID after openrouter/");
    if (!env[keyEnv]?.trim()) throw new Error(`dsh model ${model} requires ${keyEnv}`);
    const binary = env.DSH_BINARY || Bun.which("dsh", { PATH: env.PATH });
    if (!binary) {
      throw new Error(
        `dsh CLI not found. Install ${DSH_PACKAGE} during image provisioning or set DSH_BINARY to a trusted executable.`,
      );
    }
    registerVolatileSecret(env[keyEnv]!, keyEnv);
    const prompt = await resolveSlashSkillPrompt(config.prompt, {
      providerLabel: "dsh",
      skillsDir: join(env.HOME ?? "/home/worker", ".agents", "skills"),
      onInline: config.onPromptSkill,
    });
    const route = openrouter ? "openrouter" : "deepseek-official";
    const effort = applyReasoningEffort("dsh", model, config.reasoningEffort);
    const reasoningEffort = effort.kind === "dsh-effort" ? effort.reasoningEffort : null;
    const directory = await mkdtemp(join(tmpdir(), "swarm-dsh-"));
    try {
      const patchPath = join(directory, "patch.json");
      const openRouterHeaders = openrouter
        ? getOpenRouterAttributionHeaders(getOpenRouterBaseUrl(env), env)
        : {};
      const runtimeInstanceId = swarmRuntimeInstanceId();
      // JSON is valid YAML. Values stay data, including arbitrary system prompts.
      await writeFile(
        patchPath,
        JSON.stringify([
          {
            id: "agent-default-model",
            config: {
              provider: route,
              model: modelId,
              ...(reasoningEffort ? { reasoningEffort } : {}),
            },
          },
          { id: "system-prompt", config: { personaPrefix: config.systemPrompt } },
          openrouter
            ? {
                id: "llm-pi-ai",
                config: {
                  providers: {
                    openrouter: {
                      apiKeyEnv: keyEnv,
                      baseURL: getOpenRouterBaseUrl(env),
                      ...(Object.keys(openRouterHeaders).length > 0
                        ? { headers: openRouterHeaders }
                        : {}),
                      api: "openai-completions",
                      // Declare the selected ID even if the bundled catalog predates it.
                      models: [
                        reasoningEffort
                          ? { id: modelId, reasoningEfforts: openRouterEfforts(model) }
                          : { id: modelId },
                      ],
                    },
                  },
                },
              }
            : { id: "llm-deepseek", config: { apiKeyEnv: keyEnv } },
          // The worker container is the sandbox, as for codex
          // (`danger-full-access`). dsh's workspace-write policy only lets
          // writes through to the cwd and /tmp, has no setting for more
          // roots, and refuses escalation headless, so a dsh agent could not
          // write /workspace/shared or /workspace/personal.
          {
            id: "sandbox-policy",
            config: { mode: "danger-full-access", workspaceRoot: config.cwd },
          },
          { id: "approval", config: { policy: "never" } },
          // dsh does not mount its MCP client in the headless profile; insert
          // one for the swarm server, with the same per-task identity headers
          // the other adapters send.
          {
            insert: [
              {
                id: DSH_MCP_ENTRY_ID,
                name: "@deepseek-ai/dsh-mcp-client",
                config: {
                  serverName: DSH_MCP_SERVER_NAME,
                  transport: "streamable-http",
                  url: `${config.apiUrl}/mcp`,
                  headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    "X-Agent-ID": config.agentId,
                    "X-Source-Task-Id": config.taskId,
                    ...(config.contextKey ? { "X-Context-Key": config.contextKey } : {}),
                    ...(runtimeInstanceId ? { "X-Runtime-Instance-ID": runtimeInstanceId } : {}),
                  },
                  failOnStartupError: true,
                },
              },
            ],
          },
        ]),
        { mode: 0o600 },
      );
      const proc = registerProcessGroup(
        Bun.spawn([binary, "--profile", "headless", "--patch", patchPath, "--json", "-"], {
          cwd: config.cwd,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          detached: detachedProcessGroup,
        }),
      );
      return new DshSession(proc, directory, prompt, {
        model,
        route,
        modelId,
        reasoningEffort,
        taskId: config.taskId,
        agentId: config.agentId,
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
