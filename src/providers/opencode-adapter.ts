/**
 * Opencode provider adapter.
 *
 * Sub-4 added the OpencodeAdapter skeleton; sub-5 added the full session
 * lifecycle (SSE events, cost accumulation, raw_log persistence); sub-6 (DES-300)
 * adds per-task isolation: agent file, OPENCODE_CONFIG, OPENCODE_DATA_HOME.
 * Sub-7 (DES-301) wires the agent-swarm opencode plugin for cancellation,
 * heartbeat, identity sync, system.transform, compacting, and idle hooks.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Config, Event as OpencodeEvent } from "@opencode-ai/sdk";
import { createOpencode } from "@opencode-ai/sdk";
import { validateOpencodeCredentials } from "../utils/credentials";
import { fetchInstalledMcpServers } from "../utils/mcp-server-fetcher";
import { scrubSecrets } from "../utils/secret-scrubber";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as AssistantMessage).role === "assistant" &&
    typeof (msg as AssistantMessage).cost === "number"
  );
}

const DOCKER_PLUGIN_PATH = "/home/worker/.config/opencode/plugins/agent-swarm.ts";

function resolvePluginPath(): string {
  const override = process.env.OPENCODE_SWARM_PLUGIN_PATH;
  if (override) return override;
  if (existsSync(DOCKER_PLUGIN_PATH)) return DOCKER_PLUGIN_PATH;
  return join(import.meta.dir, "../../plugin/opencode-plugins/agent-swarm.ts");
}

class OpencodeSession implements ProviderSession {
  private _sessionId: string;
  private listeners: Array<(event: ProviderEvent) => void> = [];
  // Buffer for events emitted before any listener is attached.
  // The runner attaches its listener after `await adapter.createSession(...)`
  // resolves, but events queued via Promise.resolve().then(...) inside
  // createSession fire on the next microtask — *before* that listener call —
  // so the runner would miss session_init and never PUT /claude-session,
  // leaving agent_tasks.provider/.model NULL. Buffer + flush on first attach.
  private pendingEvents: ProviderEvent[] = [];
  private completionResolve!: (result: ProviderResult) => void;
  private completionReject!: (err: Error) => void;
  private completionPromise: Promise<ProviderResult>;
  private server: { url: string; close(): void };
  private aborted = false;

  // Running cost accumulators
  private totalCostUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private numTurns = 0;
  private startedAt = Date.now();
  private model: string;
  private agentId: string;
  private taskId: string;

  // Per-task isolation paths (for cleanup)
  private agentFilePath: string;
  private configFilePath: string;
  private dataHomePath: string;

  constructor(
    sessionId: string,
    server: { url: string; close(): void },
    model: string,
    agentId: string,
    taskId: string,
    agentFilePath: string,
    configFilePath: string,
    dataHomePath: string,
  ) {
    this._sessionId = sessionId;
    this.server = server;
    this.model = model;
    this.agentId = agentId;
    this.taskId = taskId;
    this.agentFilePath = agentFilePath;
    this.configFilePath = configFilePath;
    this.dataHomePath = dataHomePath;
    this.completionPromise = new Promise<ProviderResult>((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /** Emit the synthetic session_init event. Called by the adapter immediately
   * after construction; buffers if no listener is attached yet. */
  emitSessionInit(provider: "opencode"): void {
    this.emit({ type: "session_init", sessionId: this._sessionId, provider });
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    const wasEmpty = this.listeners.length === 0;
    this.listeners.push(listener);
    if (wasEmpty && this.pendingEvents.length > 0) {
      const buffered = this.pendingEvents;
      this.pendingEvents = [];
      for (const ev of buffered) listener(ev);
    }
  }

  private emit(event: ProviderEvent): void {
    if (this.listeners.length === 0) {
      this.pendingEvents.push(event);
    } else {
      for (const l of this.listeners) l(event);
    }
    // Also emit a raw_log for every event (scrubbed)
    if (event.type !== "raw_log") {
      const raw = scrubSecrets(JSON.stringify(event));
      this.emitDirect({ type: "raw_log", content: raw });
    }
  }

  private emitDirect(event: ProviderEvent): void {
    if (this.listeners.length === 0) {
      this.pendingEvents.push(event);
      return;
    }
    for (const l of this.listeners) l(event);
  }

  /** Best-effort cleanup of per-task isolation files and directories. */
  private async cleanupFiles(): Promise<void> {
    try {
      await Bun.$`rm -f ${this.agentFilePath}`.quiet().nothrow();
    } catch {
      // best-effort
    }
    try {
      await Bun.$`rm -f ${this.configFilePath}`.quiet().nothrow();
    } catch {
      // best-effort
    }
    try {
      await Bun.$`rm -rf ${this.dataHomePath}`.quiet().nothrow();
    } catch {
      // best-effort
    }
  }

  /** Process a single opencode SSE event */
  handleOpencodeEvent(ev: OpencodeEvent): void {
    if (this.aborted) return;

    // Always emit the raw event as a scrubbed raw_log
    const rawContent = scrubSecrets(JSON.stringify(ev));
    this.emitDirect({ type: "raw_log", content: rawContent });

    switch (ev.type) {
      case "message.updated": {
        const msg = ev.properties.info;
        if (!isAssistantMessage(msg) || msg.sessionID !== this._sessionId) break;
        // Accumulate cost from each completed assistant message ("step")
        this.totalCostUsd += msg.cost;
        this.inputTokens += msg.tokens?.input ?? 0;
        this.outputTokens += msg.tokens?.output ?? 0;
        this.cacheReadTokens += msg.tokens?.cache?.read ?? 0;
        this.cacheWriteTokens += msg.tokens?.cache?.write ?? 0;
        this.numTurns += 1;
        if (!this.model && msg.modelID) this.model = msg.modelID;
        break;
      }

      case "session.idle": {
        if (ev.properties.sessionID !== this._sessionId) break;
        const cost = this.buildCostData(false);
        const resultEvent: ProviderEvent = {
          type: "result",
          cost,
          isError: false,
        };
        // Emit result (raw_log will be auto-emitted via emit())
        for (const l of this.listeners) l(resultEvent);
        const raw = scrubSecrets(JSON.stringify(resultEvent));
        this.emitDirect({ type: "raw_log", content: raw });
        this.completionResolve({
          exitCode: 0,
          sessionId: this._sessionId,
          cost,
          isError: false,
        });
        break;
      }

      case "session.error": {
        if (ev.properties.sessionID !== undefined && ev.properties.sessionID !== this._sessionId)
          break;
        const errMsg =
          ev.properties.error && "message" in ev.properties.error
            ? String((ev.properties.error as { message?: string }).message ?? "unknown error")
            : "opencode session error";
        this.emitError(errMsg);
        break;
      }

      case "permission.updated": {
        if (ev.properties.sessionID !== this._sessionId) break;
        // Headless worker cannot interactively approve permissions — treat as error
        this.emitError(
          `Permission request received in headless mode (id=${ev.properties.id}); aborting session`,
        );
        break;
      }

      default:
        break;
    }
  }

  private emitError(message: string): void {
    const errorEvent: ProviderEvent = { type: "error", message };
    for (const l of this.listeners) l(errorEvent);
    const raw = scrubSecrets(JSON.stringify(errorEvent));
    this.emitDirect({ type: "raw_log", content: raw });
    const cost = this.buildCostData(true);
    this.completionResolve({
      exitCode: 1,
      sessionId: this._sessionId,
      cost,
      isError: true,
      failureReason: message,
    });
  }

  private buildCostData(isError: boolean): CostData {
    return {
      sessionId: this._sessionId,
      taskId: this.taskId,
      agentId: this.agentId,
      totalCostUsd: this.totalCostUsd,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      durationMs: Date.now() - this.startedAt,
      numTurns: this.numTurns,
      model: this.model,
      isError,
      provider: "opencode",
    };
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    this.server.close();
    await this.cleanupFiles();
    this.completionResolve({
      exitCode: 1,
      sessionId: this._sessionId,
      isError: true,
      failureReason: "aborted",
    });
  }
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly name = "opencode";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasLocalEnvironment: true,
  };

  validateCredentials(env: Record<string, string | undefined> = {}): string {
    return validateOpencodeCredentials(env);
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const taskId = config.taskId;
    const agentName = `swarm-${taskId}`;
    const agentFilePath = join(config.cwd, ".opencode", "agents", `${agentName}.md`);
    const configFilePath = `/tmp/opencode-${taskId}.json`;
    const dataHomePath = `/tmp/opencode-data-${taskId}`;

    // Write per-task agent file (best-effort; contains the system prompt)
    try {
      mkdirSync(join(config.cwd, ".opencode", "agents"), { recursive: true });
      await Bun.write(agentFilePath, config.systemPrompt ?? "");
    } catch {
      // best-effort
    }

    // Build MCP config: swarm endpoint + installed MCP servers
    const installedMcp =
      (await fetchInstalledMcpServers(config.apiUrl, config.apiKey, config.agentId, "opencode")) ??
      {};
    const mcpConfig: Config["mcp"] = {
      swarm: {
        type: "remote",
        url: `${config.apiUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "X-Agent-ID": config.agentId,
        },
      },
      ...installedMcp,
    };

    // Resolve the agent-swarm plugin path. Three layers, in priority order:
    //   1. OPENCODE_SWARM_PLUGIN_PATH env (explicit override)
    //   2. The well-known Docker location (Dockerfile.worker COPYs the plugin
    //      to /home/worker/.config/opencode/plugins/agent-swarm.ts)
    //   3. The dev path relative to this source file
    // The previous one-liner used `import.meta.dir` only, which resolves to
    // `/usr/local/bin` for the bundled binary and produced the non-existent
    // `/plugin/opencode-plugins/agent-swarm.ts`. Docker only worked because
    // opencode auto-discovers plugins from ~/.config/opencode/plugins/ —
    // an accident, not a contract.
    const pluginPath = resolvePluginPath();

    // Build per-task opencode config (plugin field carries the swarm plugin)
    const opencodeConfig: Config & { plugin?: string[] } = {
      $schema: "https://opencode.ai/config.json",
      model: config.model,
      mcp: mcpConfig,
      permission: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        doom_loop: "allow",
        external_directory: "allow",
      },
      plugin: [pluginPath],
    };

    // Write per-task config file
    try {
      await Bun.write(configFilePath, JSON.stringify(opencodeConfig, null, 2));
    } catch {
      // best-effort
    }

    // Set per-task data home before spawning the opencode process
    process.env.OPENCODE_DATA_HOME = dataHomePath;

    // Set SWARM_* env vars so the plugin can read them (inherited by child process)
    const swarmEnvSnapshot = {
      SWARM_API_URL: process.env.SWARM_API_URL,
      SWARM_API_KEY: process.env.SWARM_API_KEY,
      SWARM_AGENT_ID: process.env.SWARM_AGENT_ID,
      SWARM_TASK_ID: process.env.SWARM_TASK_ID,
      SWARM_IS_LEAD: process.env.SWARM_IS_LEAD,
    };
    process.env.SWARM_API_URL = config.apiUrl;
    process.env.SWARM_API_KEY = config.apiKey;
    process.env.SWARM_AGENT_ID = config.agentId;
    process.env.SWARM_TASK_ID = config.taskId;
    process.env.SWARM_IS_LEAD = config.role === "lead" ? "true" : "false";

    // Set OPENCODE_CONFIG scoped to the spawn call (save + restore)
    const prevOpencodeConfig = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = configFilePath;

    let client: Awaited<ReturnType<typeof createOpencode>>["client"];
    let server: Awaited<ReturnType<typeof createOpencode>>["server"];
    try {
      ({ client, server } = await createOpencode({
        hostname: "127.0.0.1",
        port: 0,
        config: opencodeConfig,
      }));
    } finally {
      // Restore OPENCODE_CONFIG after the process has been spawned
      if (prevOpencodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = prevOpencodeConfig;
      }
      // Restore SWARM_* env vars
      for (const [key, val] of Object.entries(swarmEnvSnapshot)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
    }

    // Create the opencode session (project directory = config.cwd)
    const createResult = await client.session.create({ query: { directory: config.cwd } });
    if (!createResult.data) {
      server.close();
      throw new Error("Failed to create opencode session");
    }
    const opencodeSession = createResult.data;
    const sessionId = opencodeSession.id;

    const session = new OpencodeSession(
      sessionId,
      server,
      config.model,
      config.agentId,
      config.taskId,
      agentFilePath,
      configFilePath,
      dataHomePath,
    );

    // Emit session_init synchronously; the session buffers events until the
    // runner's `onEvent(listener)` call attaches a listener.
    session.emitSessionInit("opencode");

    // Subscribe to SSE events and drive the session
    client.event
      .subscribe({ query: { directory: config.cwd } })
      .then(async ({ stream }) => {
        for await (const event of stream) {
          session.handleOpencodeEvent(event as OpencodeEvent);
        }
        // Stream ended without session.idle — treat as completion
      })
      .catch((err: unknown) => {
        session.handleOpencodeEvent({
          type: "session.error",
          properties: { sessionID: sessionId, error: { message: String(err) } as never },
        });
      });

    // Fire-and-forget: send the prompt using the per-task agent
    client.session
      .prompt({
        path: { id: sessionId },
        query: { directory: config.cwd },
        body: {
          agent: agentName,
          parts: [{ type: "text", text: config.prompt }],
        },
      })
      .catch((err: unknown) => {
        session.handleOpencodeEvent({
          type: "session.error",
          properties: { sessionID: sessionId, error: { message: String(err) } as never },
        });
      });

    return session;
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
