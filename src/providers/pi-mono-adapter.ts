/**
 * Pi-mono provider adapter.
 *
 * Creates pi-mono AgentSessions and normalizes their events to the
 * shared ProviderEvent union. MCP tools from the swarm endpoint are
 * discovered at session creation and registered as custom tools.
 */

import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import type {
  AgentSessionEvent,
  CreateAgentSessionOptions,
  SessionStats,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { type TSchema, Type } from "@sinclair/typebox";
import { scrubSecrets } from "../utils/secret-scrubber";
import { createSwarmHooksExtension } from "./pi-mono-extension";
import { McpHttpClient } from "./pi-mono-mcp-client";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

/** Convert a JSON Schema object to a TypeBox TSchema using Type.Unsafe */
function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
  // Type.Unsafe wraps a plain JSON Schema as a TypeBox-compatible TSchema
  return Type.Unsafe(schema);
}

/** Convert MCP tools to pi-mono ToolDefinition objects */
function mcpToolsToDefinitions(
  mcpClient: McpHttpClient,
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description || tool.name,
    parameters: jsonSchemaToTypeBox(tool.inputSchema),
    async execute(_toolCallId, params) {
      const result = await mcpClient.callTool(tool.name, params as Record<string, unknown>);
      const text = result.content
        .map((c) => c.text ?? "")
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: text || "(no output)" }],
        details: undefined,
      };
    },
  }));
}

/** Resolve a model string to a pi-ai Model object */
function resolveModel(modelStr: string) {
  if (!modelStr) return undefined;

  // Map common shortnames to provider/model pairs
  const shortnames: Record<string, [string, string]> = {
    opus: ["anthropic", "claude-opus-4-20250514"],
    sonnet: ["anthropic", "claude-sonnet-4-20250514"],
    haiku: ["anthropic", "claude-haiku-4-5-20251001"],
  };

  const mapping = shortnames[modelStr.toLowerCase()];
  if (mapping) {
    try {
      return getModel(mapping[0] as "anthropic", mapping[1] as never);
    } catch {
      return undefined;
    }
  }

  // Try parsing "provider/model-id" format (split on first "/" only —
  // OpenRouter model IDs contain slashes, e.g. "openrouter/google/gemini-2.5-flash-lite")
  if (modelStr.includes("/")) {
    const slashIdx = modelStr.indexOf("/");
    const provider = modelStr.slice(0, slashIdx);
    const modelId = modelStr.slice(slashIdx + 1);
    try {
      return getModel(provider as "anthropic", modelId as never);
    } catch {
      return undefined;
    }
  }

  // Try as a full model ID with common providers
  for (const provider of ["anthropic", "openai", "google"]) {
    try {
      return getModel(provider as "anthropic", modelStr as never);
    } catch {}
  }

  return undefined;
}

/** Manage AGENTS.md symlink for pi-mono CLAUDE.md compatibility */
function createAgentsMdSymlink(cwd: string): boolean {
  const claudeMd = join(cwd, "CLAUDE.md");
  const agentsMd = join(cwd, "AGENTS.md");

  if (existsSync(claudeMd) && !existsSync(agentsMd)) {
    try {
      symlinkSync("CLAUDE.md", agentsMd);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function cleanupAgentsMdSymlink(cwd: string): void {
  const agentsMd = join(cwd, "AGENTS.md");
  try {
    // Only remove if it's actually a symlink — never delete real AGENTS.md files
    if (existsSync(agentsMd) && lstatSync(agentsMd).isSymbolicLink()) {
      unlinkSync(agentsMd);
    }
  } catch {
    // Ignore cleanup errors
  }
}

class PiMonoSession implements ProviderSession {
  private listeners: Array<(event: ProviderEvent) => void> = [];
  private eventQueue: ProviderEvent[] = [];
  private _sessionId: string | undefined;
  private completionPromise: Promise<ProviderResult>;
  private agentSession: AgentSession;
  private config: ProviderSessionConfig;
  private createdSymlink: boolean;
  private logFileHandle: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  /** Track last emitted message text to avoid duplicates across turns */
  private lastEmittedMessage = "";

  constructor(agentSession: AgentSession, config: ProviderSessionConfig, createdSymlink: boolean) {
    this.agentSession = agentSession;
    this.config = config;
    this.createdSymlink = createdSymlink;
    this.logFileHandle = Bun.file(config.logFile).writer();
    this._sessionId = agentSession.sessionId;

    // Emit session_init immediately
    this.emit({ type: "session_init", sessionId: this._sessionId, provider: "pi" });

    // Subscribe to agent events and normalize
    this.agentSession.subscribe((event) => this.handleAgentEvent(event));

    // Start the prompt and track completion
    this.completionPromise = this.runSession();
  }

  private emit(event: ProviderEvent): void {
    // Scrub secrets from raw_log / raw_stderr content before egress (log file
    // write, listener dispatch, downstream session-logs push + pretty-print).
    const scrubbed: ProviderEvent =
      event.type === "raw_log" || event.type === "raw_stderr"
        ? { ...event, content: scrubSecrets(event.content) }
        : event;

    // Log all events
    this.logFileHandle.write(
      `${JSON.stringify({ ...scrubbed, timestamp: new Date().toISOString() })}\n`,
    );

    if (this.listeners.length > 0) {
      for (const listener of this.listeners) {
        listener(scrubbed);
      }
    } else {
      this.eventQueue.push(scrubbed);
    }
  }

  private handleAgentEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_end": {
        // Extract text from the final message (skip duplicates across turns)
        const msg = event.message;
        if (msg && "content" in msg) {
          const text = Array.isArray(msg.content)
            ? msg.content
                .filter((c: unknown) => (c as { type: string }).type === "text")
                .map((c: unknown) => (c as { text?: string }).text || "")
                .join("")
                .trim()
            : String(msg.content || "").trim();
          if (text && text !== this.lastEmittedMessage) {
            const model = this.agentSession.model?.name ?? this.config.model;
            this.emit({
              type: "raw_log",
              content: JSON.stringify({
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text }],
                  model,
                },
              }),
            });
            this.lastEmittedMessage = text;
          }
        }
        // Emit context_usage for dashboard tracking
        const usage = this.agentSession.getContextUsage();
        if (usage && usage.tokens != null) {
          this.emit({
            type: "context_usage",
            contextUsedTokens: usage.tokens,
            contextTotalTokens: usage.contextWindow,
            contextPercent: usage.percent ?? 0,
            outputTokens: 0,
          });
        }
        break;
      }
      case "tool_execution_start": {
        const model = this.agentSession.model?.name ?? this.config.model;
        this.emit({
          type: "raw_log",
          content: JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "tool_use", id: event.toolCallId, name: event.toolName, input: event.args },
              ],
              model,
            },
          }),
        });
        // Emit normalized tool_start for runner auto-progress
        this.emit({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      }
      case "tool_execution_end":
        this.emit({
          type: "raw_log",
          content: JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: event.toolCallId,
                  content:
                    typeof event.result === "string" ? event.result : JSON.stringify(event.result),
                },
              ],
            },
          }),
        });
        // Emit normalized tool_end
        this.emit({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
        });
        break;
      case "auto_retry_start":
        this.emit({
          type: "raw_stderr",
          content: `[pi-mono] Auto-retry attempt ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}\n`,
        });
        break;
    }
  }

  private async runSession(): Promise<ProviderResult> {
    try {
      // Send the prompt
      await this.agentSession.prompt(this.config.prompt, {
        source: "rpc",
      });

      // Wait for the agent to finish (poll until not streaming)
      await this.waitForIdle();

      // Gather cost data
      const stats = this.agentSession.getSessionStats();
      const cost = this.buildCostData(stats);

      this.emit({
        type: "result",
        cost,
        isError: false,
      });

      return {
        exitCode: 0,
        sessionId: this._sessionId,
        cost,
        isError: false,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.emit({ type: "raw_stderr", content: `[pi-mono] Error: ${errorMessage}\n` });

      return {
        exitCode: 1,
        sessionId: this._sessionId,
        isError: true,
        failureReason: errorMessage,
      };
    } finally {
      await this.logFileHandle.end();
      if (this.createdSymlink) {
        cleanupAgentsMdSymlink(this.config.cwd);
      }
      this.agentSession.dispose();
    }
  }

  private waitForIdle(): Promise<void> {
    return new Promise<void>((resolve) => {
      // Check if already idle
      if (!this.agentSession.isStreaming) {
        resolve();
        return;
      }

      // Subscribe and wait for agent_end
      const unsub = this.agentSession.subscribe((event) => {
        if (event.type === "agent_end") {
          unsub();
          resolve();
        }
      });
    });
  }

  private buildCostData(stats: SessionStats): CostData {
    return {
      sessionId: "", // Runner overrides with runner session ID
      taskId: this.config.taskId,
      agentId: this.config.agentId,
      totalCostUsd: stats.cost || 0,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      durationMs: 0, // Not directly available from SessionStats
      numTurns: stats.userMessages + stats.assistantMessages,
      model: this.agentSession.model?.name ?? this.config.model,
      isError: false,
      provider: "pi",
    };
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    // Flush queued events
    for (const event of this.eventQueue) {
      listener(event);
    }
    this.eventQueue = [];
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    await this.agentSession.abort();
  }
}

export class PiMonoAdapter implements ProviderAdapter {
  readonly name = "pi";
  readonly traits = { hasMcp: true, hasLocalEnvironment: true };
  private lastCwd = ".";

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    this.lastCwd = config.cwd;

    console.log(
      `\x1b[2m[${config.role}]\x1b[0m \x1b[35m▸\x1b[0m Spawning pi-mono for task ${config.taskId.slice(0, 8)}`,
    );

    // 1. Set up AGENTS.md symlink
    const createdSymlink = createAgentsMdSymlink(config.cwd);

    // 2. Discover MCP tools from swarm endpoint
    let customTools: ToolDefinition[] = [];
    if (config.apiUrl && config.apiKey) {
      try {
        const mcpClient = new McpHttpClient(
          config.apiUrl,
          config.apiKey,
          config.agentId,
          config.taskId,
        );
        await mcpClient.initialize();
        const tools = await mcpClient.listTools();
        customTools = mcpToolsToDefinitions(mcpClient, tools);
        console.log(
          `\x1b[2m[${config.role}]\x1b[0m Discovered ${tools.length} MCP tools from swarm`,
        );
      } catch (err) {
        console.warn(`\x1b[33m[${config.role}] Failed to discover MCP tools: ${err}\x1b[0m`);
      }

      // 2b. Discover tools from installed MCP servers (HTTP/SSE transport only)
      try {
        const mcpServersRes = await fetch(
          `${config.apiUrl}/api/agents/${config.agentId}/mcp-servers?resolveSecrets=true`,
          {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "X-Agent-ID": config.agentId,
            },
          },
        );
        if (mcpServersRes.ok) {
          const mcpServersData = (await mcpServersRes.json()) as {
            servers: Array<{
              name: string;
              transport: string;
              url?: string;
              headers?: string;
              isActive: boolean;
              isEnabled: boolean;
              resolvedHeaders?: Record<string, string>;
            }>;
          };
          const httpServers = mcpServersData.servers.filter(
            (s) =>
              s.isActive &&
              s.isEnabled &&
              (s.transport === "http" || s.transport === "sse") &&
              s.url,
          );

          for (const srv of httpServers) {
            try {
              const srvClient = new McpHttpClient(srv.url!, "", "");
              srvClient.useRawUrl = true;
              // Build custom headers from static headers + resolved secret headers
              let parsedHeaders: Record<string, string> = {};
              try {
                parsedHeaders = srv.headers ? JSON.parse(srv.headers) : {};
              } catch {
                // invalid JSON
              }
              srvClient.customHeaders = {
                ...parsedHeaders,
                ...(srv.resolvedHeaders || {}),
              };
              await srvClient.initialize();
              const srvTools = await srvClient.listTools();
              // Prefix tool names with mcp__<server-name>__ to avoid conflicts
              const prefixed = mcpToolsToDefinitions(srvClient, srvTools).map((t) => ({
                ...t,
                name: `mcp__${srv.name}__${t.name}`,
              }));
              customTools.push(...prefixed);
              console.log(
                `\x1b[2m[${config.role}]\x1b[0m Discovered ${srvTools.length} tools from MCP server "${srv.name}"`,
              );
            } catch (srvErr) {
              console.warn(
                `\x1b[33m[${config.role}] Failed to discover tools from MCP server "${srv.name}": ${srvErr}\x1b[0m`,
              );
            }
          }
        }
      } catch {
        // Non-fatal — installed MCP server tool discovery is optional
      }
    }

    // 3. Resolve model
    const model = resolveModel(config.model);

    // 4. Create swarm hooks extension
    const swarmExtension = createSwarmHooksExtension({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      agentId: config.agentId,
      taskId: config.taskId,
      isLead: config.role === "lead",
    });

    // 5. Create resource loader with system prompt + extension
    const resourceLoader = new DefaultResourceLoader({
      appendSystemPrompt: config.systemPrompt ? [config.systemPrompt] : undefined,
      extensionFactories: [swarmExtension],
    });

    // 6. Build session options
    const sessionOptions: CreateAgentSessionOptions = {
      cwd: config.cwd,
      model,
      customTools,
      resourceLoader,
    };

    // 7. Create the session
    const { session } = await createAgentSession(sessionOptions);

    return new PiMonoSession(session, config, createdSymlink);
  }

  async canResume(sessionId: string): Promise<boolean> {
    try {
      const sessionManager = SessionManager.create(this.lastCwd);
      // SessionManager stores sessions as files — check if the session exists
      const sessions = await (
        sessionManager as unknown as { list(): Promise<Array<{ id: string }>> }
      ).list?.();
      return sessions?.some((s) => s.id === sessionId) ?? false;
    } catch {
      return false;
    }
  }

  formatCommand(commandName: string): string {
    return `/skill:${commandName}`;
  }
}
