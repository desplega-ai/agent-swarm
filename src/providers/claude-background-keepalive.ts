/**
 * Keeps a Claude session's heartbeat fresh while it waits on background work.
 *
 * A Claude session that starts a `run_in_background` Bash job (or backgrounds a
 * subagent) can end its turn and sit idle until the job's task_notification
 * wakes it. During that wait it makes no tool calls and streams no output, so
 * neither liveness input (the PostToolUse heartbeat and session-log ingestion)
 * moves `active_sessions.lastHeartbeatAt`, and the stalled-task sweep classifies
 * the live session as stale after `HEARTBEAT_STALL_STALE_HB_MIN`.
 *
 * Claude Code emits `system/background_tasks_changed` with the full set of live
 * background tasks on every membership change (REPLACE semantics). While that
 * set holds at least one non-ambient task, this pings the session heartbeat on
 * an interval. With no background work the timer never runs, so a hung session
 * still goes stale. A background job that never settles is bounded too: the
 * keepalive stops once the session has emitted nothing for
 * `BACKGROUND_KEEPALIVE_MAX_IDLE_MS`.
 */

/** Ping interval; well inside the 15-minute stale-session threshold. */
export const BACKGROUND_KEEPALIVE_INTERVAL_MS = 60_000;
/** Longest silent wait on background work that the keepalive will cover. */
export const BACKGROUND_KEEPALIVE_MAX_IDLE_MS = 2 * 60 * 60_000;

type BackgroundTaskEntry = { task_id?: unknown; ambient?: unknown };

export interface ClaudeBackgroundKeepaliveOptions {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  taskId: string;
  intervalMs?: number;
  maxIdleMs?: number;
}

export class ClaudeBackgroundKeepalive {
  private liveTaskIds: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastMessageAt = Date.now();
  private stopped = false;
  private readonly intervalMs: number;
  private readonly maxIdleMs: number;

  constructor(private readonly options: ClaudeBackgroundKeepaliveOptions) {
    this.intervalMs = options.intervalMs ?? BACKGROUND_KEEPALIVE_INTERVAL_MS;
    this.maxIdleMs = options.maxIdleMs ?? BACKGROUND_KEEPALIVE_MAX_IDLE_MS;
  }

  /** Feed every protocol message the Claude process emits. */
  observe(message: { type?: string; subtype?: string; tasks?: unknown }): void {
    if (this.stopped) return;
    this.lastMessageAt = Date.now();
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      const tasks = Array.isArray(message.tasks) ? (message.tasks as BackgroundTaskEntry[]) : [];
      // Ambient tasks (live-update watchers, skip_transcript tasks) are not
      // activity; Claude Code asks hosts to leave them out of activity signals.
      this.liveTaskIds = tasks
        .filter((task) => task && task.ambient !== true && typeof task.task_id === "string")
        .map((task) => task.task_id as string);
    }
    // Any message restarts a keepalive the idle cap stopped, while work is live.
    if (this.liveTaskIds.length > 0) this.start();
    else this.clearTimer();
  }

  /** Stop pinging for good; call when the session ends. */
  stop(): void {
    this.stopped = true;
    this.liveTaskIds = [];
    this.clearTimer();
  }

  private start(): void {
    if (this.timer !== undefined) return;
    if (!this.options.apiUrl || !this.options.taskId) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  private tick(): void {
    if (Date.now() - this.lastMessageAt > this.maxIdleMs) {
      this.clearTimer();
      return;
    }
    const { apiUrl, apiKey, agentId, taskId } = this.options;
    void fetch(`${apiUrl}/api/active-sessions/heartbeat/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
      },
    }).catch(() => {});
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
