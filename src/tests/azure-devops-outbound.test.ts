import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resetAzureDevOpsBotIdCache, updateWorkItemFields } from "../azure-devops/api";
import { initAzureDevOps, resetAzureDevOps } from "../azure-devops/auth";
import { initAzureDevOpsOutbound, teardownAzureDevOpsOutbound } from "../azure-devops/outbound";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createWorkflow,
  getDbClient,
  initDb,
  listWorkflowRuns,
} from "../be/db";
import {
  createTrackerSyncIfAbsent,
  deleteTrackerSync,
  getAllTrackerSyncs,
} from "../be/db-queries/tracker";
import { emitTaskStarted } from "../be/task-lifecycle-events";
import { handleWebhooks } from "../http/webhooks";
import { initWorkflows, stopRetryPoller, stopWaitPoller } from "../workflows";
import { workflowEventBus } from "../workflows/event-bus";
import commentedFixture from "./fixtures/azure-boards/workitem.commented.json";
import updatedFixture from "./fixtures/azure-boards/workitem.updated.json";

const TEST_DB_PATH = "./test-azure-devops-outbound.sqlite";
const SECRET = "outbound-secret";
const BOT_ID = "7d40ac7f-6bdb-6baf-a2e2-dc9594e967d4";
const ORG_URL = "https://dev.azure.com/acme-org";
const ENV_KEYS = [
  "AZURE_DEVOPS_WEBHOOK_SECRET",
  "AZURE_DEVOPS_TOKEN",
  "AZURE_DEVOPS_ORG_URL",
  "AZURE_DEVOPS_BOT_ID",
  "AZURE_DEVOPS_ALLOWED_ACTORS",
  "AZURE_DEVOPS_WORKITEM_STATE_STARTED",
  "AZURE_DEVOPS_WORKITEM_STATE_DONE",
] as const;

type Json = Record<string, any>;
const originalFetch = globalThis.fetch;
let nextId = 0;
let patches: { url: string; contentType: string | null; body: Json[] }[] = [];
let patchStatus = 200;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  resetAzureDevOps();
  resetAzureDevOpsBotIdCache();
}

async function linkedTask(workItemId: number | string): Promise<string> {
  const task = await createTaskExtended("linked work", { source: "azure-devops" });
  await createTrackerSyncIfAbsent({
    provider: "azure-devops",
    entityType: "task",
    providerEntityType: "WorkItem",
    swarmId: task.id,
    externalId: `dev.azure.com/acme-org#${workItemId}`,
    lastSyncOrigin: "external",
    syncDirection: "inbound",
  });
  return task.id;
}

/** Let the fire-and-forget handlers run. */
const settle = () => new Promise((r) => setTimeout(r, 25));

async function post(body: Json) {
  const req = {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`hook:${SECRET}`).toString("base64")}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  } as unknown as IncomingMessage;
  const res = { writeHead: () => res, end: () => res } as unknown as ServerResponse;
  await handleWebhooks(req, res, ["api", "azure-devops", "webhook"]);
}

beforeAll(async () => {
  clearEnv();
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
  await createAgent({
    id: "lead-outbound-001",
    name: "OutboundLead",
    status: "idle",
    isLead: true,
  });
});

afterAll(async () => {
  teardownAzureDevOpsOutbound();
  clearEnv();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

beforeEach(async () => {
  process.env.AZURE_DEVOPS_WEBHOOK_SECRET = SECRET;
  process.env.AZURE_DEVOPS_TOKEN = "pat";
  process.env.AZURE_DEVOPS_ORG_URL = ORG_URL;
  initAzureDevOps();
  patches = [];
  patchStatus = 200;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/_apis/connectionData")) {
      return Response.json({
        authenticatedUser: {
          id: BOT_ID,
          properties: { Account: { $value: "swarm-bot@example.com" } },
        },
      });
    }
    if (init?.method === "PATCH") {
      patches.push({
        url: String(input),
        contentType: new Headers(init.headers).get("content-type"),
        body: JSON.parse(String(init.body)),
      });
      return new Response("{}", { status: patchStatus });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;
  for (const sync of await getAllTrackerSyncs("azure-devops")) await deleteTrackerSync(sync.id);
  initAzureDevOpsOutbound();
});

afterEach(() => {
  teardownAzureDevOpsOutbound();
  globalThis.fetch = originalFetch;
  clearEnv();
});

describe("work item state transitions", () => {
  test("sets the started state on the linked work item", async () => {
    process.env.AZURE_DEVOPS_WORKITEM_STATE_STARTED = "Doing";
    const taskId = await linkedTask(9);
    emitTaskStarted({ id: taskId } as never);
    await settle();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe(`${ORG_URL}/_apis/wit/workitems/9?api-version=7.1`);
    expect(patches[0]?.contentType).toBe("application/json-patch+json");
    expect(patches[0]?.body).toEqual([{ op: "add", path: "/fields/System.State", value: "Doing" }]);
  });

  test("sets the done state when the task completes", async () => {
    process.env.AZURE_DEVOPS_WORKITEM_STATE_DONE = " Done ";
    const taskId = await linkedTask(9);
    workflowEventBus.emit("task.completed", { taskId, output: "ok" });
    await settle();
    expect(patches[0]?.body[0]?.value).toBe("Done");
  });

  test("does nothing when the state vars are unset", async () => {
    const taskId = await linkedTask(9);
    emitTaskStarted({ id: taskId } as never);
    workflowEventBus.emit("task.completed", { taskId });
    await settle();
    expect(patches).toHaveLength(0);
  });

  test("ignores tasks without a work item link", async () => {
    process.env.AZURE_DEVOPS_WORKITEM_STATE_DONE = "Done";
    const task = await createTaskExtended("plain", {});
    workflowEventBus.emit("task.completed", { taskId: task.id });
    await settle();
    expect(patches).toHaveLength(0);
  });

  test("a rejected update does not throw", async () => {
    process.env.AZURE_DEVOPS_WORKITEM_STATE_DONE = "Nope";
    patchStatus = 400;
    const taskId = await linkedTask(9);
    workflowEventBus.emit("task.completed", { taskId });
    await settle();
    expect(patches).toHaveLength(1);
  });

  test("stops after teardown", async () => {
    process.env.AZURE_DEVOPS_WORKITEM_STATE_DONE = "Done";
    const taskId = await linkedTask(9);
    teardownAzureDevOpsOutbound();
    workflowEventBus.emit("task.completed", { taskId });
    await settle();
    expect(patches).toHaveLength(0);
  });
});

describe("work item workflow events", () => {
  const unsubscribers: (() => void)[] = [];
  afterEach(() => {
    for (const off of unsubscribers.splice(0)) off();
  });
  function capture(name: string): Json[] {
    const seen: Json[] = [];
    const handler = (d: Json) => seen.push(d);
    workflowEventBus.on(name, handler);
    unsubscribers.push(() => workflowEventBus.off(name, handler));
    return seen;
  }
  function fresh(sample: unknown): Json {
    const event = structuredClone(sample) as Json;
    event.id = `00000000-0000-4000-8000-${String(900 + ++nextId).padStart(12, "0")}`;
    if (event.resource?.commentVersionRef) {
      event.resource.commentVersionRef.commentId = 2_000_000 + nextId;
    }
    return event;
  }

  test("emits azure-devops.work_item.assigned on an assignee change", async () => {
    const seen = capture("azure-devops.work_item.assigned");
    const event = fresh(updatedFixture);
    event.resource.fields = {
      ...event.resource.fields,
      "System.AssignedTo": { oldValue: "A <a@example.com>", newValue: "B <b@example.com>" },
    };
    await post(event);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      work_item_id: event.resource.workItemId,
      action: "assigned",
      assigned_to: "B <b@example.com>",
      previous_assignee: "A <a@example.com>",
    });
  });

  test("does not emit assigned when the assignee did not change", async () => {
    const seen = capture("azure-devops.work_item.assigned");
    const event = fresh(updatedFixture);
    delete event.resource.fields["System.AssignedTo"];
    await post(event);
    expect(seen).toHaveLength(0);
  });

  test("emits azure-devops.work_item.commented for a new comment only", async () => {
    const seen = capture("azure-devops.work_item.commented");
    const first = fresh(commentedFixture);
    first.resource.commentVersionRef.version = 1;
    await post(first);
    const edit = fresh(commentedFixture);
    edit.resource.commentVersionRef.version = 2;
    await post(edit);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      work_item_id: first.resource.id,
      action: "commented",
      comment: first.resource.fields["System.History"],
    });
  });
});

describe("work item state ordering and commit boundary", () => {
  test("a held Doing PATCH cannot land after Done", async () => {
    process.env.AZURE_DEVOPS_WORKITEM_STATE_STARTED = "Doing";
    process.env.AZURE_DEVOPS_WORKITEM_STATE_DONE = "Done";
    const taskId = await linkedTask(9);
    const applied: string[] = [];
    let releaseDoing!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseDoing = resolve;
    });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") return inner(input, init);
      const value = JSON.parse(String(init.body))[0].value as string;
      if (value === "Doing") await held;
      applied.push(value);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    emitTaskStarted({ id: taskId } as never);
    await settle();
    workflowEventBus.emit("task.completed", { taskId });
    await settle();
    expect(applied).toEqual([]);
    releaseDoing();
    await settle();
    expect(applied).toEqual(["Doing", "Done"]);
  });

  test("a rolled-back start never reaches Azure", async () => {
    process.env.AZURE_DEVOPS_WORKITEM_STATE_STARTED = "Doing";
    const taskId = await linkedTask(9);
    await getDbClient()
      .transaction(async () => {
        emitTaskStarted({ id: taskId } as never);
        throw new Error("rollback");
      })
      .catch(() => {});
    await settle();
    expect(patches).toHaveLength(0);
  });

  test("a committed start is delivered after the commit", async () => {
    process.env.AZURE_DEVOPS_WORKITEM_STATE_STARTED = "Doing";
    const taskId = await linkedTask(9);
    await getDbClient().transaction(async () => {
      emitTaskStarted({ id: taskId } as never);
    });
    await settle();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body[0]?.value).toBe("Doing");
  });

  test("scrubs secrets from a rejected update response", async () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH"
        ? new Response(`bad token ${token}`, { status: 401 })
        : inner(input, init)) as typeof fetch;
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      await updateWorkItemFields(ORG_URL, 9, [
        { op: "add", path: "/fields/System.State", value: "X" },
      ]);
    } finally {
      console.error = original;
    }
    expect(logged.join("\n")).toContain("401");
    expect(logged.join("\n")).not.toContain(token);
  });
});

describe("work item workflow events: trust and delivery boundaries", () => {
  const unsubscribers: (() => void)[] = [];
  afterEach(() => {
    for (const off of unsubscribers.splice(0)) off();
  });
  function capture(name: string): Json[] {
    const seen: Json[] = [];
    const handler = (d: Json) => seen.push(d);
    workflowEventBus.on(name, handler);
    unsubscribers.push(() => workflowEventBus.off(name, handler));
    return seen;
  }
  function fresh(sample: unknown): Json {
    const event = structuredClone(sample) as Json;
    event.id = `00000000-0000-4000-8000-${String(5000 + ++nextId).padStart(12, "0")}`;
    if (event.resource?.commentVersionRef) {
      event.resource.commentVersionRef.commentId = 3_000_000 + nextId;
      event.resource.commentVersionRef.version = 1;
    }
    return event;
  }
  function assigned(): Json {
    const event = fresh(updatedFixture);
    event.resource.fields = {
      ...event.resource.fields,
      "System.AssignedTo": { oldValue: "A <a@example.com>", newValue: "B <b@example.com>" },
    };
    return event;
  }
  function excludeOrg(event: Json): Json {
    const swap = (value: unknown) => String(value).replace("acme-org", "excluded-org");
    event.resourceContainers.account.baseUrl = swap(event.resourceContainers.account.baseUrl);
    event.resourceContainers.collection.baseUrl = swap(event.resourceContainers.collection.baseUrl);
    event.resource.url = swap(event.resource.url);
    return event;
  }

  test("events from an untrusted organization are not published", async () => {
    const assignedSeen = capture("azure-devops.work_item.assigned");
    const commentedSeen = capture("azure-devops.work_item.commented");
    await post(excludeOrg(assigned()));
    await post(excludeOrg(fresh(commentedFixture)));
    expect(assignedSeen).toHaveLength(0);
    expect(commentedSeen).toHaveLength(0);
  });

  test("concurrent and sequential retries publish once", async () => {
    const assignedSeen = capture("azure-devops.work_item.assigned");
    const commentedSeen = capture("azure-devops.work_item.commented");
    const assignment = assigned();
    const comment = fresh(commentedFixture);
    await Promise.all([post(assignment), post(assignment)]);
    await post(assignment);
    await Promise.all([post(comment), post(comment)]);
    await post(comment);
    // Same comment re-delivered under a new delivery id: the comment receipt covers it.
    const redelivered = structuredClone(comment);
    redelivered.id = `00000000-0000-4000-8000-${String(5000 + ++nextId).padStart(12, "0")}`;
    await post(redelivered);
    expect(assignedSeen).toHaveLength(1);
    expect(commentedSeen).toHaveLength(1);
  });

  test("published events start enabled event-trigger workflows", async () => {
    await initWorkflows();
    stopRetryPoller();
    stopWaitPoller();
    const make = (eventName: string) =>
      createWorkflow({
        name: `azure-trigger-${crypto.randomUUID().slice(0, 8)}`,
        definition: {
          nodes: [{ id: "n1", type: "notify", config: { channel: "swarm", template: "t" } }],
        },
        triggers: [{ type: "event", eventName: eventName as never }],
      });
    const onAssigned = await make("azure-devops.work_item.assigned");
    const onCommented = await make("azure-devops.work_item.commented");
    await post(assigned());
    await post(fresh(commentedFixture));
    await settle();
    expect(await listWorkflowRuns(onAssigned.id)).toHaveLength(1);
    expect(await listWorkflowRuns(onCommented.id)).toHaveLength(1);
  });
});
