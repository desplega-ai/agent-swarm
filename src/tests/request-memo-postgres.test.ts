import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  createTaskExtended,
  getAgentById,
  getTaskById,
  updateTaskProgress,
} from "../be/db";
import { closeDatabase, getDbClient, startPostgres } from "../be/db/runtime";
import { withRequestMemo } from "../be/request-memo";

// The request memo on the real Postgres engine: pooled reads can see the old
// row between a write and its COMMIT, which SQLite's single connection cannot
// show. Needs a server, like the storage package tests: STORAGE_TEST_POSTGRES_URL
// names a maintenance database (for example postgres://postgres@127.0.0.1:5432/postgres).
const adminUrl = process.env.STORAGE_TEST_POSTGRES_URL;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe.skipIf(!adminUrl)("request memo on Postgres", () => {
  const name = `st_memo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    SWARM_DATA_DIR: process.env.SWARM_DATA_DIR,
  };
  let dataDir = "";
  let agentId = "";

  beforeAll(async () => {
    const admin = new Bun.SQL(adminUrl!);
    try {
      await admin.unsafe(
        `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
      );
    } finally {
      await admin.close();
    }
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    dataDir = mkdtempSync(join(tmpdir(), "memo-pg-"));
    process.env.DATABASE_URL = url.toString();
    process.env.SWARM_DATA_DIR = dataDir;
    await startPostgres();
    agentId = crypto.randomUUID();
    await createAgent({ id: agentId, name: "Memo pg worker", isLead: false, status: "idle" });
  }, 60_000);

  afterAll(async () => {
    await closeDatabase();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
    const admin = new Bun.SQL(adminUrl!);
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  });

  async function newTask(): Promise<string> {
    const task = await createTaskExtended("memo pg", {
      agentId,
      source: "system",
      followUpConfig: { disabled: true },
    });
    return task.id;
  }

  // A second request caches the old committed rows after the UPDATEs and before
  // the COMMIT. Once transaction() resolves, its next reads must miss.
  test("rows cached between a transaction's writes and its COMMIT are stale once the transaction resolves", async () => {
    const id = await newTask();
    const otherAgent = crypto.randomUUID();
    await createAgent({ id: otherAgent, name: "Memo pg other", isLead: false, status: "idle" });
    const wrote = gate();
    const cached = gate();
    const committed = gate();
    const reader = withRequestMemo(async () => {
      await wrote.promise;
      const before = [(await getTaskById(id))?.progress, (await getAgentById(otherAgent))?.status];
      cached.release();
      await committed.promise;
      const after = [(await getTaskById(id))?.progress, (await getAgentById(otherAgent))?.status];
      return { before, after };
    });
    await getDbClient().transaction(async (tx) => {
      await tx.run("UPDATE agent_tasks SET progress = $1 WHERE id = $2", ["committed", id]);
      await tx.run("UPDATE agents SET status = $1 WHERE id = $2", ["busy", otherAgent]);
      wrote.release();
      await cached.promise;
    });
    committed.release();
    expect(await reader).toEqual({
      before: [undefined, "idle"],
      after: ["committed", "busy"],
    });
  });

  // The same write in a savepoint: its COMMIT is the outer transaction's.
  test("a write in a released savepoint invalidates at the outer COMMIT", async () => {
    const id = await newTask();
    const wrote = gate();
    const cached = gate();
    const committed = gate();
    const reader = withRequestMemo(async () => {
      await wrote.promise;
      const before = (await getTaskById(id))?.progress;
      cached.release();
      await committed.promise;
      return { before, after: (await getTaskById(id))?.progress };
    });
    const client = getDbClient();
    await client.transaction(async () => {
      await client.transaction(async (tx) => {
        await tx.run("UPDATE agent_tasks SET progress = $1 WHERE id = $2", ["savepoint", id]);
      });
      wrote.release();
      await cached.promise;
    });
    committed.release();
    expect(await reader).toEqual({ before: undefined, after: "savepoint" });
  });

  // A write outside a transaction runs in a fenced transaction of its own on
  // Postgres: its COMMIT bump must also land before the write resolves.
  test("a fenced autocommit write runs its COMMIT invalidation before it resolves", async () => {
    const id = await newTask();
    const client = getDbClient();
    const ran: string[] = [];
    const onCommit = client.onCommit.bind(client);
    const spy = spyOn(client, "onCommit").mockImplementation((fn) =>
      onCommit(() => {
        ran.push("onCommit");
        fn();
      }),
    );
    try {
      await withRequestMemo(async () => {
        expect((await getTaskById(id))?.progress).toBeUndefined();
        await updateTaskProgress(id, "autocommit");
        expect(ran.length).toBeGreaterThan(0);
        expect((await getTaskById(id))?.progress).toBe("autocommit");
      });
    } finally {
      spy.mockRestore();
    }
  });
});
