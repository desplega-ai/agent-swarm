/**
 * Extension-system spike (Layer 1): event subscriptions.
 *
 * Covers:
 * - matcher: glob semantics for dot-separated event names + pattern validation.
 * - capture: bus emit → swarm_events row + subscription_deliveries rows for
 *   matching enabled subscriptions only (pattern + wait-filter language).
 * - dispatch: processPendingDeliveries() runs a real catalog script via the
 *   scripts-runtime and a workflow via a stub executor registry; failures
 *   retry up to MAX_ATTEMPTS then land on status='failed'.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { closeDb, createAgent, createWorkflow, getWorkflowRun, initDb } from "../be/db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import {
  createSubscription,
  getDeliveryById,
  getSubscriptionById,
  listDeliveriesForSubscription,
  updateSubscription,
} from "../be/subscriptions-db";
import {
  initSubscriptions,
  processPendingDeliveries,
  setSubscriptionExecutorRegistry,
  stopSubscriptionDispatcher,
} from "../subscriptions/dispatcher";
import { matchesEventPattern, validateEventPattern } from "../subscriptions/matcher";
import { InProcessEventBus, workflowEventBus } from "../workflows/event-bus";
import { BaseExecutor, type ExecutorResult } from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-subscriptions.sqlite";
const API_KEY = "test-subscriptions-key-1234567890";

const noOpEmbeddingProvider = {
  name: "test/noop-subscriptions-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

class EchoExecutor extends BaseExecutor<typeof EchoExecutor.schema, typeof EchoExecutor.outSchema> {
  static readonly schema = z.object({ value: z.string().default("ok") });
  static readonly outSchema = z.object({ value: z.string() });

  readonly type = "echo";
  readonly mode = "instant" as const;
  readonly configSchema = EchoExecutor.schema;
  readonly outputSchema = EchoExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof EchoExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof EchoExecutor.outSchema>>> {
    return { status: "success", output: { value: config.value } };
  }
}

let savedEnv: NodeJS.ProcessEnv;
let agentId: string;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function saveGlobalScript(name: string, source: string) {
  return upsertScriptByName({
    name,
    scope: "global",
    source,
    description: `${name} test script`,
    intent: "subscriptions test fixture",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    agentId,
    typeChecked: true,
  });
}

/** Emit on the bus and give the async capture tap a beat to persist. */
async function emitAndSettle(name: string, data: unknown): Promise<void> {
  workflowEventBus.emit(name, data);
  await Bun.sleep(100);
}

/** Drain the pending queue so cross-test claims can't interleave. */
async function drain(): Promise<void> {
  while ((await processPendingDeliveries(10)) > 0) {
    // keep claiming until empty
  }
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);

  const agent = createAgent({ name: "subscriptions-test-agent", isLead: true, status: "idle" });
  agentId = agent.id;

  const eventBus = new InProcessEventBus();
  const db = await import("../be/db");
  const registry = new ExecutorRegistry();
  registry.register(
    new EchoExecutor({
      db,
      eventBus,
      interpolate: (template, ctx) => interpolate(template, ctx).result,
    }),
  );
  setSubscriptionExecutorRegistry(registry);
  initSubscriptions();
});

afterAll(async () => {
  stopSubscriptionDispatcher();
  setSubscriptionExecutorRegistry(null);
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  await removeDbFiles();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("event pattern matcher", () => {
  test("exact, single-segment, and multi-segment globs", () => {
    expect(matchesEventPattern("task.completed", "task.completed")).toBe(true);
    expect(matchesEventPattern("task.completed", "task.failed")).toBe(false);
    expect(matchesEventPattern("task.*", "task.completed")).toBe(true);
    expect(matchesEventPattern("task.*", "task.a.b")).toBe(false);
    expect(matchesEventPattern("github.**", "github.pull_request.opened")).toBe(true);
    expect(matchesEventPattern("github.**", "github")).toBe(false);
    expect(matchesEventPattern("*", "ping")).toBe(true);
    expect(matchesEventPattern("*", "task.completed")).toBe(false);
    expect(matchesEventPattern("**", "task.completed")).toBe(true);
  });

  test("pattern validation", () => {
    expect(validateEventPattern("task.*")).toBeNull();
    expect(validateEventPattern("github.**")).toBeNull();
    expect(validateEventPattern("")).not.toBeNull();
    expect(validateEventPattern("a..b")).not.toBeNull();
    expect(validateEventPattern("a.**.b")).not.toBeNull();
    expect(validateEventPattern("task.foo*")).not.toBeNull();
  });
});

describe("updateSubscription", () => {
  test("patches fields, clears filter with null, pauses via enabled", async () => {
    await saveGlobalScript(
      "sub-patch-fixture",
      `export default async function run() { return { ok: true }; }`,
    );
    const sub = createSubscription({
      name: `patch-${crypto.randomUUID()}`,
      eventPattern: "patchtest.*",
      filter: { a: 1 },
      targetType: "script",
      scriptName: "sub-patch-fixture",
      createdByAgentId: agentId,
    });

    const updated = updateSubscription(sub.id, {
      eventPattern: "patchtest.**",
      filter: null,
      enabled: false,
      description: "paused",
    });
    expect(updated?.eventPattern).toBe("patchtest.**");
    expect(updated?.filter).toBeUndefined();
    expect(updated?.enabled).toBe(false);
    expect(updated?.description).toBe("paused");

    // no-op patch returns current row unchanged
    expect(updateSubscription(sub.id, {})?.eventPattern).toBe("patchtest.**");
    expect(getSubscriptionById(sub.id)?.enabled).toBe(false);
  });
});

describe("capture: bus emit → deliveries", () => {
  test("pattern match enqueues a delivery; the filter resolves it as a no-op at dispatch", async () => {
    await saveGlobalScript(
      "sub-noop",
      `export default async function run(args: Record<string, unknown>) { return { ok: true }; }`,
    );
    const matching = createSubscription({
      name: `capture-match-${crypto.randomUUID()}`,
      eventPattern: "spiketest.*",
      targetType: "script",
      scriptName: "sub-noop",
      createdByAgentId: agentId,
    });
    const filtered = createSubscription({
      name: `capture-filtered-${crypto.randomUUID()}`,
      eventPattern: "spiketest.*",
      filter: { kind: "never-matches" },
      targetType: "script",
      scriptName: "sub-noop",
      createdByAgentId: agentId,
    });
    const disabled = createSubscription({
      name: `capture-disabled-${crypto.randomUUID()}`,
      eventPattern: "spiketest.*",
      targetType: "script",
      scriptName: "sub-noop",
      enabled: false,
      createdByAgentId: agentId,
    });

    await emitAndSettle("spiketest.created", { kind: "demo", taskId: "t-1" });

    expect(listDeliveriesForSubscription(matching.id)).toHaveLength(1);
    expect(listDeliveriesForSubscription(matching.id)[0]?.status).toBe("pending");
    // Capture is synchronous so the emit cannot be lost to a crash, which
    // means the (async, timeout-raced) filter cannot run there. A pattern
    // match is therefore enqueued even when the filter will reject it.
    expect(listDeliveriesForSubscription(filtered.id)).toHaveLength(1);
    expect(listDeliveriesForSubscription(filtered.id)[0]?.status).toBe("pending");
    // Disabled subscriptions are excluded at capture (enabledOnly).
    expect(listDeliveriesForSubscription(disabled.id)).toHaveLength(0);

    await drain();

    // The filter is applied at dispatch: a terminal no-op, never a failure,
    // and the target is not executed.
    const settledFiltered = listDeliveriesForSubscription(filtered.id)[0];
    expect(settledFiltered?.status).toBe("succeeded");
    expect(settledFiltered?.result).toEqual({ filtered: true });
    expect(listDeliveriesForSubscription(matching.id)[0]?.status).toBe("succeeded");
  });

  test("capture is durable before emit() returns", async () => {
    await saveGlobalScript(
      "sub-noop-sync",
      `export default async function run(args: Record<string, unknown>) { return { ok: true }; }`,
    );
    const sub = createSubscription({
      name: `capture-sync-${crypto.randomUUID()}`,
      eventPattern: "spikesync.*",
      filter: { kind: "demo" },
      targetType: "script",
      scriptName: "sub-noop-sync",
      createdByAgentId: agentId,
    });

    // No await, no tick: if the emitting call site crashed right here, the
    // event and its fan-out must already be on disk. A filter is set to prove
    // the async filter path no longer delays the journal write.
    workflowEventBus.emit("spikesync.created", { kind: "demo", taskId: "t-sync" });

    expect(listDeliveriesForSubscription(sub.id)).toHaveLength(1);

    await drain();
  });
});

describe("dispatch: script target", () => {
  test("runs the catalog script with the event as args.event", async () => {
    await saveGlobalScript(
      "sub-echo-event",
      `export default async function run(args: Record<string, unknown>) {
         const event = args.event as { name: string };
         if (!event || event.name !== "spikescript.fired") {
           throw new Error("event not injected: " + JSON.stringify(args));
         }
         return { seen: event.name };
       }`,
    );
    const sub = createSubscription({
      name: `dispatch-script-${crypto.randomUUID()}`,
      eventPattern: "spikescript.fired",
      targetType: "script",
      scriptName: "sub-echo-event",
      createdByAgentId: agentId,
    });

    await emitAndSettle("spikescript.fired", { payload: 42 });
    await drain();

    const deliveries = listDeliveriesForSubscription(sub.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("succeeded");
    expect(deliveries[0]?.result).toMatchObject({ scriptName: "sub-echo-event", exitCode: 0 });
  }, 30_000);

  test("failing script retries then lands on failed", async () => {
    await saveGlobalScript(
      "sub-always-throws",
      `export default async function run() { throw new Error("boom"); }`,
    );
    const sub = createSubscription({
      name: `dispatch-retry-${crypto.randomUUID()}`,
      eventPattern: "spikeretry.fired",
      targetType: "script",
      scriptName: "sub-always-throws",
      createdByAgentId: agentId,
    });

    await emitAndSettle("spikeretry.fired", {});
    const first = listDeliveriesForSubscription(sub.id)[0];
    expect(first?.status).toBe("pending");

    // MAX_ATTEMPTS = 3: attempts 1..2 fail → pending again; attempt 3 → failed.
    await drain();
    const done = getDeliveryById(first!.id);
    expect(done?.status).toBe("failed");
    expect(done?.attempts).toBe(3);
    expect(done?.error).toContain("boom");
  }, 60_000);
});

describe("dispatch: workflow target", () => {
  test("triggers the workflow with { event, subscriptionId } trigger data", async () => {
    const wf = createWorkflow({
      name: `sub-test-wf-${crypto.randomUUID()}`,
      definition: { nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] },
      createdByAgentId: agentId,
    });
    const sub = createSubscription({
      name: `dispatch-workflow-${crypto.randomUUID()}`,
      eventPattern: "spikewf.**",
      targetType: "workflow",
      workflowId: wf.id,
      createdByAgentId: agentId,
    });

    await emitAndSettle("spikewf.thing.happened", { detail: "x" });
    await drain();

    const deliveries = listDeliveriesForSubscription(sub.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("succeeded");
    const runId = (deliveries[0]?.result as { workflowRunId?: string })?.workflowRunId;
    expect(runId).toBeTruthy();
    const run = getWorkflowRun(runId!);
    expect(run).toBeTruthy();
    expect(run?.triggerData).toMatchObject({
      subscriptionId: sub.id,
      event: { name: "spikewf.thing.happened", data: { detail: "x" } },
    });
  }, 30_000);
});
