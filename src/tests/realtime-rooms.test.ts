import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import * as Y from "yjs";
import { closeDb, createPage, deletePage, getDbClient, getKv, initDb } from "../be/db";
import { applyOperations, changeDocument, createDocument, materialize } from "../realtime/document";
import {
  applyRoomUpdate,
  changeRoom,
  closeRooms,
  decodeRoomSnapshot,
  flushRooms,
  getRoom,
  removeNamespaceRooms,
  resetRoom,
  roomView,
  sweepRooms,
} from "../realtime/rooms";

const TEST_DB_PATH = "./test-realtime-rooms.sqlite";

async function deleteTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
  }
}

function cloneDocument(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc({ gc: true });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}

beforeAll(async () => {
  await deleteTestDb();
  initDb(TEST_DB_PATH);
});

beforeEach(async () => {
  await closeRooms();
  await getDbClient().run("DELETE FROM kv_entries");
  await getDbClient().run("DELETE FROM pages");
});

afterAll(async () => {
  await closeRooms();
  closeDb();
  await deleteTestDb();
});

describe("realtime document", () => {
  test("rejects scalar and array roots", () => {
    for (const state of [null, true, 42, "oops", []]) {
      expect(() => createDocument(state)).toThrow("safe JSON object");
    }
  });

  test("applies documented operations and rejects invalid batches atomically", () => {
    const doc = createDocument({
      count: 2,
      items: [{ id: "a", done: false }],
      note: "hi",
      obsolete: true,
    });
    applyOperations(doc, [
      { type: "increment", path: ["count"], by: 3 },
      { type: "insert", path: ["items"], index: 1, values: [{ id: "b", done: false }] },
      { type: "set", path: ["items", 0, "done"], value: true },
      { type: "text", path: ["note"], index: 2, insert: " there" },
      { type: "delete", path: ["obsolete"] },
    ]);
    expect(materialize(doc)).toEqual({
      count: 5,
      items: [
        { id: "a", done: true },
        { id: "b", done: false },
      ],
      note: "hi there",
    });

    const before = Y.encodeStateAsUpdate(doc);
    expect(() =>
      applyOperations(doc, [
        { type: "set", path: ["count"], value: 9 },
        { type: "delete", path: ["missing"] },
      ]),
    ).toThrow("does not exist");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(() =>
      applyOperations(doc, [
        {
          type: "set",
          path: ["bad"],
          value: { __proto__: { polluted: true } } as never,
        },
      ]),
    ).toThrow("safe JSON");
  });

  test("merges concurrent edits to distinct object leaves", () => {
    const base = createDocument({ profile: { name: "Ada", score: 0 } });
    const left = cloneDocument(base);
    const right = cloneDocument(base);
    changeDocument(left, (state) => {
      const profile = state.profile as { name: string; score: number };
      profile.name = "Grace";
    });
    changeDocument(right, (state) => {
      const profile = state.profile as { name: string; score: number };
      profile.score = 7;
    });
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    expect(materialize(left)).toEqual({ profile: { name: "Grace", score: 7 } });
    expect(materialize(right)).toEqual(materialize(left));
  });

  test("merges concurrent array insertions", () => {
    const base = createDocument({ items: ["start"] });
    const left = cloneDocument(base);
    const right = cloneDocument(base);
    applyOperations(left, [{ type: "insert", path: ["items"], index: 1, values: ["left"] }]);
    applyOperations(right, [{ type: "insert", path: ["items"], index: 1, values: ["right"] }]);
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    const items = materialize(left).items as string[];
    expect(items[0]).toBe("start");
    expect(new Set(items.slice(1))).toEqual(new Set(["left", "right"]));
    expect(materialize(right)).toEqual(materialize(left));
  });

  test("keeps unrelated array entries when one change inserts and edits", () => {
    const doc = createDocument({
      items: [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ],
    });
    const operations = changeDocument(doc, (state) => {
      const items = state.items as Array<{ id: string; value: number }>;
      items.unshift({ id: "new", value: 0 });
      items[2]!.value = 3;
    });
    expect(operations).not.toContainEqual({ type: "delete", path: ["items", 0] });
    expect(materialize(doc)).toEqual({
      items: [
        { id: "new", value: 0 },
        { id: "a", value: 1 },
        { id: "b", value: 3 },
      ],
    });
  });

  test("rejects asynchronous change callbacks before applying their draft", () => {
    const doc = createDocument({ value: 1 });
    expect(() =>
      changeDocument(doc, (state) => {
        state.value = 2;
        return Promise.resolve();
      }),
    ).toThrow("must be synchronous");
    expect(materialize(doc)).toEqual({ value: 1 });
  });

  test("does not assign a concurrent keyed-item edit to another item during reorder", () => {
    const base = createDocument({
      items: [
        { id: "a", title: "Alpha" },
        { id: "b", title: "Beta" },
      ],
    });
    const reordered = cloneDocument(base);
    const edited = cloneDocument(base);

    changeDocument(reordered, (state) => {
      (state.items as Array<{ id: string; title: string }>).reverse();
    });
    changeDocument(edited, (state) => {
      const items = state.items as Array<{ id: string; title: string }>;
      items[1]!.title = "Edited Beta";
    });

    Y.applyUpdate(reordered, Y.encodeStateAsUpdate(edited));
    Y.applyUpdate(edited, Y.encodeStateAsUpdate(reordered));
    expect(materialize(edited)).toEqual(materialize(reordered));
    const items = materialize(reordered).items as Array<{ id: string; title: string }>;
    expect(items.map((item) => item.id)).toEqual(["b", "a"]);
    expect(items.find((item) => item.id === "a")?.title).toBe("Alpha");
  });

  test("keeps precise nested edits for unkeyed arrays", () => {
    const doc = createDocument({ items: [{ title: "Alpha" }, { title: "Beta" }] });
    const operations = changeDocument(doc, (state) => {
      const items = state.items as Array<{ title: string }>;
      items[1]!.title = "Edited Beta";
    });
    expect(operations).toEqual([
      { type: "set", path: ["items", 1, "title"], value: "Edited Beta" },
    ]);
  });
});

describe("room engine", () => {
  test("flushes one envelope and reloads it", async () => {
    await changeRoom("task:agent:test", "board", [
      { type: "set", path: ["title"], value: "Planning" },
      { type: "set", path: ["cards"], value: [{ id: "one" }] },
    ]);
    await flushRooms();
    const entry = await getKv("task:agent:test", "_room/board");
    expect(entry?.valueType).toBe("json");
    expect(decodeRoomSnapshot(entry?.value)).toMatchObject({
      schemaVersion: 1,
      state: { title: "Planning", cards: [{ id: "one" }] },
    });

    removeNamespaceRooms("task:agent:test");
    const loaded = await getRoom("task:agent:test", "board");
    expect(roomView(loaded).state).toEqual({ title: "Planning", cards: [{ id: "one" }] });
  });

  test("returns stale reads and refuses stale writes", async () => {
    await resetRoom("task:agent:stale", "state", { value: 1 }, 2);
    const room = await getRoom("task:agent:stale", "state", 1);
    expect(roomView(room, 1).stale).toBe(true);
    await expect(
      changeRoom("task:agent:stale", "state", [{ type: "set", path: ["value"], value: 2 }]),
    ).rejects.toThrow("does not match");
  });

  test("reset rejects updates from the old generation", async () => {
    await resetRoom("task:agent:reset", "game", { turn: 1 });
    const oldRoom = await getRoom("task:agent:reset", "game");
    const peer = cloneDocument(oldRoom.doc);
    applyOperations(peer, [{ type: "set", path: ["turn"], value: 2 }]);
    const oldUpdate = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(oldRoom.doc));
    const oldGeneration = oldRoom.generation;

    const reset = await resetRoom("task:agent:reset", "game", { turn: 10 });
    const current = await getRoom("task:agent:reset", "game");
    expect(reset.generation).not.toBe(oldGeneration);
    await expect(applyRoomUpdate(current, oldUpdate, oldGeneration, 1)).rejects.toThrow(
      "generation does not match",
    );
    expect(roomView(current).state).toEqual({ turn: 10 });
    await flushRooms();
    removeNamespaceRooms("task:agent:reset");
    expect(roomView(await getRoom("task:agent:reset", "game")).state).toEqual({ turn: 10 });
  });

  test("enforces the namespace room count under concurrent creation", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 101 }, (_, index) => getRoom("task:agent:cap", `room_${index}`)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(100);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    removeNamespaceRooms("task:agent:cap");
  });

  test("creates a missing room when a read-only load is already pending", async () => {
    const namespace = "task:agent:pending-mode";
    const read = getRoom(namespace, "board", 1, { create: false });
    const write = changeRoom(namespace, "board", [{ type: "set", path: ["created"], value: true }]);
    const [readResult, writeResult] = await Promise.allSettled([read, write]);
    expect(readResult.status).toBe("rejected");
    expect(writeResult.status).toBe("fulfilled");
    expect(roomView(await getRoom(namespace, "board")).state).toEqual({ created: true });
  });

  test("keeps one Yjs client identity across repeated room changes", async () => {
    const namespace = "task:agent:client-churn";
    await resetRoom(namespace, "counter", { count: 0 });
    for (let index = 0; index < 1_000; index += 1) {
      await changeRoom(namespace, "counter", [{ type: "increment", path: ["count"], by: 1 }]);
    }
    const room = await getRoom(namespace, "counter");
    expect(roomView(room).state).toEqual({ count: 1_000 });
    expect(Y.decodeStateVector(Y.encodeStateVector(room.doc)).size).toBe(1);
    expect(Y.encodeStateAsUpdate(room.doc).byteLength).toBeLessThan(4_096);
  });

  test("rejects a change whose encoded envelope exceeds 2 MiB", async () => {
    await expect(
      resetRoom("task:agent:bytes", "large", { text: "x".repeat(1_600_000) }),
    ).rejects.toThrow("exceeds");
  });

  test("does not recreate a page snapshot after page deletion", async () => {
    const page = await createPage({
      agentId: crypto.randomUUID(),
      slug: "room-delete-race",
      title: "Room race",
      contentType: "text/html",
      body: "<p>race</p>",
    });
    const namespace = `task:page:${page.id}`;
    await changeRoom(namespace, "board", [{ type: "set", path: ["ready"], value: true }]);
    expect(await deletePage(page.id)).toBe(true);
    await flushRooms();
    expect(await getKv(namespace, "_room/board")).toBeNull();
    await expect(closeRooms()).rejects.toThrow("failed to flush");
    removeNamespaceRooms(namespace);
  });

  test("flushes before idle eviction", async () => {
    const room = await getRoom("task:agent:idle", "doc");
    await changeRoom("task:agent:idle", "doc", [{ type: "set", path: ["saved"], value: true }]);
    room.lastActivity = 1;
    expect(await sweepRooms(5 * 60_000 + 2)).toBe(1);
    expect(decodeRoomSnapshot((await getKv("task:agent:idle", "_room/doc"))?.value).state).toEqual({
      saved: true,
    });
  });

  test("does not evict a room that becomes active while its flush waits", async () => {
    const room = await getRoom("task:agent:sweep-race", "doc");
    await changeRoom("task:agent:sweep-race", "doc", [
      { type: "set", path: ["saved"], value: true },
    ]);
    room.lastActivity = 1;

    let announceLock!: () => void;
    let releaseLock!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      announceLock = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lock = getDbClient().transaction(async () => {
      announceLock();
      await lockRelease;
    });
    await lockReady;

    const now = 5 * 60_000 + 2;
    const sweep = sweepRooms(now);
    room.lastActivity = now;
    releaseLock();
    await lock;
    expect(await sweep).toBe(0);
    expect(await getRoom("task:agent:sweep-race", "doc")).toBe(room);
  });
});
