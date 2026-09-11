import {
  type Client,
  ClientSideConnection,
  type McpServer,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import pkg from "../../package.json";
import type { AcpSessionConfigOption } from "../types";
import { mintAcpSessionToken, revokeAcpSessionToken } from "../utils/acp-session-token";
import { fetchInstalledMcpServers } from "../utils/mcp-server-fetcher";
import {
  detachedProcessGroup,
  registerProcessGroup,
  terminateProcessGroup,
} from "../utils/process-group";
import { scrubSecrets } from "../utils/secret-scrubber";
import { translateAcpSessionNotification } from "./acp-swarm-events";
import { resolveAcpTarget } from "./acp-targets";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

type EventListener = (event: ProviderEvent) => void;
const ACP_LOG_MAX_CHARS = 30_000;
const ACP_LOG_FIELD_MAX_CHARS = 12_000;
const ACP_LOG_PREVIEW_MAX_CHARS = 10_000;
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-session-token",
]);

function isCredentialHeaderName(value: string): boolean {
  return CREDENTIAL_HEADER_NAMES.has(value.trim().toLowerCase());
}

function isCredentialHeader(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && isCredentialHeaderName(name);
}

function serializeAcpLog(value: unknown): string {
  const serialized = JSON.stringify(value, (key, child) => {
    if (isCredentialHeaderName(key)) return undefined;
    if (key.toLowerCase() === "headers" && Array.isArray(child)) {
      return child.filter((header) => !isCredentialHeader(header));
    }
    if (typeof child !== "string") return child;
    const scrubbed = scrubSecrets(child);
    return scrubbed.length > ACP_LOG_FIELD_MAX_CHARS
      ? `${scrubbed.slice(0, ACP_LOG_FIELD_MAX_CHARS)}… [truncated]`
      : scrubbed;
  });
  if (serialized.length <= ACP_LOG_MAX_CHARS) return serialized;

  const sanitizedValue = JSON.parse(serialized) as unknown;
  const record: Record<string, unknown> | undefined =
    sanitizedValue && typeof sanitizedValue === "object" && !Array.isArray(sanitizedValue)
      ? (sanitizedValue as Record<string, unknown>)
      : undefined;
  const update =
    record && "update" in record && record.update && typeof record.update === "object"
      ? record.update
      : undefined;
  const preview = `${serialized.slice(0, ACP_LOG_PREVIEW_MAX_CHARS)}… [truncated]`;
  if (record && "type" in record) {
    const type = record.type;
    if (type === "tool_start") {
      return JSON.stringify({
        type,
        toolCallId: boundedAcpLogScalar(record.toolCallId),
        toolName: boundedAcpLogScalar(record.toolName),
        args: { truncated: true, preview },
      });
    }
    if (type === "tool_end") {
      const result =
        record.result && typeof record.result === "object" && !Array.isArray(record.result)
          ? (record.result as Record<string, unknown>)
          : undefined;
      return JSON.stringify({
        type,
        toolCallId: boundedAcpLogScalar(record.toolCallId),
        toolName: boundedAcpLogScalar(record.toolName),
        result: {
          status: boundedAcpLogScalar(result?.status),
          truncated: true,
          preview,
        },
      });
    }
    if (type === "custom") {
      return JSON.stringify({
        type,
        name: boundedAcpLogScalar(record.name),
        data: { truncated: true, preview },
      });
    }
  }
  const summary = {
    type: "acp_log_truncated",
    originalType:
      record && "type" in record && typeof record.type === "string" ? record.type : undefined,
    sessionId:
      record && "sessionId" in record && typeof record.sessionId === "string"
        ? record.sessionId.slice(0, 500)
        : undefined,
    sessionUpdate:
      update && "sessionUpdate" in update && typeof update.sessionUpdate === "string"
        ? update.sessionUpdate
        : undefined,
    preview,
  };
  const bounded = JSON.stringify(summary);
  if (bounded.length <= ACP_LOG_MAX_CHARS) return bounded;
  return JSON.stringify({
    type: "acp_log_truncated",
    originalType: summary.originalType?.slice(0, 500),
    sessionId: summary.sessionId,
    sessionUpdate: summary.sessionUpdate?.slice(0, 500),
  });
}

function boundedAcpLogScalar(value: unknown): unknown {
  return typeof value === "string" ? value.slice(0, 500) : value;
}

class SwarmAcpClient implements Client {
  constructor(private readonly emit: (event: ProviderEvent) => void) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const selected =
      params.options.find((option) => option.kind === "allow_always") ??
      params.options.find((option) => option.kind === "allow_once") ??
      params.options[0];
    if (!selected) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: selected.optionId } };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.emit({ type: "raw_log", content: serializeAcpLog(params) });
    for (const event of translateAcpSessionNotification(params)) {
      this.emit(event);
    }
  }
}

class ACPSession implements ProviderSession {
  readonly sessionId: string;

  private readonly listeners = new Set<EventListener>();
  private readonly pendingEvents: ProviderEvent[] = [];
  private readonly startedAt = Date.now();
  private completed = false;
  private aborted = false;
  private output = "";
  private completionPromise: Promise<ProviderResult>;
  private completionResolve!: (result: ProviderResult) => void;
  /** ID of the ephemeral aseph_ token minted for this session, or null when
   * the fallback operator key is in use (e.g. during tests or if the API is
   * not yet upgraded). Revoked in finish(). */
  private ephemeralTokenId: string | null = null;

  constructor(
    private readonly connection: ClientSideConnection,
    private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly config: ProviderSessionConfig,
    sessionId: string,
    providerMeta?: Record<string, unknown>,
    ephemeralTokenId?: string,
  ) {
    this.sessionId = sessionId;
    this.ephemeralTokenId = ephemeralTokenId ?? null;
    this.completionPromise = new Promise((resolve) => {
      this.completionResolve = resolve;
    });
    void this.consumeStderr();
    this.emit({ type: "session_init", sessionId, provider: "acp", providerMeta });
    void this.runPrompt();
  }

  onEvent(listener: EventListener): void {
    this.listeners.add(listener);
    for (const event of this.pendingEvents.splice(0)) {
      listener(event);
    }
  }

  waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch (err) {
      this.emit({
        type: "error",
        message: scrubSecrets(`ACP session/cancel failed: ${formatError(err)}`),
        category: "abort",
      });
    }
    await terminateProcessGroup(this.process.pid);
    this.finish({
      exitCode: 1,
      sessionId: this.sessionId,
      isError: true,
      failureReason: "aborted",
    });
  }

  emitFromAcp(event: ProviderEvent): void {
    this.emit(event);
  }

  private emit(event: ProviderEvent): void {
    if (event.type === "message" && event.role === "assistant") {
      this.output += event.content;
    }
    this.emitDirect(event);
    if (event.type !== "raw_log" && event.type !== "raw_stderr") {
      this.emitDirect({
        type: "raw_log",
        content: serializeAcpLog(event),
      });
    }
  }

  private emitDirect(event: ProviderEvent): void {
    if (this.listeners.size === 0) {
      this.pendingEvents.push(event);
      return;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async runPrompt(): Promise<void> {
    let result: ProviderResult;
    try {
      const response = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: this.config.prompt }],
      });
      const isError = response.stopReason === "refusal" || response.stopReason === "cancelled";
      const cost = this.buildCostData(isError);
      result = {
        exitCode: isError ? 1 : 0,
        sessionId: this.sessionId,
        cost,
        output: this.output,
        isError,
        failureReason: isError ? `ACP prompt stopped with ${response.stopReason}` : undefined,
      };
      this.emit({ type: "result", cost, output: this.output, isError });
    } catch (err) {
      const message = scrubSecrets(formatError(err));
      this.emit({ type: "error", message, category: "protocol" });
      result = {
        exitCode: 1,
        sessionId: this.sessionId,
        isError: true,
        failureReason: `ACP prompt failed: ${message}`,
      };
    } finally {
      await terminateProcessGroup(this.process.pid);
    }
    this.finish(result);
  }

  private async consumeStderr(): Promise<void> {
    const stderr = this.process.stderr;
    if (!stderr) return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length > 0) {
          this.emit({ type: "raw_stderr", content: scrubSecrets(decoder.decode(value)) });
        }
      }
    } catch {
      // Process teardown can close stderr while a read is pending.
    }
  }

  private buildCostData(isError: boolean): CostData {
    return {
      sessionId: this.sessionId,
      taskId: this.config.taskId,
      agentId: this.config.agentId,
      totalCostUsd: 0,
      durationMs: Date.now() - this.startedAt,
      numTurns: 1,
      model: this.config.model,
      isError,
      provider: "acp",
    };
  }

  private finish(result: ProviderResult): void {
    if (this.completed) return;
    this.completed = true;
    this.completionResolve(result);
    // Revoke the ephemeral token now that the session is done. Best-effort:
    // the token expires on its own, so a failure here is not critical.
    if (this.ephemeralTokenId) {
      void revokeAcpSessionToken(this.config.apiUrl, this.config.apiKey, this.ephemeralTokenId);
    }
  }
}

export class ACPAdapter implements ProviderAdapter {
  readonly name = "acp";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasLocalEnvironment: true,
  };

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const target = resolveAcpTarget(config);
    await target.writeSystemPromptArtifact(config);
    const command = target.command(config);
    const proc = registerProcessGroup(
      Bun.spawn(command, {
        cwd: config.cwd,
        detached: detachedProcessGroup,
        env: target.env(config),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    let session: ACPSession | null = null;
    const preSessionEvents: ProviderEvent[] = [];
    const client = new SwarmAcpClient((event) => {
      if (session) session.emitFromAcp(event);
      else preSessionEvents.push(event);
    });
    const stream = ndJsonStream(fileSinkWritableStream(proc.stdin), proc.stdout);
    const connection = new ClientSideConnection(() => client, stream);

    let ephemeralToken: { tokenId: string; plaintext: string } | null = null;
    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "agent-swarm", version: pkg.version },
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
      });
      // Mint a short-lived session-scoped bearer so the ACP target receives
      // an aseph_ token rather than the full operator key. Throws on failure
      // so we fail closed instead of falling back to the operator key.
      ephemeralToken = await mintAcpSessionToken(
        config.apiUrl,
        config.apiKey,
        config.agentId,
        config.taskId,
      );

      const installedServers = await fetchInstalledMcpServers(
        config.apiUrl,
        config.apiKey,
        config.agentId,
        "claude",
      );
      // The v2 draft (@agentclientprotocol/sdk/experimental/v2) adds a fourth
      // `{ type: "acp", name, serverId }` variant where the client hosts the MCP
      // server itself and the agent tunnels MCP over the existing ACP connection
      // (mcp/connect, mcp/message, mcp/disconnect) instead of a network hop -- the
      // shape for an ACP agent with no network route to the swarm API. Gated on
      // `mcpCapabilities.acp` and UNSTABLE; not adopted here.
      const newSession = await connection.newSession({
        cwd: config.cwd,
        mcpServers: [
          {
            type: "http",
            name: "swarm",
            url: `${config.apiUrl.replace(/\/+$/, "")}/mcp`,
            headers: [
              { name: "Authorization", value: `Bearer ${ephemeralToken.plaintext}` },
              { name: "X-Agent-ID", value: config.agentId },
              { name: "X-Source-Task-Id", value: config.taskId },
            ],
          },
          ...toAcpMcpServers(installedServers),
        ],
      });
      const configOptions = await applyConfiguredOptions(
        connection,
        newSession.sessionId,
        newSession.configOptions ?? [],
        target.configuredOptions(config),
      );
      session = new ACPSession(
        connection,
        proc,
        config,
        newSession.sessionId,
        {
          target: target.target,
          configOptions: sanitizeAcpConfigOptions(configOptions),
        },
        ephemeralToken.tokenId,
      );
      for (const event of preSessionEvents) session.emitFromAcp(event);
      return session;
    } catch (err) {
      // Revoke the ephemeral token before re-throwing if ACPSession has not yet
      // taken ownership of it (i.e. setup failed after mint but before the
      // ACPSession constructor ran).
      if (ephemeralToken && !session) {
        void revokeAcpSessionToken(config.apiUrl, config.apiKey, ephemeralToken.tokenId);
      }
      await terminateProcessGroup(proc.pid);
      throw new Error(`ACP target failed during startup: ${scrubSecrets(formatError(err))}`);
    }
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}

export async function applyConfiguredOptions(
  connection: Pick<ClientSideConnection, "setSessionConfigOption">,
  sessionId: string,
  advertised: SessionConfigOption[],
  configured: Record<string, string | boolean>,
): Promise<SessionConfigOption[]> {
  let current = advertised;
  for (const [configId, value] of Object.entries(configured)) {
    const option = current.find((entry) => entry.id === configId);
    if (!option) {
      console.warn(
        `\x1b[33m[acp]\x1b[0m Config option "${configId}" was not advertised; using target fallback`,
      );
      continue;
    }
    if (option.type === "boolean" && typeof value !== "boolean") {
      console.warn(
        `\x1b[33m[acp]\x1b[0m Config option "${configId}" expects a boolean; using target fallback`,
      );
      continue;
    }
    if (option.type === "select" && typeof value !== "string") {
      console.warn(
        `\x1b[33m[acp]\x1b[0m Config option "${configId}" expects a string; using target fallback`,
      );
      continue;
    }
    try {
      const response =
        typeof value === "boolean"
          ? await connection.setSessionConfigOption({
              sessionId,
              configId,
              type: "boolean",
              value,
            })
          : await connection.setSessionConfigOption({ sessionId, configId, value });
      current = response.configOptions;
    } catch (err) {
      console.warn(
        `\x1b[33m[acp]\x1b[0m Failed to set config option "${configId}"; using target fallback: ${scrubSecrets(formatError(err))}`,
      );
    }
  }
  return current;
}

export function sanitizeAcpConfigOptions(options: SessionConfigOption[]): AcpSessionConfigOption[] {
  return options.map((option) => {
    const common = {
      id: scrubSecrets(option.id),
      name: scrubSecrets(option.name),
      description:
        option.description == null ? option.description : scrubSecrets(option.description),
      category: option.category == null ? option.category : scrubSecrets(option.category),
    };
    if (option.type === "boolean") {
      return { ...common, type: "boolean" as const, currentValue: option.currentValue };
    }
    return {
      ...common,
      type: "select" as const,
      currentValue: scrubSecrets(option.currentValue),
      options: option.options.map((entry) =>
        "group" in entry
          ? {
              group: scrubSecrets(entry.group),
              name: entry.name == null ? entry.name : scrubSecrets(entry.name),
              options: entry.options.map(({ value, name, description }) => ({
                value: scrubSecrets(value),
                name: scrubSecrets(name),
                description: description == null ? description : scrubSecrets(description),
              })),
            }
          : {
              value: scrubSecrets(entry.value),
              name: scrubSecrets(entry.name),
              description:
                entry.description == null ? entry.description : scrubSecrets(entry.description),
            },
      ),
    };
  });
}

/**
 * Convert `fetchInstalledMcpServers`'s "claude"-format map (`{ command, args, env }`
 * for stdio, `{ type, url, headers }` for http/sse) into ACP's `McpServer` array
 * shape, which is a tagged union with header/env pairs as arrays instead of maps.
 */
export function toAcpMcpServers(
  installed: Record<string, Record<string, unknown>> | null,
): McpServer[] {
  if (!installed) return [];
  const servers: McpServer[] = [];
  for (const [name, entry] of Object.entries(installed)) {
    if (typeof entry.command === "string") {
      const env = (entry.env ?? {}) as Record<string, string>;
      servers.push({
        name,
        command: entry.command,
        args: Array.isArray(entry.args) ? (entry.args as string[]) : [],
        env: Object.entries(env).map(([key, value]) => ({ name: key, value })),
      });
      continue;
    }
    if (typeof entry.url === "string") {
      const headers = (entry.headers ?? {}) as Record<string, string>;
      servers.push({
        type: entry.type === "sse" ? "sse" : "http",
        name,
        url: entry.url,
        headers: Object.entries(headers).map(([key, value]) => ({ name: key, value })),
      });
      continue;
    }
    console.warn(
      `\x1b[33m[acp]\x1b[0m Skipping installed MCP server "${name}": no command or url in resolved config`,
    );
  }
  return servers;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fileSinkWritableStream(sink: Bun.FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      sink.write(chunk);
      sink.flush();
    },
    close() {
      sink.end();
    },
    abort() {
      sink.end();
    },
  });
}
