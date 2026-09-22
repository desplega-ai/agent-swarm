import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_TIER_MAP } from "../types";
import { getOpenRouterBaseUrl } from "../utils/openrouter-base-url";
import {
  detachedProcessGroup,
  registerProcessGroup,
  terminateProcessGroup,
} from "../utils/process-group";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";
import { resolveSlashSkillPrompt } from "./codex-skill-resolver";
import type {
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

// npm's `latest` is older and lacks the JSON/stdin contract used here.
export const DSH_PACKAGE = "@deepseek-ai/dsh@0.1.7-alpha.2";

export function checkDshCredentials(env: Record<string, string | undefined>): CredStatus {
  return env.DEEPSEEK_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim()
    ? { ready: true, missing: [], satisfiedBy: "env" }
    : {
        ready: false,
        missing: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"],
        hint: "Set DEEPSEEK_API_KEY or OPENROUTER_API_KEY for dsh.",
      };
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

  constructor(
    private proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private directory: string,
    prompt: string,
  ) {
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
      } else if (event.type === "status" && typeof event.phase === "string") {
        this.emit({ type: "progress", message: event.phase });
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
      return {
        exitCode: isError ? exitCode || 1 : 0,
        sessionId: this.sessionId,
        output: this.output,
        isError,
        failureReason,
      };
    } catch (error) {
      await terminateProcessGroup(this.proc.pid);
      const failureReason = scrubSecrets(String(error));
      this.emit({ type: "error", message: failureReason });
      return { exitCode: 1, sessionId: this.sessionId, isError: true, failureReason };
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
    hasMcp: false,
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
    });
    const directory = await mkdtemp(join(tmpdir(), "swarm-dsh-"));
    try {
      const patchPath = join(directory, "patch.json");
      // JSON is valid YAML. Values stay data, including arbitrary system prompts.
      await writeFile(
        patchPath,
        JSON.stringify([
          {
            id: "agent-default-model",
            config: { provider: openrouter ? "openrouter" : "deepseek-official", model: modelId },
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
                      api: "openai-completions",
                      // Declare the selected ID even if the bundled catalog predates it.
                      models: [{ id: modelId }],
                    },
                  },
                },
              }
            : { id: "llm-deepseek", config: { apiKeyEnv: keyEnv } },
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
      return new DshSession(proc, directory, prompt);
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
