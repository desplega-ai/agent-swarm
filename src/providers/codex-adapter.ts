/**
 * Codex provider adapter (Phase 1 skeleton).
 *
 * Wraps the `@openai/codex-sdk` (which drives the `codex app-server` JSON-RPC
 * protocol via a child process). Phase 1 wires the factory + skeleton classes
 * so the codebase typechecks and a `HARNESS_PROVIDER=codex` worker can
 * instantiate the adapter. The actual event-stream loop, cost data, abort
 * controller, log file writes, and MCP/skill plumbing land in Phases 2-5.
 *
 * Type discipline: every Codex-related type below is imported directly from
 * `@openai/codex-sdk`. We do NOT hand-roll parallel interfaces for `Thread`,
 * `Turn`, events, or items — the SDK already exports them as a tagged union.
 */

import { Codex, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

/**
 * Running session backed by a Codex `Thread`. Phase 1 keeps this as a stub —
 * `onEvent`, `waitForCompletion`, and `abort` will be implemented in Phase 2
 * once we wire `thread.runStreamed()` into the normalized `ProviderEvent`
 * stream and hook up the AbortController.
 */
class CodexSession implements ProviderSession {
  private readonly thread: Thread;
  private readonly config: ProviderSessionConfig;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: populated in Phase 2
  private readonly listeners: Array<(event: ProviderEvent) => void> = [];

  constructor(thread: Thread, config: ProviderSessionConfig) {
    this.thread = thread;
    this.config = config;
  }

  /**
   * Codex assigns a thread id only after the first turn starts. Until Phase 2
   * runs the stream, this returns whatever the SDK reports (which is `null`
   * before any turn — we surface that as `undefined` to match the contract).
   */
  get sessionId(): string | undefined {
    return this.thread.id ?? undefined;
  }

  onEvent(_listener: (event: ProviderEvent) => void): void {
    // Phase 2: queue/flush listeners against the streamed thread events.
    throw new Error("CodexSession.onEvent not implemented (Phase 2)");
  }

  async waitForCompletion(): Promise<ProviderResult> {
    // Phase 2: drive `thread.runStreamed(this.config.prompt)` to completion
    // and resolve a normalized ProviderResult with CostData.
    void this.config;
    throw new Error("CodexSession.waitForCompletion not implemented (Phase 2)");
  }

  async abort(): Promise<void> {
    // Phase 2: signal the per-turn AbortController so the SDK unwinds the
    // JSON-RPC session.
    throw new Error("CodexSession.abort not implemented (Phase 2)");
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly name = "codex";

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    // Phase 1: bare instantiation so the factory path works end-to-end.
    // Phases 3 & 4 will populate `config` (mcp_servers + baseline overrides)
    // and resolve slash commands into the prompt before runStreamed().
    const codex = new Codex({
      env: config.env,
    });

    const threadOptions: ThreadOptions = {
      workingDirectory: config.cwd,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    };
    if (config.model) {
      threadOptions.model = config.model;
    }

    const thread = config.resumeSessionId
      ? codex.resumeThread(config.resumeSessionId, threadOptions)
      : codex.startThread(threadOptions);

    return new CodexSession(thread, config);
  }

  async canResume(sessionId: string): Promise<boolean> {
    // Phase 2 will replace this with an actual `resumeThread()` handshake or
    // a `~/.codex/sessions/` lookup. The runner only calls `canResume` when
    // deciding whether to resume an existing task, so a non-empty string is
    // a reasonable optimistic stub for the skeleton.
    return typeof sessionId === "string" && sessionId.length > 0;
  }

  formatCommand(commandName: string): string {
    // Codex has no native slash-command system. Phase 4 adds a skill resolver
    // that inlines the matching SKILL.md content into the turn prompt before
    // it reaches `thread.runStreamed()`. The leading `/<name>` token here is
    // the marker the resolver looks for (mirrors Claude's format).
    return `/${commandName}`;
  }
}
