import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { subscribeWaitToBus } from "../resume";
import { compileStringFilter } from "../wait-filter";
import type { ExecutorResult } from "./base";
import { BaseExecutor } from "./base";

// ─── Config / Output Schemas ────────────────────────────────

/**
 * `wait` node config — discriminated union on `mode`.
 *
 * - `mode: "time"`: pause for `durationMs` (1ms..1y; effective resolution ~5s
 *   from the wait-poller cadence).
 * - `mode: "event"`: pause until a `workflowEventBus` event named `eventName`
 *   arrives whose payload satisfies `filter`. The string-form filter is
 *   capped at 2KB at the Zod boundary as defense-in-depth against pathologically
 *   large filter sources.
 */
const WaitConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("time"),
    durationMs: z
      .number()
      .int()
      .min(1)
      .max(31_536_000_000) // 1 year ceiling
      .describe("Wait duration in milliseconds (effective resolution ~5s)"),
  }),
  z.object({
    mode: z.literal("event"),
    eventName: z.string().min(1),
    filter: z.union([z.record(z.string(), z.unknown()), z.string().max(2048)]).optional(),
    scope: z.enum(["run", "global"]).default("run"),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(31_536_000_000)
      .optional()
      .describe(
        "Timeout in milliseconds (effective resolution ~5s) — when reached, routes via 'timeout' port",
      ),
  }),
]);

const WaitOutputSchema = z.object({
  waitId: z.string().uuid(),
  mode: z.enum(["time", "event"]),
  firedAt: z.string().nullable(),
  payload: z.unknown().optional(),
});

type WaitOutput = z.infer<typeof WaitOutputSchema>;
type WaitConfig = z.infer<typeof WaitConfigSchema>;

// ─── Executor ───────────────────────────────────────────────

export class WaitExecutor extends BaseExecutor<typeof WaitConfigSchema, typeof WaitOutputSchema> {
  readonly type = "wait";
  readonly mode = "async" as const;
  readonly configSchema = WaitConfigSchema;
  readonly outputSchema = WaitOutputSchema;

  protected async execute(
    config: WaitConfig,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<WaitOutput>> {
    const { db } = this.deps;

    // 1. Idempotency check — if a wait_state already exists for this step,
    // either return the resolved port (resolution happened during retry/recovery)
    // or return the async marker to keep waiting.
    const existing = db.getWaitStateByStepId(meta.stepId);
    if (existing) {
      if (existing.status !== "pending") {
        const nextPort = computeNextPort(existing.mode, existing.status);
        return {
          status: "success",
          output: {
            waitId: existing.id,
            mode: existing.mode,
            firedAt: existing.resolvedAt,
            payload: existing.firedPayload ?? undefined,
          },
          nextPort,
        };
      }
      // Still pending — return async marker
      return {
        status: "success",
        async: true,
        waitFor: "wait.fired",
        correlationId: existing.id,
      } as unknown as ExecutorResult<WaitOutput>;
    }

    // 2. Mode-specific creation.
    if (config.mode === "time") {
      const waitId = crypto.randomUUID();
      const wakeUpAt = new Date(Date.now() + config.durationMs).toISOString();
      db.createWaitState({
        id: waitId,
        workflowRunId: meta.runId,
        workflowRunStepId: meta.stepId,
        mode: "time",
        wakeUpAt,
      });

      return {
        status: "success",
        async: true,
        waitFor: "wait.fired",
        correlationId: waitId,
      } as unknown as ExecutorResult<WaitOutput>;
    }

    // Event mode: validate the filter at executor-init time (so a bad workflow
    // surfaces here, not at first event), insert the wait_state row, and
    // subscribe to the bus so signals route to this wait.
    if (typeof config.filter === "string") {
      // Throws on parse error — caught by BaseExecutor.run wrapper and surfaced
      // as a `failed` ExecutorResult.
      compileStringFilter(config.filter);
    }

    const waitId = crypto.randomUUID();
    const expiresAt = config.timeoutMs
      ? new Date(Date.now() + config.timeoutMs).toISOString()
      : null;

    db.createWaitState({
      id: waitId,
      workflowRunId: meta.runId,
      workflowRunStepId: meta.stepId,
      mode: "event",
      eventName: config.eventName,
      eventFilter: config.filter ?? null,
      expiresAt,
      scope: config.scope,
    });

    // Register the bus listener for this event name (idempotent).
    subscribeWaitToBus(waitId, config.eventName);

    return {
      status: "success",
      async: true,
      waitFor: "wait.fired",
      correlationId: waitId,
    } as unknown as ExecutorResult<WaitOutput>;
  }
}

/**
 * Map (mode, status) to the `next` port name.
 *
 * - time + fired       → "default" (single happy port)
 * - event + fired      → "event"
 * - event + timeout    → "timeout"
 *
 * Time mode never produces "timeout" in practice — wait_states for time-mode
 * waits never set `expiresAt` so the poller will never resolve them as
 * timeout. We default to "default" anyway as a safe fallback.
 */
export function computeNextPort(mode: "time" | "event", status: "fired" | "timeout"): string {
  if (mode === "time") return "default";
  return status === "timeout" ? "timeout" : "event";
}
