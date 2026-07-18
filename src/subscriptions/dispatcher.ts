import { getWorkflow } from "@/be/db";
import { runGlobalScriptByName } from "@/be/scripts/run-global";
import {
  claimPendingDeliveries,
  createDelivery,
  finishDelivery,
  getSubscriptionById,
  getSwarmBusEventById,
  listSubscriptions,
  pruneSubscriptionJournal,
  recordSwarmBusEvent,
} from "@/be/subscriptions-db";
import { getExecutorRegistry as getWorkflowExecutorRegistry } from "@/workflows";
import { startWorkflowExecution } from "@/workflows/engine";
import { workflowEventBus } from "@/workflows/event-bus";
import type { ExecutorRegistry } from "@/workflows/executors/registry";
import { matchesFilter } from "@/workflows/wait-filter";
import { matchesEventPattern } from "./matcher";
import type { Subscription, SwarmBusEvent } from "./types";

// SPIKE (extension system, Layer 1): event → subscription dispatch.
//
// Capture side: an `onAny` tap on the workflow event bus persists every event
// to swarm_events and enqueues a subscription_deliveries row per matching
// enabled subscription. Capture is in-process (an event emitted while the API
// is down is lost with its cause anyway); delivery is durable at-least-once —
// pending rows survive restarts and are retried up to MAX_ATTEMPTS.
//
// Execution side: a scheduler-style poller claims pending deliveries and runs
// the target — a global catalog script (same invocation pattern as
// src/scheduler/scheduler.ts executeScheduleScript) or a workflow.

const MAX_ATTEMPTS = 3;
const CLAIM_BATCH_SIZE = 5;
const SCRIPT_TIMEOUT_MS = 60_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastPruneAt = 0;

let tapInstalled = false;
let dispatcherTimer: ReturnType<typeof setInterval> | null = null;
let executorRegistry: ExecutorRegistry | null = null;

/**
 * Prefer an explicitly configured registry (boot passes the workflows
 * singleton; tests pass a stub); fall back to the workflows-module singleton.
 * Mirrors src/scheduler/scheduler.ts resolveExecutorRegistry().
 */
export function setSubscriptionExecutorRegistry(registry: ExecutorRegistry | null): void {
  executorRegistry = registry;
}

function resolveExecutorRegistry(): ExecutorRegistry | null {
  if (executorRegistry) return executorRegistry;
  try {
    return getWorkflowExecutorRegistry();
  } catch {
    return null;
  }
}

async function captureEvent(name: string, data: unknown): Promise<void> {
  const enabled = listSubscriptions({ enabledOnly: true });
  const matching: Subscription[] = [];
  for (const sub of enabled) {
    if (!matchesEventPattern(sub.eventPattern, name)) continue;
    if (sub.filter !== undefined && !(await matchesFilter(data, sub.filter))) continue;
    matching.push(sub);
  }
  if (matching.length === 0) return;

  const event = recordSwarmBusEvent(name, data);
  for (const sub of matching) {
    createDelivery(sub.id, event.id);
  }
}

function onBusEvent(name: string, data: unknown): void {
  captureEvent(name, data).catch((err) => {
    console.error(`[Subscriptions] Failed to capture event '${name}':`, err);
  });
}

export function initSubscriptions(): void {
  if (tapInstalled) return;
  workflowEventBus.onAny(onBusEvent);
  tapInstalled = true;
}

async function executeScriptTarget(sub: Subscription, event: SwarmBusEvent): Promise<unknown> {
  if (!sub.scriptName) {
    throw new Error(`Subscription "${sub.name}" has no scriptName (targetType=script)`);
  }
  await runGlobalScriptByName({
    scriptName: sub.scriptName,
    args: {
      ...(sub.scriptArgs ?? {}),
      event: { id: event.id, name: event.name, data: event.data, emittedAt: event.emittedAt },
    },
    agentId: sub.createdByAgentId ?? "subscription",
    timeoutMs: SCRIPT_TIMEOUT_MS,
  });
  return { scriptName: sub.scriptName, exitCode: 0 };
}

async function executeWorkflowTarget(sub: Subscription, event: SwarmBusEvent): Promise<unknown> {
  if (!sub.workflowId) {
    throw new Error(`Subscription "${sub.name}" has no workflowId (targetType=workflow)`);
  }
  const workflow = getWorkflow(sub.workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${sub.workflowId} not found`);
  }
  if (!workflow.enabled) {
    throw new Error(`Workflow ${sub.workflowId} is disabled`);
  }
  const registry = resolveExecutorRegistry();
  if (!registry) {
    throw new Error("Workflow engine not initialized — cannot dispatch subscription to workflow");
  }
  const runId = await startWorkflowExecution(
    workflow,
    {
      event: { id: event.id, name: event.name, data: event.data, emittedAt: event.emittedAt },
      subscriptionId: sub.id,
      subscriptionName: sub.name,
    },
    registry,
    { triggerType: "subscription" },
  );
  return { workflowRunId: runId };
}

/** Exported for tests: one dispatcher tick. Returns number of processed rows. */
export async function processPendingDeliveries(limit = CLAIM_BATCH_SIZE): Promise<number> {
  if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
    lastPruneAt = Date.now();
    const pruned = pruneSubscriptionJournal();
    if (pruned.deliveries || pruned.events) {
      console.log(
        `[Subscriptions] Pruned ${pruned.deliveries} deliveries, ${pruned.events} events`,
      );
    }
  }
  const claimed = claimPendingDeliveries(limit);
  for (const delivery of claimed) {
    const sub = getSubscriptionById(delivery.subscriptionId);
    const event = getSwarmBusEventById(delivery.eventId);
    if (!sub || !event) {
      finishDelivery(delivery.id, {
        status: "failed",
        error: !sub ? "subscription deleted" : "event row missing",
        retry: false,
      });
      continue;
    }
    if (!sub.enabled) {
      finishDelivery(delivery.id, {
        status: "failed",
        error: "subscription disabled",
        retry: false,
      });
      continue;
    }
    try {
      const result =
        sub.targetType === "script"
          ? await executeScriptTarget(sub, event)
          : await executeWorkflowTarget(sub, event);
      finishDelivery(delivery.id, { status: "succeeded", result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = delivery.attempts < MAX_ATTEMPTS;
      finishDelivery(delivery.id, { status: "failed", error: message, retry });
      console.error(
        `[Subscriptions] Delivery ${delivery.id} (${sub.name} ← ${event.name}) failed` +
          `${retry ? ", will retry" : ""}: ${message}`,
      );
    }
  }
  return claimed.length;
}

export function startSubscriptionDispatcher(intervalMs = 2000): void {
  if (dispatcherTimer) return;
  initSubscriptions();
  let ticking = false;
  dispatcherTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    processPendingDeliveries()
      .catch((err) => console.error("[Subscriptions] Dispatcher tick failed:", err))
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  console.log(`[Subscriptions] Dispatcher started (interval ${intervalMs}ms)`);
}

export function stopSubscriptionDispatcher(): void {
  if (dispatcherTimer) {
    clearInterval(dispatcherTimer);
    dispatcherTimer = null;
  }
  if (tapInstalled) {
    workflowEventBus.offAny(onBusEvent);
    tapInstalled = false;
  }
}
