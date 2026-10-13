import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resetAzureDevOpsBotIdCache } from "../azure-devops/api";
import { initAzureDevOps, resetAzureDevOps } from "../azure-devops/auth";
import { closeDb, createAgent, getTaskById, initDb } from "../be/db";
import {
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

// Fixtures are real service-hook deliveries (Task #9 in PTTestAutomation/VN-TAG),
// copied verbatim. Every delivery in production has its own notification id and
// comment id, so `fixture()` rewrites both to keep tests from deduplicating each other.
const TEST_DB_PATH = "./test-azure-devops-boards-sync.sqlite";
const SECRET = "boards-secret";
const BOT_ID = "7d40ac7f-6bdb-6baf-a2e2-dc9594e967d4";
const BOT_EMAIL = "LabThinker@ttigroup.com.vn";
const ORG_URL = "https://dev.azure.com/PTTestAutomation";
const ENV_KEYS = [
  "AZURE_DEVOPS_WEBHOOK_SECRET",
  "AZURE_DEVOPS_TOKEN",
  "AZURE_DEVOPS_ORG_URL",
  "AZURE_DEVOPS_BOT_ID",
  "AZURE_DEVOPS_DISABLE",
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
  event.resource.fields["System.AssignedTo"] = `Lab Thinker Software <${BOT_EMAIL}>`;
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
    expect(task?.task).toContain("https://dev.azure.com/PTTestAutomation/VN-TAG/_workitems/edit/9");
    expect(parseContextKey(task!.contextKey!)).toEqual({
      family: "trackers",
      subFamily: "azure-devops",
      parts: { organization: "PTTestAutomation", kind: "workitem", workItemId: 9 },
    });

    const sync = await getTrackerSyncByExternalId("azure-devops", "task", "9");
    expect(sync?.swarmId).toBe(json.taskId);
    expect(sync?.providerEntityType).toBe("WorkItem");
    expect(sync?.externalIdentifier).toBe("VN-TAG#9");
  });

  test("the real payload, with no assignee, creates nothing", async () => {
    const { json } = await post(fixture(createdFixture));
    expect(json).toEqual({ created: false });
    expect(await getTrackerSyncByExternalId("azure-devops", "task", "9")).toBeNull();
  });

  test("a bot mention in the description creates a task", async () => {
    const event = fixture(createdFixture);
    event.resource.fields["System.Description"] =
      `<div><a href="#" data-vss-mention="version:2.0,${BOT_ID}">@Lab Thinker Software</a> please look</div>`;
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
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", "9");
    expect(sync?.swarmId).toBe(json.taskId);
  });

  test("an update without an AssignedTo change is ignored", async () => {
    const event = fixture(updatedFixture);
    delete event.resource.fields["System.AssignedTo"];
    const { json } = await post(event);
    expect(json).toEqual({ created: false });
    expect(await getTrackerSyncByExternalId("azure-devops", "task", "9")).toBeNull();
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
      oldValue: `Lab Thinker Software <${BOT_EMAIL}>`,
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
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", "9");
    expect(sync?.swarmId).toBe(json.taskId);
  });

  test("a plain-text @labthinker mention triggers", async () => {
    const event = fixture(commentedFixture);
    event.resource.fields["System.History"] = "<div>@LabThinker can you check this?</div>";
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
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", "9");
    expect(sync?.swarmId).toBe(first.json.taskId);
    expect((await getTaskById(second.json.taskId))?.parentTaskId).toBe(first.json.taskId);
  });

  test("a comment written by the bot is ignored", async () => {
    const event = fixture(commentedFixture);
    event.resource.fields["System.ChangedBy"] = `Lab Thinker Software <${BOT_EMAIL}>`;
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
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", "9");
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
    const sync = await getTrackerSyncByExternalId("azure-devops", "task", "9");
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
    expect(await getTrackerSyncByExternalId("azure-devops", "task", "9")).toBeNull();
  });
});
