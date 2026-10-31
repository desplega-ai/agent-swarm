// A simulated agent: registers over the API, polls /api/poll like a real worker and
// settles each task it is handed, without a harness process or a model. Scenarios use
// it to drive flows that need "someone" to pick work up: workflow agent-task nodes,
// foreach bodies, sub-workflows, send-task from a lead, offer mode, follow-ups.
//
// It is intentionally dumb. A scenario that needs a specific outcome passes `onTask`
// and decides there; the default completes every task with a marker output.
import type { ApiClient } from "./http";
import { asRecord, expect, expectStatus, pollUntil } from "./http";

export type SimulatedTrigger = {
  type: string;
  taskId?: string;
  task?: Record<string, unknown>;
  [key: string]: unknown;
};

export type TaskOutcome =
  | { status: "completed"; output: string; structuredOutput?: unknown }
  | { status: "failed"; output: string; failureReason?: string }
  | { status: "ignore" };

export type SimulatedAgentOptions = {
  /** Reuse an existing agent id instead of registering a new one. */
  agentId?: string;
  name?: string;
  role?: "worker" | "lead";
  /** Decide a task's outcome. Default: complete with `done <taskId>`. */
  onTask?: (
    trigger: SimulatedTrigger & { taskId: string; task: Record<string, unknown> },
  ) => Promise<TaskOutcome> | TaskOutcome;
  /** Any trigger that is not a task (unread_mentions, channel_activity, ...). */
  onTrigger?: (trigger: SimulatedTrigger) => Promise<void> | void;
  intervalMs?: number;
  /** Store a progress line before finishing. Exercises the progress path on every task. */
  progress?: boolean;
};

export type SimulatedAgent = {
  agentId: string;
  /** Every task trigger the agent received, in order. */
  handled: Array<{ taskId: string; type: string; outcome: TaskOutcome; at: number }>;
  /** Every non-task trigger, in order. */
  triggers: SimulatedTrigger[];
  /** Resolve once `count` tasks were settled, or throw after `timeoutMs`. */
  waitForTasks(count: number, timeoutMs?: number): Promise<void>;
  /** Resolve once a task with this id was settled. */
  waitForTask(taskId: string, timeoutMs?: number): Promise<TaskOutcome>;
  /** Run one poll + handle step now. Returns the trigger, or null when idle. */
  pollOnce(): Promise<SimulatedTrigger | null>;
  stop(): Promise<void>;
};

export type AgentSimContext = { api: ApiClient; nonce: string };

async function register(ctx: AgentSimContext, name: string, role: "worker" | "lead") {
  const response = await ctx.api("POST", "/api/agents", {
    body: role === "lead" ? { name, isLead: true } : { name, role: "worker", status: "online" },
  });
  expectStatus(response, [201], `register simulated ${role} ${name}`);
  const id = asRecord(response.json).id;
  expect(typeof id === "string", `Simulated ${role} ${name} has no id`);
  return id;
}

export async function startSimulatedAgent(
  ctx: AgentSimContext,
  options: SimulatedAgentOptions = {},
): Promise<SimulatedAgent> {
  const role = options.role ?? "worker";
  const agentId =
    options.agentId ?? (await register(ctx, options.name ?? `e2e-sim-${role}-${ctx.nonce}`, role));
  const intervalMs = options.intervalMs ?? 250;
  const handled: SimulatedAgent["handled"] = [];
  const triggers: SimulatedTrigger[] = [];
  let running = true;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function settle(trigger: SimulatedTrigger & { taskId: string }): Promise<void> {
    const task = asRecord(trigger.task ?? {});
    const outcome = options.onTask
      ? await options.onTask({ ...trigger, task })
      : { status: "completed" as const, output: `done ${trigger.taskId}` };
    if (outcome.status !== "ignore") {
      if (options.progress) {
        const progress = await ctx.api("POST", `/api/tasks/${trigger.taskId}/progress`, {
          agentId,
          body: { progress: `sim progress ${trigger.taskId}` },
        });
        expectStatus(progress, [200], `simulated agent progress on ${trigger.taskId}`);
      }
      const finished = await ctx.api("POST", `/api/tasks/${trigger.taskId}/finish`, {
        agentId,
        body: {
          status: outcome.status,
          output: outcome.output,
          ...("structuredOutput" in outcome && outcome.structuredOutput !== undefined
            ? { structuredOutput: outcome.structuredOutput }
            : {}),
          ...("failureReason" in outcome && outcome.failureReason !== undefined
            ? { failureReason: outcome.failureReason }
            : {}),
        },
      });
      expectStatus(finished, [200], `simulated agent finish ${trigger.taskId}`);
    }
    handled.push({ taskId: trigger.taskId, type: trigger.type, outcome, at: Date.now() });
  }

  async function pollOnce(): Promise<SimulatedTrigger | null> {
    const response = await ctx.api("GET", "/api/poll", { agentId });
    expectStatus(response, [200], `simulated agent ${agentId} poll`);
    const trigger = asRecord(response.json).trigger;
    if (!trigger) return null;
    const record = asRecord(trigger) as SimulatedTrigger;
    if (
      (record.type === "task_assigned" || record.type === "task_offered") &&
      typeof record.taskId === "string"
    ) {
      await settle(record as SimulatedTrigger & { taskId: string });
    } else {
      triggers.push(record);
      await options.onTrigger?.(record);
    }
    return record;
  }

  const loop = (async () => {
    while (running) {
      try {
        inFlight = pollOnce();
        await inFlight;
      } catch (error) {
        // Surface in the scenario through waitForTask; keep polling so a transient
        // error (API restart) does not strand the run.
        console.error(
          `simulated agent ${agentId}: ${error instanceof Error ? error.message : error}`,
        );
      }
      await Bun.sleep(intervalMs);
    }
  })();

  return {
    agentId,
    handled,
    triggers,
    pollOnce,
    async waitForTasks(count, timeoutMs = 30_000) {
      const ok = await pollUntil(() => handled.length >= count, timeoutMs, 100);
      expect(
        ok,
        `simulated agent ${agentId} settled ${handled.length}/${count} tasks in ${timeoutMs}ms`,
      );
    },
    async waitForTask(taskId, timeoutMs = 30_000) {
      let found: TaskOutcome | undefined;
      const ok = await pollUntil(
        () => {
          found = handled.find((entry) => entry.taskId === taskId)?.outcome;
          return found !== undefined;
        },
        timeoutMs,
        100,
      );
      expect(ok && found, `simulated agent ${agentId} never received task ${taskId}`);
      return found;
    },
    async stop() {
      running = false;
      await inFlight.catch(() => {});
      await loop;
    },
  };
}
