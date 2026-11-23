import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Storage, UserReferenceColumn, UsersRepository } from "../../src";
import { jsonText, sql } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-01T00:00:00.000Z";

export function userReferencesContract(engine: ContractEngine): void {
  describe(`users repository: retained references [${engine.name}]`, () => {
    let storage: Storage;
    let repo: UsersRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.users;
      for (const id of ["u-old", "u-new"]) {
        await storage.executor.run(sql`
          INSERT INTO users (id, name, status, "createdAt", "lastUpdatedAt")
          VALUES (${id}, ${id}, 'active', ${T0}, ${T0})`);
      }
      await storage.executor.run(sql`
        INSERT INTO workflows (id, name, definition, "createdAt", "lastUpdatedAt")
        VALUES ('wf', 'wf', '{"nodes":[]}', ${T0}, ${T0})`);
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    // `context` is jsonb on Postgres: valid JSON goes through jsonText (on
    // SQLite it binds the same text). A malformed context binds as plain
    // text: SQLite stores the text as is, and Postgres, which cannot store
    // malformed JSON in jsonb, stores it as a JSON string scalar. Either way
    // the requester path finds no requester in it.
    const run = (id: string, context: string | null, createdBy: string | null = null) => {
      let valid = context !== null;
      try {
        if (context !== null) JSON.parse(context);
      } catch {
        valid = false;
      }
      const value = valid ? sql`${jsonText(context)}` : sql`${context}`;
      return storage.executor.run(sql`
        INSERT INTO workflow_runs (id, "workflowId", status, context, created_by)
        VALUES (${id}, 'wf', 'completed', ${value}, ${createdBy})`);
    };
    const requested = (userId: string) => JSON.stringify({ swarm: { requestedByUserId: userId } });

    const column = async (tableName: string, columnName: string) => {
      const found = (await repo.listUserReferenceColumns()).find(
        (ref) => ref.tableName === tableName && ref.columnName === columnName,
      );
      if (!found) throw new Error(`${tableName}.${columnName} not discovered`);
      return found;
    };

    test("discovery lists nullable user FKs with their batch key", async () => {
      const runs = await column("workflow_runs", "created_by");
      expect(runs).toEqual({
        tableName: "workflow_runs",
        columnName: "created_by",
        withoutRowid: false,
        keyColumns: ["rowid"],
      } satisfies UserReferenceColumn);
      const kv = await column("kv_entries", "created_by");
      expect(kv.withoutRowid).toBe(true);
      expect(kv.keyColumns).toEqual(["namespace", "key"]);
      expect(await column("scheduled_tasks", "created_by")).toBeTruthy();
    });

    test("a column rewrite moves every row, or at most `limit` rows, and can clear", async () => {
      for (const id of ["r1", "r2", "r3"]) await run(id, null, "u-old");
      const ref = await column("workflow_runs", "created_by");
      expect(await repo.rewriteUserReferenceColumn(ref, "u-old", "u-new", 2)).toBe(2);
      expect(await repo.rewriteUserReferenceColumn(ref, "u-old", "u-new", 2)).toBe(1);
      expect(await repo.rewriteUserReferenceColumn(ref, "u-old", "u-new", 2)).toBe(0);
      expect(await repo.rewriteUserReferenceColumn(ref, "u-new", null)).toBe(3);
      const rows = await storage.executor.query<{ created_by: string | null }>(
        sql`SELECT created_by FROM workflow_runs`,
      );
      expect(rows.every((row) => row.created_by === null)).toBe(true);
    });

    test("a limited rewrite batches a table without row ids by its primary key", async () => {
      for (const key of ["a", "b", "c"]) {
        await storage.executor.run(sql`
          INSERT INTO kv_entries (namespace, key, value, value_type, created_by)
          VALUES ('ns', ${key}, '1', 'string', 'u-old')`);
      }
      const ref = await column("kv_entries", "created_by");
      expect(await repo.rewriteUserReferenceColumn(ref, "u-old", "u-new", 2)).toBe(2);
      expect(await repo.rewriteUserReferenceColumn(ref, "u-old", "u-new", 2)).toBe(1);
    });

    test("runs requested by a user come ordered by id; malformed context is skipped", async () => {
      await run("r3", requested("u-old"));
      await run("r1", requested("u-old"));
      await run("r2", requested("u-new"));
      await run("r4", "not json");
      expect(await repo.listWorkflowRunIdsRequestedBy("u-old")).toEqual(["r1", "r3"]);
      expect(await repo.listWorkflowRunIdsRequestedBy("u-old", 1)).toEqual(["r1"]);
    });

    test("sealed contexts are listed only for the named runs with a replay copy", async () => {
      await run("r1", requested("u-old"));
      await run("r2", requested("u-old"));
      await run("r3", requested("u-new"));
      for (const id of ["r1", "r3"]) await repo.setWorkflowRunContextReplay(id, `sealed-${id}`);
      expect(await repo.listSealedWorkflowContextsRequestedBy(["r1", "r2", "r3"], "u-old")).toEqual(
        [{ id: "r1", context_replay: "sealed-r1" }],
      );
    });

    test("the context requester is replaced, or removed, only in the named runs", async () => {
      await run("r1", requested("u-old"));
      await run("r2", requested("u-old"));
      await run("r3", requested("u-old"));
      expect(await repo.rewriteWorkflowRunContextRequester(["r1", "r2"], "u-old", "u-new")).toBe(2);
      expect(await repo.rewriteWorkflowRunContextRequester(["r2", "r3"], "u-new", null)).toBe(1);
      const rows = await storage.executor.query<{ id: string; context: string }>(
        sql`SELECT id, context FROM workflow_runs ORDER BY id`,
      );
      expect(rows.map((row) => [row.id, JSON.parse(row.context).swarm])).toEqual([
        ["r1", { requestedByUserId: "u-new" }],
        ["r2", {}],
        ["r3", { requestedByUserId: "u-old" }],
      ]);
    });
  });
}
