import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type PromptTemplatesRepository, type Storage, sql } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";

export function promptTemplatesContract(engine: ContractEngine): void {
  describe(`prompt templates repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: PromptTemplatesRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.promptTemplates;
      await storage.executor.run(sql`
        INSERT INTO prompt_templates (id, "eventType", scope, "scopeId", state, body, "isDefault",
          version, "createdBy", "createdAt", "updatedAt")
        VALUES ('p1', 'contract.event', 'agent', 'a1', 'enabled', 'b1', ${true}, 2, null, ${T0}, ${T0})`);
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const history = (id: string, version: number, body: string) => ({
      id,
      templateId: "p1",
      version,
      body,
      state: "enabled",
      changedBy: null,
      changedAt: T0,
      changeReason: null,
    });

    test("value shape, content update and delete", async () => {
      expect(await repo.findPromptTemplate("p1")).toMatchObject({
        isDefault: 1,
        version: 2,
        scopeId: "a1",
      });
      const updated = await repo.setPromptTemplateContent("p1", {
        body: "b2",
        state: "skip_event",
        version: 3,
        updatedAt: T1,
      });
      expect(updated).toMatchObject({
        body: "b2",
        state: "skip_event",
        version: 3,
        updatedAt: T1,
        isDefault: 1,
      });
      expect(
        await repo.setPromptTemplateContent("zz", {
          body: "",
          state: "enabled",
          version: 1,
          updatedAt: T1,
        }),
      ).toBeNull();
      expect(await repo.deletePromptTemplate("p1")).toBe(1);
      expect(await repo.deletePromptTemplate("p1")).toBe(0);
    });

    test("list by event type, ties in the SQLite plan order of each filter set", async () => {
      const insert = (id: string, eventType: string, scope: string, scopeId: string | null) =>
        storage.executor.run(sql`
          INSERT INTO prompt_templates (id, "eventType", scope, "scopeId", state, body, "isDefault",
            version, "createdBy", "createdAt", "updatedAt")
          VALUES (${id}, ${eventType}, ${scope}, ${scopeId}, 'enabled', 'b', ${id.endsWith("d")}, 1, null, ${T0}, ${T0})`);
      await insert("q1", "contract.b", "repo", "r1");
      await insert("q2", "contract.a", "repo", null);
      await insert("q3", "contract.b", "agent", "a2");
      await insert("q4d", "contract.b", "global", null);
      await insert("q5", "contract.b", "agent", null);
      await insert("q7", "contract.b", "repo", "a1");
      await insert("q6d", "contract.b", "agent", "a1");
      const ids = async (
        filters: Parameters<PromptTemplatesRepository["listPromptTemplates"]>[0],
      ) => (await repo.listPromptTemplates(filters)).map((row) => row.id);
      // The eventType index: ties in insertion order.
      expect(await ids({})).toEqual(["q2", "q1", "q3", "q4d", "q5", "q7", "q6d", "p1"]);
      expect(await ids({ eventType: "contract.b" })).toEqual([
        "q1",
        "q3",
        "q4d",
        "q5",
        "q7",
        "q6d",
      ]);
      expect(await ids({ isDefault: true })).toEqual(["q4d", "q6d", "p1"]);
      // The (scope, scopeId) index, sorted: ties by scopeId, NULL first.
      expect(await ids({ scope: "agent" })).toEqual(["q5", "q6d", "q3", "p1"]);
      // The (eventType, scope, scopeId) index.
      expect(await ids({ eventType: "contract.b", scope: "agent" })).toEqual(["q5", "q6d", "q3"]);
      // scopeId alone reads the (eventType, scope, scopeId) index; with an
      // event type it reads the eventType index.
      expect(await ids({ scopeId: "a1" })).toEqual(["q6d", "q7", "p1"]);
      expect(await ids({ eventType: "contract.b", scopeId: "a1" })).toEqual(["q7", "q6d"]);
      const first = (await repo.listPromptTemplates({ eventType: "contract.a" }))[0];
      expect(first).toEqual({
        id: "q2",
        eventType: "contract.a",
        scope: "repo",
        scopeId: null,
        state: "enabled",
        body: "b",
        isDefault: 0,
        version: 1,
        createdBy: null,
        createdAt: T0,
        updatedAt: T0,
        created_by: null,
        updated_by: null,
      });
    });

    test("history order and the first entry of a shared version", async () => {
      await repo.insertPromptTemplateHistory(history("h1", 1, "one"));
      await repo.insertPromptTemplateHistory(history("h2", 2, "two-a"));
      await repo.insertPromptTemplateHistory(history("h3", 2, "two-b"));
      expect((await repo.listPromptTemplateHistory("p1")).map((r) => r.id)).toEqual([
        "h3",
        "h2",
        "h1",
      ]);
      expect(await repo.findPromptTemplateHistoryVersion("p1", 2)).toMatchObject(
        history("h2", 2, "two-a"),
      );
      expect(await repo.findPromptTemplateHistoryVersion("p1", 9)).toBeNull();
    });
  });
}
