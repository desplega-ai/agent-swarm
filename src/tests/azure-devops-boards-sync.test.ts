import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resetAzureDevOpsBotIdCache } from "../azure-devops/api";
import { initAzureDevOps, resetAzureDevOps } from "../azure-devops/auth";
import { closeDb, createAgent, getTaskById, initDb } from "../be/db";
import {
  createTrackerSyncIfAbsent,
  deleteTrackerSync,
  getAllTrackerSyncs,
  getTrackerSyncByExternalId,
  hasTrackerDelivery,
} from "../be/db-queries/tracker";
import { handleWebhooks } from "../http/webhooks";
import { parseContextKey } from "../tasks/context-key";
import commentedFixture from "./fixtures/azure-boards/workitem.commented.json";
import createdFixture from "./fixtures/azure-boards/workitem.created.json";
import deletedFixture from "./fixtures/azure-boards/workitem.deleted.json";
import restoredFixture from "./fixtures/azure-boards/workitem.restored.json";
import updatedFixture from "./fixtures/azure-boards/workitem.updated.json";

// Fixtures are real service-hook deliveries (Task #9 in acme-org/Contoso),
// copied verbatim. Every delivery in production has its own notification id and
// comment id, so `fixture()` rewrites both to keep tests from deduplicating each other.
const TEST_DB_PATH = "./test-azure-devops-boards-sync.sqlite";
const SECRET = "boards-secret";
const BOT_ID = "7d40ac7f-6bdb-6baf-a2e2-dc9594e967d4";
const BOT_EMAIL = "swarm-bot@example.com";
const ORG_URL = "https://dev.azure.com/acme-org";
const LINK_9 = "dev.azure.com/acme-org#9";
const ACTOR = "alex.example@example.com";
const ENV_KEYS = [
  "AZURE_DEVOPS_WEBHOOK_SECRET",
  "AZURE_DEVOPS_TOKEN",
  "AZURE_DEVOPS_ORG_URL",
  "AZURE_DEVOPS_BOT_ID",
  "AZURE_DEVOPS_DISABLE",
  "AZURE_DEVOPS_ALLOWED_ACTORS",
] as const;

type Json = Record<string, any>;
const originalFetch = globalThis.fetch;
let nextId = 0;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  resetAzureDevOps();
  resetAzureDevOpsBotIdCache();
}

function fixture(sample: unknown, overrides: Json = {}): Json {
  const event = structuredClone(sample) as Json;
  event.id = `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  if (event.resource?.commentVersionRef)
    event.resource.commentVersionRef.commentId = 1_000_000 + nextId;
  return Object.assign(event, overrides);
}

function basic(password: string): string {
  return `Basic ${Buffer.from(`hook:${password}`).toString("base64")}`;
}

async function post(body: Json, password = SECRET): Promise<{ status: number; json: Json }> {
  const req = {
    method: "POST",
    headers: { authorization: basic(password) },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  } as unknown as IncomingMessage;
  const captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body = chunk;
      return this;
    },
  } as unknown as ServerResponse;
  await handleWebhooks(req, res, ["api", "azure-devops", "webhook"]);
  return { status: captured.status, json: captured.body ? JSON.parse(captured.body) : {} };
}

function assignedToBot(sample: Json): Json {
  const event = fixture(sample);
  event.resource.fields["System.AssignedTo"] = `Swarm Bot <${BOT_EMAIL}>`;
  return event;
}

beforeAll(async () => {
  clearEnv();
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
  await createAgent({ id: "lead-boards-001", name: "BoardsLead", status: "idle", isLead: true });
});

afterAll(async () => {
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
  process.env.AZURE_DEVOPS_BOT_ID = BOT_ID;
  process.env.AZURE_DEVOPS_ALLOWED_ACTORS = ACTOR;
  initAzureDevOps();
  // The bot's sign-in name comes from connectionData; work-item identities carry no GUID.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/_apis/connectionData")) {
      return Response.json({
        authenticatedUser: { id: BOT_ID, properties: { Account: { $value: BOT_EMAIL } } },
      });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;
  // Work item #9 is reused across tests; start each from no link.
  for (const sync of await getAllTrackerSyncs("azure-devops")) {
    await deleteTrackerSync(sync.id);
  }
  spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
  clearEnv();
});

describe("workitem.created", () => {
  test("assigned to the bot creates one task and links it", async () => {
    const { status, json } = await post(assignedToBot(createdFixture));
    expect(status).toBe(200);
    expect(json.created).toBe(true);

    const task = await getTaskById(json.taskId);
    expect(task?.source).toBe("azure-devops");
    expect(task?.taskType).toBe("azure-devops-work-item");
    expect(task?.task).toContain("[Azure DevOps Task #9]");
    expect(task?.task).toContain("Test task for Azure Boards integration");
    expect(task?.task).toContain("https://dev.azure.com/acme-org/Contoso/_workitems/edit/9");
    expect(parseContextKey(task!.contextKey!)).toEqual({
      family: "trackers",
      subFamily: "azure-devops",
      parts: { organization: "acme-org", kind: "workitem", workItemId: 9 },
    });

    const sync = await getTrackerSyncByExternalId("azure-devops", "task", LINK_9);
    expect(sync?.swarmId).toBe(json.taskId);
    expect(sync?.providerEntityType).toBe("WorkItem");
    expect(sync?.externalIdentifier).toBe("Contoso#9");
  });

  test("the real payload, with no assignee, creates nothing", async () => {
    const { json } = await post(fixture(createdFixture));
    expect(json).toEqual({ created: false });
    expect(await getTrackerSyncByExternalId("azure-devops", "task", LINK_9)).toBeNull();
  });

  test("a bot mention in the description creates a task", async () => {
    const event = fixture(createdFixture);
    event.resource.fields["System.Description"] =
      `<div><a href="#" data-vss-mention="version:2.0,${BOT_ID}">@Swarm Bot</a> please look</div>`;
    const { json } = await post(event);
    expect(json.created).toBe(true);
    expect((await getTaskById(json.taskId))?.task).toContain("please look");
  });

  test("duplicate delivery creates no second task", async () => {
    const event = assignedToBot(createdFixture);
    const first = await post(event);
    const second = await post(event);
    expect(first.json.created).toBe(true);
    expect(second.json).toEqual({ created: false });
  });

  test("the notification id is persisted on the link, so a retry after a restart is recognized", async () => {
    const event = assignedToBot(createdFixture);
    expect((await post(event)).json.created).toBe(true);
    expect(await hasTrackerDelivery("azure-devops", event.id)).toBe(true);
  });
});

describe("workitem.updated", () => {
  test("assignment to the bot creates exactly one task", async () => {
    const { json } = await post(fixture(updatedFixture));
    expect(json.created).toBe(true);
    const task = await getTaskById(json.taskId);
    expect(task?.task).toContain("[Azure DevOps Task #9]");
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", LINK_9);
    expect(sync?.swarmId).toBe(json.taskId);
  });

  test("an update without an AssignedTo change is ignored", async () => {
    const event = fixture(updatedFixture);
    delete event.resource.fields["System.AssignedTo"];
    const { json } = await post(event);
    expect(json).toEqual({ created: false });
    expect(await getTrackerSyncByExternalId("azure-devops", "task", LINK_9)).toBeNull();
  });

  test("a second assignment while the task is active creates no new task", async () => {
    const first = await post(fixture(updatedFixture));
    const second = await post(fixture(updatedFixture));
    expect(first.json.created).toBe(true);
    expect(second.json).toEqual({ created: false });
  });

  test("assignment away from the bot is ignored", async () => {
    const event = fixture(updatedFixture);
    event.resource.fields["System.AssignedTo"] = {
      oldValue: `Swarm Bot <${BOT_EMAIL}>`,
      newValue: "Someone Else <someone@example.com>",
    };
    expect((await post(event)).json).toEqual({ created: false });
  });
});

describe("workitem.commented", () => {
  test("a picker mention creates a task with the comment as context", async () => {
    const { json } = await post(fixture(commentedFixture));
    expect(json.created).toBe(true);
    const task = await getTaskById(json.taskId);
    expect(task?.task).toContain("please do this task.");
    expect(task?.task).not.toContain("data-vss-mention");
    expect(task?.task).toContain("mentioned bot");
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", LINK_9);
    expect(sync?.swarmId).toBe(json.taskId);
  });

  test("a plain-text @swarm-bot mention triggers", async () => {
    const event = fixture(commentedFixture);
    event.resource.fields["System.History"] = "<div>@swarm-bot can you check this?</div>";
    const { json } = await post(event);
    expect(json.created).toBe(true);
  });

  test("a comment without a mention is ignored", async () => {
    const event = fixture(commentedFixture);
    event.resource.fields["System.History"] = "<div>just a note</div>";
    expect((await post(event)).json).toEqual({ created: false });
  });

  test("a mention while the task is active creates a child task and keeps the link", async () => {
    const first = await post(fixture(updatedFixture));
    const second = await post(fixture(commentedFixture));
    expect(second.json.created).toBe(true);
    expect(second.json.taskId).not.toBe(first.json.taskId);
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", LINK_9);
    expect(sync?.swarmId).toBe(first.json.taskId);
    expect((await getTaskById(second.json.taskId))?.parentTaskId).toBe(first.json.taskId);
  });

  test("a comment written by the bot is ignored", async () => {
    const event = fixture(commentedFixture);
    event.resource.fields["System.ChangedBy"] = `Swarm Bot <${BOT_EMAIL}>`;
    expect((await post(event)).json).toEqual({ created: false });
  });
});

describe("workitem.deleted and workitem.restored", () => {
  test("deleting a linked work item cancels its task; restoring it re-engages the swarm", async () => {
    const first = await post(fixture(updatedFixture));
    const taskId = first.json.taskId as string;

    const deleted = await post(fixture(deletedFixture));
    expect(deleted.json).toEqual({ created: false });
    expect((await getTaskById(taskId))?.status).toBe("cancelled");

    const restored = await post(fixture(restoredFixture));
    expect(restored.json.created).toBe(true);
    expect(restored.json.taskId).not.toBe(taskId);
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", LINK_9);
    expect(sync?.swarmId).toBe(restored.json.taskId);
    expect((await getTaskById(restored.json.taskId))?.task).toContain("Follow-up");
  });

  test("deleting an unlinked work item does nothing", async () => {
    expect((await post(fixture(deletedFixture))).json).toEqual({ created: false });
  });

  test("restoring a linked work item whose task is still active does nothing", async () => {
    await post(fixture(updatedFixture));
    expect((await post(fixture(restoredFixture))).json).toEqual({ created: false });
  });

  test("restoring a never-linked work item behaves like created", async () => {
    const { json } = await post(fixture(restoredFixture));
    expect(json.created).toBe(true);
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", LINK_9);
    expect(sync?.swarmId).toBe(json.taskId);
  });

  test("restoring a never-linked, unassigned work item creates nothing", async () => {
    const event = fixture(restoredFixture);
    delete event.resource.fields["System.AssignedTo"];
    expect((await post(event)).json).toEqual({ created: false });
  });
});

describe("webhook auth", () => {
  test("a bad Basic password returns 401 and creates nothing", async () => {
    const { status } = await post(fixture(updatedFixture), "wrong");
    expect(status).toBe(401);
    expect(await getTrackerSyncByExternalId("azure-devops", "task", LINK_9)).toBeNull();
  });
});

// ── Review regressions (PR #2119) ──

function countingFetch(calls: string[], failures = { remaining: 0 }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)} ${init?.redirect ?? ""}`);
    if (failures.remaining > 0) {
      failures.remaining--;
      return new Response("unavailable", { status: 503 });
    }
    return Response.json({
      authenticatedUser: { id: BOT_ID, properties: { Account: { $value: BOT_EMAIL } } },
    });
  }) as typeof fetch;
}

function inOrg(event: Json, baseUrl: string): Json {
  event.resourceContainers = {
    account: { baseUrl },
    collection: { baseUrl },
  };
  event.resource.url = `${baseUrl}/proj/_apis/wit/workItems/9`;
  return event;
}

describe("organization URL validation", () => {
  test.each([
    ["a foreign host", "https://attacker.example.com/acme-org/"],
    ["plain http", "http://dev.azure.com/acme-org/"],
    ["another organization", "https://dev.azure.com/other-org/"],
    ["embedded credentials", "https://user:pw@dev.azure.com/acme-org/"],
  ])("a hostile payload (%s) makes zero credentialed requests", async (_name, baseUrl) => {
    delete process.env.AZURE_DEVOPS_BOT_ID; // forces connectionData lookups
    const calls: string[] = [];
    countingFetch(calls);
    resetAzureDevOpsBotIdCache();
    const event = inOrg(assignedToBot(createdFixture), baseUrl);
    expect((await post(event)).json).toEqual({ created: false });
    expect(calls).toEqual([]);
    expect(await getAllTrackerSyncs("azure-devops")).toHaveLength(0);
  });

  test("a hostile resource.url alone is rejected as well", async () => {
    delete process.env.AZURE_DEVOPS_BOT_ID;
    const calls: string[] = [];
    countingFetch(calls);
    const event = assignedToBot(createdFixture);
    delete event.resourceContainers;
    event.resource.url = "https://attacker.example.com/x/_apis/wit/workItems/9";
    expect((await post(event)).json).toEqual({ created: false });
    expect(calls).toEqual([]);
  });

  test("credentialed lookups refuse redirects", async () => {
    delete process.env.AZURE_DEVOPS_BOT_ID;
    const calls: string[] = [];
    countingFetch(calls);
    await post(assignedToBot(createdFixture));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.endsWith("error"))).toBe(true);
  });
});

describe("organization-scoped tracker identity", () => {
  test("deleting work item 9 in organization B does not cancel organization A's task", async () => {
    const first = await post(assignedToBot(createdFixture));
    const taskId = first.json.taskId as string;
    // A second organization is only reachable when it is not pinned by config.
    delete process.env.AZURE_DEVOPS_ORG_URL;
    initAzureDevOps();
    resetAzureDevOps();
    process.env.AZURE_DEVOPS_WEBHOOK_SECRET = SECRET;
    process.env.AZURE_DEVOPS_TOKEN = "pat";
    initAzureDevOps();
    const deleted = inOrg(fixture(deletedFixture), "https://dev.azure.com/other-org/");
    await post(deleted);
    expect((await getTaskById(taskId))?.status).not.toBe("cancelled");

    const sync = await getTrackerSyncByExternalId("azure-devops", "task", LINK_9);
    expect(sync?.swarmId).toBe(taskId);
    expect(await getTrackerSyncByExternalId("azure-devops", "task", "9")).toBeNull();
  });

  test("the same work item id in two organizations gets two links and two tasks", async () => {
    delete process.env.AZURE_DEVOPS_ORG_URL;
    resetAzureDevOps();
    process.env.AZURE_DEVOPS_WEBHOOK_SECRET = SECRET;
    process.env.AZURE_DEVOPS_TOKEN = "pat";
    initAzureDevOps();
    const a = await post(inOrg(assignedToBot(createdFixture), "https://dev.azure.com/acme-org/"));
    const b = await post(inOrg(assignedToBot(createdFixture), "https://dev.azure.com/other-org/"));
    expect(a.json.created).toBe(true);
    expect(b.json.created).toBe(true);
    expect(b.json.taskId).not.toBe(a.json.taskId);
    expect(await getAllTrackerSyncs("azure-devops")).toHaveLength(2);
  });
});

describe("concurrent deliveries", () => {
  test("two overlapping assignments create exactly one task and one link", async () => {
    const [a, b] = await Promise.all([
      post(fixture(updatedFixture)),
      post(fixture(updatedFixture)),
    ]);
    expect([a.json.created, b.json.created].filter(Boolean)).toHaveLength(1);
    const syncs = await getAllTrackerSyncs("azure-devops");
    expect(syncs).toHaveLength(1);
    expect(syncs[0]?.swarmId).toBe(a.json.created ? a.json.taskId : b.json.taskId);
  });

  test("the same notification delivered twice at once is handled once", async () => {
    const event = fixture(updatedFixture);
    const [a, b] = await Promise.all([post(event), post(event)]);
    expect([a.json.created, b.json.created].filter(Boolean)).toHaveLength(1);
  });

  test("a stale pending claim does not hide the link: the next delivery recovers it", async () => {
    await createTrackerSyncIfAbsent({
      provider: "azure-devops",
      entityType: "task",
      swarmId: `pending:azure-devops:${LINK_9}`,
      externalId: LINK_9,
    });
    const { json } = await post(fixture(updatedFixture));
    expect(json.created).toBe(true);
    expect((await getTrackerSyncByExternalId("azure-devops", "task", LINK_9))?.swarmId).toBe(
      json.taskId,
    );
  });
});

async function holdFirstCreate() {
  let release!: (err: Error) => void;
  const gate = new Promise<never>((_, reject) => {
    release = reject;
  });
  const spy = spyOn(await import("../tasks/sibling-awareness"), "createTaskWithSiblingAwareness");
  spy.mockImplementationOnce(() => gate);
  spyOn(console, "error").mockImplementation(() => {});
  return { release, spy };
}

async function spyCalled(spy: { mock: { calls: unknown[] } }) {
  for (let i = 0; i < 200 && spy.mock.calls.length === 0; i++) await Bun.sleep(5);
  expect(spy.mock.calls.length).toBeGreaterThan(0);
}

describe("failed deliveries stay retryable", () => {
  test("a transient connectionData failure returns 500 and the retry succeeds", async () => {
    delete process.env.AZURE_DEVOPS_BOT_ID;
    const calls: string[] = [];
    countingFetch(calls, { remaining: 1 });
    spyOn(console, "error").mockImplementation(() => {});
    const event = assignedToBot(createdFixture);
    expect((await post(event)).status).toBe(500);
    expect(await hasTrackerDelivery("azure-devops", event.id)).toBe(false);
    const retry = await post(event);
    expect(retry.status).toBe(200);
    expect(retry.json.created).toBe(true);
  });

  test("a failed task creation leaves no claim or receipt, and the retry creates the task", async () => {
    const event = assignedToBot(createdFixture);
    const spy = spyOn(await import("../tasks/sibling-awareness"), "createTaskWithSiblingAwareness");
    spy.mockRejectedValueOnce(new Error("boom"));
    spyOn(console, "error").mockImplementation(() => {});
    expect((await post(event)).status).toBe(500);
    expect(await getAllTrackerSyncs("azure-devops")).toHaveLength(0);
    expect(await hasTrackerDelivery("azure-devops", event.id)).toBe(false);
    spy.mockRestore();
    expect((await post(event)).json.created).toBe(true);
  });

  test("a replay of the same notification waits for an in-flight create that then fails", async () => {
    const event = fixture(commentedFixture);
    const { release, spy } = await holdFirstCreate();
    const first = post(event);
    await spyCalled(spy);
    const second = post(event);
    await Bun.sleep(20);
    release(new Error("boom"));
    expect((await first).status).toBe(500);
    expect((await second).status).toBe(500);
    expect(await getAllTrackerSyncs("azure-devops")).toHaveLength(0);
    spy.mockRestore();
    const retry = await post(event);
    expect(retry.status).toBe(200);
    expect(retry.json.created).toBe(true);
  });

  test("another notification for the same comment is not acknowledged while the first create fails", async () => {
    const first = fixture(commentedFixture);
    const other = fixture(commentedFixture);
    other.resource.commentVersionRef.commentId = first.resource.commentVersionRef.commentId;
    const { release, spy } = await holdFirstCreate();
    const firstPost = post(first);
    await spyCalled(spy);
    const otherPost = post(other);
    await Bun.sleep(20);
    release(new Error("boom"));
    expect((await firstPost).status).toBe(500);
    expect((await otherPost).status).toBe(500);
    spy.mockRestore();
    const replay = await post(other);
    expect(replay.status).toBe(200);
    expect(replay.json.created).toBe(true);
  });

  test("lastDeliveryId is written only after the task exists", async () => {
    const event = assignedToBot(createdFixture);
    const { json } = await post(event);
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", LINK_9);
    expect(sync?.swarmId).toBe(json.taskId);
    expect(sync?.lastDeliveryId).toBe(event.id);
  });
});

function byStranger(event: Json, email: string): Json {
  const who = `Stranger <${email}>`;
  if (event.resource.fields) event.resource.fields["System.ChangedBy"] = who;
  if (event.resource.revisedBy) event.resource.revisedBy.uniqueName = email;
  return event;
}

describe("actor authorization", () => {
  test("an unmapped actor creates no task", async () => {
    delete process.env.AZURE_DEVOPS_ALLOWED_ACTORS;
    spyOn(console, "warn").mockImplementation(() => {});
    const email = "stranger@example.net";
    expect((await post(byStranger(assignedToBot(createdFixture), email))).json).toEqual({
      created: false,
    });
    expect((await post(byStranger(fixture(commentedFixture), email))).json).toEqual({
      created: false,
    });
    expect((await post(byStranger(fixture(updatedFixture), email))).json).toEqual({
      created: false,
    });
    expect(await getAllTrackerSyncs("azure-devops")).toHaveLength(0);
  });

  test("an allowlisted actor creates a task", async () => {
    expect((await post(assignedToBot(createdFixture))).json.created).toBe(true);
  });

  test("an actor linked to a swarm user creates a task without the allowlist", async () => {
    delete process.env.AZURE_DEVOPS_ALLOWED_ACTORS;
    const email = "linked@example.org";
    const actor = { kind: "system", id: "test" } as const;
    const { findOrCreateUserByEmail, linkIdentity } = await import("../be/users");
    const { user } = await findOrCreateUserByEmail(email, { name: "Linked" }, actor);
    await linkIdentity(user.id, "azure-devops", email, actor);
    const { json } = await post(byStranger(assignedToBot(createdFixture), email));
    expect(json.created).toBe(true);
    expect((await getTaskById(json.taskId))?.requestedByUserId).toBe(user.id);
  });
});
