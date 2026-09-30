import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, getDbClient, getKv, getTaskById, initDb } from "../be/db";
import { type ReviewBatchInput, sendReviewBatch } from "../comb/review-batch";
import {
  type AgentFsComment,
  type AgentFsFileVersion,
  AgentFsProvider,
} from "../fs/agent-fs-provider";
import { resetFileStorageProvider } from "../fs/registry";
import { handleComb } from "../http/comb";
import { handleCore } from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-comb-review-batch.sqlite";
const API_KEY = "example-comb-key";
const BOOT_KEY = "af_boot_example";
const ORG = "org-comb";
const DRIVE = "drive-comb";
const SERVICE_USER = "svc-user";
const HUMAN = "human-user";

const ENV_KEYS = [
  "COMB_ENABLED",
  "AGENT_FS_API_URL",
  "AGENT_FS_DEFAULT_ORG_ID",
  "AGENT_FS_DEFAULT_DRIVE_ID",
  "API_AGENT_FS_API_KEY",
  "AGENT_FS_API_KEY",
  "APP_URL",
];
const savedEnv = new Map<string, string | undefined>();

/** An in-memory agent-fs: `/auth/me`, `comment-get`, `log`, and `comment-add` replies. */
class FakeAgentFs {
  comments = new Map<string, AgentFsComment>();
  /** `log` answers, by stored version path (exact match, like agent-fs). */
  versions = new Map<string, AgentFsFileVersion[]>();
  failReplies = false;
  private seq = 0;

  add(fields: Partial<AgentFsComment> & { body: string }): AgentFsComment {
    const comment: AgentFsComment = {
      id: crypto.randomUUID(),
      path: "comb-qa/notes.md",
      author: HUMAN,
      authorDisplayName: "QA Human",
      resolved: false,
      createdAt: new Date(Date.now() + this.seq++).toISOString(),
      ...fields,
    };
    this.comments.set(comment.id, comment);
    return comment;
  }

  repliesTo(id: string): AgentFsComment[] {
    return [...this.comments.values()].filter((comment) => comment.parentId === id);
  }

  handle = async (request: Request): Promise<Response> => {
    if (request.headers.get("authorization") !== `Bearer ${BOOT_KEY}`) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/auth/me") return Response.json({ userId: SERVICE_USER });
    if (url.pathname !== `/orgs/${ORG}/ops` || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const body = (await request.json()) as Record<string, string>;
    if (body.driveId !== DRIVE) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
    if (body.op === "comment-get") {
      const comment = this.comments.get(body.id as string);
      if (!comment) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      return Response.json({ comment, replies: this.repliesTo(comment.id) });
    }
    if (body.op === "log") {
      return Response.json({ versions: this.versions.get(body.path as string) ?? [] });
    }
    if (body.op === "comment-add") {
      if (this.failReplies) return Response.json({ error: "BOOM" }, { status: 500 });
      const parent = this.comments.get(body.parentId as string);
      if (!parent) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      return Response.json(
        this.add({
          parentId: parent.id,
          path: parent.path,
          body: body.body as string,
          author: SERVICE_USER,
        }),
      );
    }
    return Response.json({ error: "UNKNOWN_OP" }, { status: 400 });
  };
}

let fake: FakeAgentFs;
let agentFsServer: ReturnType<typeof Bun.serve>;
let apiServer: Server;
let apiPort: number;
let leadId: string;

function provider(): AgentFsProvider {
  return new AgentFsProvider({
    apiUrl: "http://agent-fs.test",
    apiKey: BOOT_KEY,
    orgId: ORG,
    driveId: DRIVE,
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
      fake.handle(new Request(input, init))) as typeof fetch,
  });
}

function batch(commentIds: string[], scopePath = "/comb-qa/notes.md"): ReviewBatchInput {
  return { orgId: ORG, driveId: DRIVE, commentIds, scopePath, requestedByUserId: null };
}

async function combTaskIds(): Promise<string[]> {
  const rows = await getDbClient().query<{ id: string }>(
    "SELECT id FROM agent_tasks WHERE source = 'comb'",
  );
  return rows.map((row) => row.id);
}

function post(body: unknown): Promise<Response> {
  return fetch(`http://localhost:${apiPort}/api/comb/review-batches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  leadId = (await createAgent({ name: "comb-lead", isLead: true, status: "idle" })).id;

  fake = new FakeAgentFs();
  agentFsServer = Bun.serve({ port: 0, fetch: (request) => fake.handle(request) });
  apiServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    const handled = await handleComb(
      req,
      res,
      getPathSegments(req.url || ""),
      parseQueryParams(req.url || ""),
      myAgentId,
    );
    if (!handled) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  apiPort = await listenOnFreePort(apiServer);
});

afterAll(async () => {
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  agentFsServer.stop(true);
  closeDb();
  await removeDbFiles();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetFileStorageProvider();
});

beforeEach(async () => {
  fake.comments.clear();
  fake.versions.clear();
  fake.failReplies = false;
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.COMB_ENABLED = "true";
  process.env.AGENT_FS_API_URL = `http://localhost:${agentFsServer.port}`;
  process.env.API_AGENT_FS_API_KEY = BOOT_KEY;
  process.env.AGENT_FS_DEFAULT_ORG_ID = ORG;
  process.env.AGENT_FS_DEFAULT_DRIVE_ID = DRIVE;
  process.env.APP_URL = "https://swarm.example.test";
  resetFileStorageProvider();
  await getDbClient().run("DELETE FROM kv_entries WHERE namespace = 'comb:sent'");
});

afterEach(() => {
  resetFileStorageProvider();
});

describe("sendReviewBatch", () => {
  test("sends every comment as ONE lead task and replies on each", async () => {
    const a = fake.add({
      body: "@swarm tighten this",
      lineStart: 3,
      lineEnd: 5,
      quote: { exact: "First paragraph." },
      fileVersion: 2,
    });
    const b = fake.add({ body: "@swarm add an example", path: "/comb-qa/notes.md", lineStart: 7 });
    const c = fake.add({
      body: "@swarm\nsplit this\nin two",
      path: "comb-qa/other.md",
      authorDisplayName: undefined,
    });
    // b has no fileVersion: the log answers with the newest version before it.
    const before = new Date(Date.parse(b.createdAt) - 60_000).toISOString();
    const after = new Date(Date.parse(b.createdAt) + 60_000).toISOString();
    fake.versions.set("comb-qa/notes.md", [
      { version: 2, createdAt: after },
      { version: 1, createdAt: before },
    ]);

    const result = await sendReviewBatch(batch([a.id, b.id, c.id]), { agentFs: provider() });

    expect(result.sent).toEqual([a.id, b.id, c.id]);
    expect(result.skipped).toEqual([]);
    const task = await getTaskById(result.taskId);
    expect(task?.source).toBe("comb");
    expect(task?.taskType).toBe("comb-review");
    expect(task?.agentId).toBe(leadId);
    expect(task?.tags).toContain("comb");
    const text = task?.task ?? "";
    expect(text).toStartWith("[Comb] Review 3 comment(s) on /comb-qa/notes.md");
    for (const comment of [a, b]) {
      expect(text).toContain(`Comment ${comment.id} by QA Human (agent-fs user ${HUMAN})`);
    }
    expect(text).toContain(`Comment ${c.id} by agent-fs user ${HUMAN} on`);
    expect(text).toContain("on /comb-qa/notes.md (version 2, lines 3-5)");
    expect(text).toContain(
      `Comment ${b.id} by QA Human (agent-fs user ${HUMAN}) on /comb-qa/notes.md (version 1, line 7)`,
    );
    expect(text).toContain("on /comb-qa/other.md (version unknown, whole file)");
    expect(text).toContain("Quote: First paragraph.");
    expect(text).toContain("Comment: @swarm\n    split this\n    in two");
    expect(text).toContain(
      `Open: https://swarm.example.test/file/~/${ORG}/${DRIVE}/comb-qa/notes.md?comment=${a.id}`,
    );
    expect(text).toContain("Requested by: an operator (swarm API key)");

    for (const comment of [a, b, c]) {
      const replies = fake.repliesTo(comment.id);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.author).toBe(SERVICE_USER);
      expect(replies[0]?.body).toBe(
        `[comb:sent task=${result.taskId}] Sent to the swarm: https://swarm.example.test/tasks/${result.taskId}`,
      );
      expect((await getKv("comb:sent", comment.id))?.value).toEqual({
        status: "sent",
        taskId: result.taskId,
      });
    }
  });

  test("a second send of the same comments creates nothing", async () => {
    const a = fake.add({ body: "@swarm one" });
    const b = fake.add({ body: "@swarm two" });
    await sendReviewBatch(batch([a.id, b.id]), { agentFs: provider() });
    const before = await combTaskIds();

    const again = sendReviewBatch(batch([a.id, b.id]), { agentFs: provider() });
    await expect(again).rejects.toMatchObject({
      status: 409,
      skipped: [
        { id: a.id, reason: "already-sent" },
        { id: b.id, reason: "already-sent" },
      ],
    });
    expect(await combTaskIds()).toEqual(before);
  });

  test("two concurrent sends of the same comments create exactly one task", async () => {
    const ids = [fake.add({ body: "@swarm a" }).id, fake.add({ body: "@swarm b" }).id];
    const before = (await combTaskIds()).length;

    const results = await Promise.allSettled([
      sendReviewBatch(batch(ids), { agentFs: provider() }),
      sendReviewBatch(batch(ids), { agentFs: provider() }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ status: 409 });
    expect((await combTaskIds()).length).toBe(before + 1);
    for (const id of ids) expect(fake.repliesTo(id)).toHaveLength(1);
  });

  test("overlapping concurrent sends send each comment once", async () => {
    const [a, b, c] = ["a", "b", "c"].map((name) => fake.add({ body: `@swarm ${name}` }).id);
    const results = await Promise.all([
      sendReviewBatch(batch([a as string, b as string]), { agentFs: provider() }).catch(() => null),
      sendReviewBatch(batch([b as string, c as string]), { agentFs: provider() }).catch(() => null),
    ]);
    const sent = results.flatMap((result) => result?.sent ?? []).sort();
    expect(sent).toEqual([a, b, c].sort());
  });

  test("skips resolved comments, replies, sent comments, and unknown ids", async () => {
    const good = fake.add({ body: "@swarm fix" });
    const resolved = fake.add({ body: "@swarm done", resolved: true });
    const parent = fake.add({ body: "@swarm parent" });
    const reply = fake.add({ body: "a reply", parentId: parent.id });
    const marked = fake.add({ body: "@swarm old" });
    fake.add({
      parentId: marked.id,
      body: `[comb:sent task=${crypto.randomUUID()}] Sent to the swarm`,
      author: SERVICE_USER,
    });
    // A marker that a human typed is not a "sent" reply.
    const spoofed = fake.add({ body: "@swarm spoof" });
    fake.add({
      parentId: spoofed.id,
      body: `[comb:sent task=${crypto.randomUUID()}]`,
      author: "someone-else",
    });
    const missing = crypto.randomUUID();

    const result = await sendReviewBatch(
      batch([good.id, resolved.id, reply.id, marked.id, spoofed.id, missing, good.id]),
      { agentFs: provider() },
    );

    expect(result.sent).toEqual([good.id, spoofed.id]);
    expect(result.skipped).toEqual([
      { id: resolved.id, reason: "resolved" },
      { id: reply.id, reason: "reply" },
      { id: marked.id, reason: "already-sent" },
      { id: missing, reason: "not-found" },
    ]);
  });

  test("a failed task creation releases the claims, so a retry works", async () => {
    const ids = [fake.add({ body: "@swarm a" }).id, fake.add({ body: "@swarm b" }).id];
    const failing = sendReviewBatch(batch(ids), {
      agentFs: provider(),
      createTask: async () => {
        throw new Error("db down");
      },
    });
    await expect(failing).rejects.toThrow("db down");
    for (const id of ids) {
      expect(await getKv("comb:sent", id)).toBeNull();
      expect(fake.repliesTo(id)).toHaveLength(0);
    }

    const retry = await sendReviewBatch(batch(ids), { agentFs: provider() });
    expect(retry.sent).toEqual(ids);
  });

  test("a failed reply still succeeds, and the KV row blocks a second send", async () => {
    const id = fake.add({ body: "@swarm a" }).id;
    fake.failReplies = true;
    const result = await sendReviewBatch(batch([id]), { agentFs: provider() });
    expect(result.sent).toEqual([id]);
    expect(fake.repliesTo(id)).toHaveLength(0);

    fake.failReplies = false;
    const again = sendReviewBatch(batch([id]), { agentFs: provider() });
    await expect(again).rejects.toMatchObject({
      status: 409,
      skipped: [{ id, reason: "already-sent" }],
    });
  });
});

describe("POST /api/comb/review-batches", () => {
  test("creates the task, then answers 409 for the same comments", async () => {
    const ids = [fake.add({ body: "@swarm a" }).id, fake.add({ body: "@swarm b" }).id];
    const body = { orgId: ORG, driveId: DRIVE, commentIds: ids, scopePath: "/comb-qa/" };

    const created = await post(body);
    expect(created.status).toBe(201);
    const result = (await created.json()) as { taskId: string; sent: string[] };
    expect(result.sent).toEqual(ids);
    expect((await getTaskById(result.taskId))?.task).toContain("Scope: /comb-qa/ (");

    const again = await post(body);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { skipped: unknown[] }).skipped).toHaveLength(2);
  });

  test("answers 404 while Comb is off", async () => {
    process.env.COMB_ENABLED = "false";
    const id = fake.add({ body: "@swarm a" }).id;
    const response = await post({ orgId: ORG, driveId: DRIVE, commentIds: [id], scopePath: "/" });
    expect(response.status).toBe(404);
    expect(fake.repliesTo(id)).toHaveLength(0);
  });

  test("answers 400 for another drive or more than 50 comments", async () => {
    const id = fake.add({ body: "@swarm a" }).id;
    const otherDrive = await post({
      orgId: ORG,
      driveId: "drive-x",
      commentIds: [id],
      scopePath: "/",
    });
    expect(otherDrive.status).toBe(400);

    const tooMany = Array.from({ length: 51 }, () => crypto.randomUUID());
    const oversize = await post({
      orgId: ORG,
      driveId: DRIVE,
      commentIds: tooMany,
      scopePath: "/",
    });
    expect(oversize.status).toBe(400);
    expect(fake.repliesTo(id)).toHaveLength(0);
  });
});
