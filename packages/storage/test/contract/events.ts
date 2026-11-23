import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type EventsRepository, type NewEvent, type Storage, sql } from "../../src";
import type { ContractEngine } from "./env";

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function newEvent(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    id: crypto.randomUUID(),
    category: "task",
    event: "task.created",
    status: "ok",
    source: "api",
    agentId: null,
    taskId: null,
    sessionId: null,
    parentEventId: null,
    numericValue: null,
    durationMs: null,
    data: null,
    ...overrides,
  };
}

export function eventsContract(engine: ContractEngine): void {
  describe(`events repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: EventsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.events;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const setCreatedAt = (id: string, createdAt: string) =>
      storage.executor.run(sql`UPDATE events SET "createdAt" = ${createdAt} WHERE id = ${id}`);

    test("insert stamps createdAt with milliseconds and keeps the values", async () => {
      await repo.insert(
        newEvent({ id: "e1", agentId: "a1", numericValue: 1.5, durationMs: 20, data: '{"k":1}' }),
      );
      const [row] = await repo.list(10);
      expect(row).toMatchObject({
        id: "e1",
        category: "task",
        event: "task.created",
        status: "ok",
        source: "api",
        agentId: "a1",
        taskId: null,
        numericValue: 1.5,
        durationMs: 20,
        data: '{"k":1}',
      });
      expect(row?.createdAt).toMatch(ISO_MS);
    });

    test("list orders by createdAt descending; ties follow the documented order", async () => {
      for (const id of ["z", "a", "m", "b"]) await repo.insert(newEvent({ id, agentId: "a1" }));
      await repo.insert(newEvent({ id: "other", agentId: "a2" }));
      for (const id of ["z", "a", "b", "other"]) await setCreatedAt(id, "2026-01-01T00:00:00.000Z");
      await setCreatedAt("m", "2026-01-02T00:00:00.000Z");
      const filtered = await repo.list(10, { column: "agentId", value: "a1" });
      expect(filtered.map((row) => row.id)).toEqual(["m", "z", "a", "b"]);
      expect((await repo.list(10)).map((row) => row.id)).toEqual(["m", "other", "b", "a", "z"]);
      expect((await repo.list(2)).map((row) => row.id)).toEqual(["m", "other"]);
    });

    test("countByEvent filters and orders by count, then name", async () => {
      const add = async (event: string, agentId: string, createdAt: string) => {
        const id = crypto.randomUUID();
        await repo.insert(newEvent({ id, event, agentId }));
        await setCreatedAt(id, createdAt);
      };
      await add("b.x", "a1", "2026-01-01T00:00:00.000Z");
      await add("a.x", "a1", "2026-01-02T00:00:00.000Z");
      await add("c.x", "a1", "2026-01-03T00:00:00.000Z");
      await add("c.x", "a2", "2026-01-04T00:00:00.000Z");
      expect(await repo.countByEvent({})).toEqual([
        { event: "c.x", count: 2 },
        { event: "a.x", count: 1 },
        { event: "b.x", count: 1 },
      ]);
      expect(await repo.countByEvent({ agentId: "a1" })).toEqual([
        { event: "a.x", count: 1 },
        { event: "b.x", count: 1 },
        { event: "c.x", count: 1 },
      ]);
      expect(
        await repo.countByEvent({
          since: "2026-01-02T00:00:00.000Z",
          until: "2026-01-03T00:00:00.000Z",
        }),
      ).toEqual([
        { event: "a.x", count: 1 },
        { event: "c.x", count: 1 },
      ]);
      expect(await repo.countByEvent({ category: "nope" })).toEqual([]);
    });

    test("listFiltered: filters, data field, latest per pair, newest first", async () => {
      const add = async (o: Partial<NewEvent>, createdAt: string) => {
        const e = newEvent(o);
        await repo.insert(e);
        await setCreatedAt(e.id, createdAt);
        return e.id;
      };
      const a = await add(
        { event: "x.a", agentId: "ag", data: '{"field":"f1"}' },
        "2026-01-01T00:00:00.000Z",
      );
      const b = await add(
        { event: "x.a", agentId: "ag", data: '{"field":"f1"}' },
        "2026-01-02T00:00:00.000Z",
      );
      const c = await add(
        { event: "x.b", agentId: "ag", data: '{"field":"f2"}' },
        "2026-01-03T00:00:00.000Z",
      );
      const d = await add(
        { event: "x.b", agentId: "other", status: "error" },
        "2026-01-04T00:00:00.000Z",
      );
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      expect(ids(await repo.listFiltered({ limit: 10 }))).toEqual([d, c, b, a]);
      expect(ids(await repo.listFiltered({ limit: 2 }))).toEqual([d, c]);
      expect(ids(await repo.listFiltered({ agentId: "ag", limit: 10 }))).toEqual([c, b, a]);
      expect(ids(await repo.listFiltered({ events: ["x.b"], limit: 10 }))).toEqual([d, c]);
      expect(ids(await repo.listFiltered({ status: "error", limit: 10 }))).toEqual([d]);
      expect(ids(await repo.listFiltered({ dataField: "f1", limit: 10 }))).toEqual([b, a]);
      expect(
        ids(
          await repo.listFiltered({
            since: "2026-01-02T00:00:00.000Z",
            until: "2026-01-03T00:00:00.000Z",
            limit: 10,
          }),
        ),
      ).toEqual([c, b]);
      expect(
        ids(
          await repo.listFiltered({
            agentId: "ag",
            limit: 10,
            latestPerDataField: { events: ["x.a", "x.b"], dataFields: ["f1", "f2"] },
          }),
        ),
      ).toEqual([c, b]);
      expect(
        await repo.listFiltered({
          limit: 10,
          latestPerDataField: { events: [], dataFields: ["f1"] },
        }),
      ).toEqual([]);
      expect(ids(await repo.listFiltered({ readableBy: { userId: "u1" }, limit: 10 }))).toEqual([
        d,
        c,
        b,
        a,
      ]);
    });
  });
}
