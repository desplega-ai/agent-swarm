import { getLeadAgent } from "../be/db";
import { listEnabledHandlersForEdge } from "../be/edge-handlers-db";
import { createEvent } from "../be/events";
import { insertRoutingTrace } from "../be/routing-trace-db";
import { runGlobalScriptByName } from "../be/scripts/run-global";
import type { EdgeHandler, EdgeHandlerEdge } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "../workflows/event-bus";
import { matchesFilter } from "../workflows/wait-filter";
import {
  isDecisive,
  type RoutingCtx,
  type RoutingDecision,
  type RoutingDecisionTrace,
  type RoutingResult,
  RoutingResultSchema,
} from "./types";

/**
 * Server-side aggregate budget for a `prompt.compose` run. Must stay BELOW the
 * worker's `PROMPT_COMPOSE_REQUEST_TIMEOUT_MS` (src/commands/runner.ts) so the
 * server always answers before the client gives up — keep the two in sync.
 */
export const PROMPT_COMPOSE_TOTAL_BUDGET_MS = 15_000;

export type RoutingScriptRunner = (input: {
  scriptName: string;
  args: unknown;
  agentId: string;
  timeoutMs?: number;
  readOnly?: boolean;
}) => Promise<{ result: unknown; stdout: string }>;

function mergeMutations(
  current: RoutingDecision["mutations"],
  incoming: RoutingResult["mutate"],
): RoutingDecision["mutations"] {
  if (!incoming) return current;
  const merged = { ...current, ...incoming };
  if (incoming.tags) {
    merged.tags = [...new Set([...(current.tags ?? []), ...incoming.tags])];
  }
  return merged;
}

async function matchesHandler(handler: EdgeHandler, ctx: RoutingCtx): Promise<boolean> {
  const matcher = handler.matcher;
  if (!matcher) return true;
  if (matcher.via !== undefined && matcher.via !== ctx.via) return false;
  if (matcher.source !== undefined && matcher.source !== ctx.task.source) return false;
  if (matcher.slackChannelId !== undefined && matcher.slackChannelId !== ctx.task.slackChannelId) {
    return false;
  }
  if (matcher.vcsRepo !== undefined && matcher.vcsRepo !== ctx.task.vcsRepo) return false;
  if (matcher.agentId !== undefined && matcher.agentId !== ctx.proposedAgentId) return false;
  if (matcher.taskType !== undefined && matcher.taskType !== ctx.task.taskType) return false;
  return matchesFilter(ctx, matcher.filter);
}

function orderedHandlers(handlers: EdgeHandler[]): EdgeHandler[] {
  return [...handlers].sort((a, b) => {
    const flavorOrder = (a.flavor === "guard" ? 0 : 1) - (b.flavor === "guard" ? 0 : 1);
    if (flavorOrder !== 0) return flavorOrder;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
}

function emitRoutingEvent(
  event: "routing.matched" | "routing.applied" | "routing.blocked" | "routing.handler_failed",
  ctx: RoutingCtx,
  routingRunId: string,
  data: Record<string, unknown>,
  status: "ok" | "error" = "ok",
): void {
  const payload = {
    routingRunId,
    taskId: ctx.task.id,
    via: ctx.via,
    ...data,
  };
  try {
    createEvent({
      category: "task",
      event,
      status,
      source: "hook",
      agentId: ctx.proposedAgentId,
      taskId: ctx.task.id,
      data: payload,
    });
  } catch {
    // Telemetry must not alter the routing outcome.
  }
  try {
    // Named bus listeners are unguarded (only onAny taps are wrapped) — a
    // throwing subscriber must not reject the routing/creation path.
    workflowEventBus.emit(event, payload);
  } catch (err) {
    // Message only, scrubbed: a raw error object dumps a stack that can carry
    // payload material into container logs.
    console.error(`[routing] event emit failed for '${event}': ${failureMessage(err)}`);
  }
}

/** Trace persistence is observability — it must never fail the routed action. */
function safeInsertTrace(...args: Parameters<typeof insertRoutingTrace>): void {
  try {
    insertRoutingTrace(...args);
  } catch (err) {
    console.error(`[routing] trace insert failed: ${failureMessage(err)}`);
  }
}

function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return scrubSecrets(raw);
}

/**
 * Cheap lifecycle-via preflight for hot assignment paths. A handler with no
 * `matcher.via` is reachable from every via; a handler scoped to another via
 * is not. Remaining matcher fields require a full RoutingCtx and are evaluated
 * by `runBeforeAssign`.
 */
export function hasHandlersForVia(edge: EdgeHandlerEdge, via: RoutingCtx["via"]): boolean {
  return listEnabledHandlersForEdge(edge).some(
    (handler) => handler.matcher?.via === undefined || handler.matcher.via === via,
  );
}

export function createRoutingEngine(
  scriptRunner: RoutingScriptRunner = runGlobalScriptByName,
  edge: EdgeHandlerEdge = "task.before_assign",
) {
  return async function runBeforeAssignWithRunner(
    ctx: RoutingCtx,
    opts: { dryRun?: boolean } = {},
  ): Promise<RoutingDecision> {
    const routingRunId = crypto.randomUUID();
    const decision: RoutingDecision = {
      suggestions: [],
      mutations: {},
      promptDirectives: [],
      notes: [],
      routingRunId,
      trace: [],
    };

    const enabled = listEnabledHandlersForEdge(edge);
    const matched: EdgeHandler[] = [];
    for (const handler of enabled) {
      if (await matchesHandler(handler, ctx)) matched.push(handler);
    }
    if (matched.length === 0) return decision;

    const ordered = orderedHandlers(matched);
    if (!opts.dryRun) {
      emitRoutingEvent("routing.matched", ctx, routingRunId, {
        handlerNames: ordered.map((handler) => handler.name),
      });
    }

    // Aggregate wall-clock budget for prompt composition. Each handler gets its
    // own `timeoutMs`, but N handlers run sequentially, so without this the
    // total is unbounded — and the worker's prompt-compose request has a fixed
    // client deadline (PROMPT_COMPOSE_REQUEST_TIMEOUT_MS in runner.ts). Once
    // the server exceeds it the worker has already fallen back to the task's
    // persisted directives, and every further handler burns a subprocess to
    // produce guidance nobody will ever see.
    const composeDeadline =
      edge === "prompt.compose" ? Date.now() + PROMPT_COMPOSE_TOTAL_BUDGET_MS : null;

    for (const handler of ordered) {
      if (composeDeadline !== null && Date.now() >= composeDeadline) {
        console.warn(
          `[routing] prompt.compose budget (${PROMPT_COMPOSE_TOTAL_BUDGET_MS}ms) exhausted — skipping remaining handler(s)`,
        );
        break;
      }
      const startedAt = Date.now();
      let parsedResult: RoutingResult | undefined;
      let error: string | undefined;
      try {
        const output = await scriptRunner({
          scriptName: handler.scriptName,
          args: ctx,
          // Seeded handlers have no creator; run their scripts as the lead so
          // SDK bridge calls with registered-agent checks (e.g. classify)
          // resolve to a real agent instead of 404ing and failing open.
          agentId: handler.createdByAgentId ?? getLeadAgent()?.id ?? "routing",
          // Clamped to what's LEFT of the aggregate budget, not just checked
          // before starting: a handler begun just under the deadline would
          // otherwise run its full configured timeout (up to 300s) — past both
          // the server budget and the worker's request deadline, so its
          // guidance is discarded anyway and the subprocess is pure waste.
          timeoutMs:
            composeDeadline === null
              ? (handler.timeoutMs ?? 5000)
              : Math.max(1, Math.min(handler.timeoutMs ?? 5000, composeDeadline - Date.now())),
          // Suppressing bus events is not enough to make a dry run
          // side-effect-free: the handler still executes with real
          // credentials, so it could create tasks, mutate config, or message
          // people. Run it against a read-only SDK surface instead.
          readOnly: opts.dryRun === true,
        });
        parsedResult = RoutingResultSchema.parse(output.result);
      } catch (caught) {
        error = failureMessage(caught);
      }
      const durationMs = Date.now() - startedAt;

      if (error) {
        // Prompt composition is advisory. Even guard failures must fail open
        // so a task can always receive its prompt.
        const guardFailure = edge === "task.before_assign" && handler.flavor === "guard";
        const trace: RoutingDecisionTrace = {
          handlerId: handler.id,
          handlerName: handler.name,
          flavor: handler.flavor,
          mode: handler.mode,
          decisive: guardFailure,
          error,
          durationMs,
        };
        decision.trace.push(trace);
        safeInsertTrace({
          routingRunId,
          taskId: ctx.task.id,
          edge,
          via: ctx.via,
          handlerId: handler.id,
          handlerName: handler.name,
          flavor: handler.flavor,
          mode: handler.mode,
          matched: true,
          decisive: guardFailure,
          dryRun: opts.dryRun ?? false,
          error,
          durationMs,
        });
        // Dry-run must emit nothing on the bus: the subscriptions tap turns
        // every emit into real deliveries, so an author probing a broken
        // handler would trigger live subscription targets.
        if (!opts.dryRun) {
          emitRoutingEvent(
            "routing.handler_failed",
            ctx,
            routingRunId,
            { handlerId: handler.id, handlerName: handler.name },
            "error",
          );
        }
        if (guardFailure) {
          decision.final = { block: { reason: `guard ${handler.name} failed: ${error}` } };
          if (!opts.dryRun) {
            emitRoutingEvent("routing.applied", ctx, routingRunId, {
              handlerId: handler.id,
              handlerName: handler.name,
            });
            emitRoutingEvent("routing.blocked", ctx, routingRunId, {
              handlerId: handler.id,
              handlerName: handler.name,
            });
          }
          break;
        }
        continue;
      }

      const result = parsedResult as RoutingResult;
      decision.mutations = mergeMutations(decision.mutations, result.mutate);
      if (result.promptDirectives) decision.promptDirectives.push(...result.promptDirectives);
      if (result.note) decision.notes.push(result.note);

      // prompt.compose may add guidance and notes only; assignment/block
      // results are deliberately ignored at this edge.
      const decisiveResult = edge === "task.before_assign" && isDecisive(result);
      const hardDecisive = decisiveResult && handler.mode === "hard";
      /**
       * `unassign` is the one decisive action a SOFT handler may apply.
       *
       * Every other decisive result takes routing authority away from the Lead
       * — which is exactly what `hard` is the opt-in for. `unassign` does the
       * opposite: it releases an automatic pin (send-task defaults a child to
       * its parent's worker before routing ever runs) and hands the decision
       * BACK to the default router. A soft handler saying "don't auto-pin
       * this" is therefore compatible with "the Lead stays the default
       * router", and without it a soft policy physically cannot decline the
       * inherited pin — it could only emit advice addressed to the very worker
       * it wanted to route away from.
       */
      const softUnassign = decisiveResult && handler.mode === "soft" && result.unassign === true;
      const suggestion =
        decisiveResult && handler.mode === "soft"
          ? (result.assignTo ??
            (result.block
              ? `block:${result.block.reason}`
              : result.unassign
                ? "unassign"
                : undefined))
          : undefined;
      if (decisiveResult && handler.mode === "soft") {
        decision.suggestions.push({
          handlerName: handler.name,
          assignTo: result.assignTo,
          unassign: result.unassign,
          block: result.block,
        });
      }

      const trace: RoutingDecisionTrace = {
        handlerId: handler.id,
        handlerName: handler.name,
        flavor: handler.flavor,
        mode: handler.mode,
        result,
        decisive: hardDecisive || softUnassign,
        suggestion,
        durationMs,
      };
      decision.trace.push(trace);
      safeInsertTrace({
        routingRunId,
        taskId: ctx.task.id,
        edge,
        via: ctx.via,
        handlerId: handler.id,
        handlerName: handler.name,
        flavor: handler.flavor,
        mode: handler.mode,
        matched: true,
        result,
        decisive: hardDecisive || softUnassign,
        suggestion,
        dryRun: opts.dryRun ?? false,
        durationMs,
      });

      if (softUnassign && !hardDecisive) {
        // Release the pin, but do NOT short-circuit: a soft handler holds no
        // authority over what happens next, so later handlers still run and a
        // subsequent hard decision overwrites this. Only the pin release is
        // taken — the handler's own assignTo/block stay advisory suggestions.
        decision.final = { unassign: true };
        if (!opts.dryRun) {
          emitRoutingEvent("routing.applied", ctx, routingRunId, {
            handlerId: handler.id,
            handlerName: handler.name,
          });
        }
        continue;
      }

      if (hardDecisive) {
        decision.final = result;
        if (!opts.dryRun) {
          emitRoutingEvent("routing.applied", ctx, routingRunId, {
            handlerId: handler.id,
            handlerName: handler.name,
          });
          if (result.block) {
            emitRoutingEvent("routing.blocked", ctx, routingRunId, {
              handlerId: handler.id,
              handlerName: handler.name,
            });
          }
        }
        break;
      }
    }

    return decision;
  };
}

export const runBeforeAssign = createRoutingEngine();
export const runPromptCompose = createRoutingEngine(runGlobalScriptByName, "prompt.compose");
