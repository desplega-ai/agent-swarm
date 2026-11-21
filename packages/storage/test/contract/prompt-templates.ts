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
