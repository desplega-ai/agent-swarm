import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { runBootScrubSweep } from "../be/boot-scrub-sweep";
import { closeDb, getKv, initDb, upsertKv } from "../be/db";
import { getMemoryStore } from "../be/memory";
import { registerStoredSecret } from "../be/secret-registry";
import dreamingApply from "../be/seed-scripts/catalog/dreaming-apply";
import dreamingRollback from "../be/seed-scripts/catalog/dreaming-rollback";
import { executeReadOnlyQuery } from "../http/db-query-shared";
import { scrubObject } from "../utils/secret-scrubber";
import { randomToken } from "./synthetic-secret-helpers";

// Lifecycle: a memory body is copied into a dreaming pre-image, then the value is registered as a secret and
// the boot sweep redacts the memory. No read of the pre-image (generic KV read or SQL hex of kv_entries) may
// still recover the value, and an authorized rollback still restores the pre-image.

const TEST_DB_PATH = "./test-dreaming-preimage-scrub.sqlite";
const NS = "dreaming-v2";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch {}
  }
}

// In-process ctx.swarm: the same DB, store and egress scrubber the tools use, without a server.
const store = () => getMemoryStore();
const ctx = {
  swarm: {
    db_query: async ({ sql, params = [] }: { sql: string; params?: unknown[] }) =>
      scrubObject(executeReadOnlyQuery(sql, params)),
    kv_getOrNull: async ({ namespace, key }: { namespace: string; key: string }) =>
      scrubObject(await getKv(namespace, key)),
    kv_set: async ({ namespace, key, value }: { namespace: string; key: string; value: unknown }) =>
      scrubObject(await upsertKv({ namespace, key, value, valueType: "json", expiresAt: null })),
    memory_edit: async ({ memoryId, ...rest }: { memoryId: string; [k: string]: unknown }) =>
      store().edit({ id: memoryId, ...(rest as any) }),
  },
} as any;

const hexHas = (hx: unknown, needle: string) =>
  Buffer.from(String(hx ?? ""), "hex")
    .toString("utf8")
    .includes(needle);

async function editAndApply(runId: string, content: string) {
  const memory = await store().store({
    agentId: null,
    scope: "swarm",
    name: `${runId}-note`,
    content,
    source: "manual",
    intent: "dreaming pre-image scrub test",
  });
  const result: any = await dreamingApply(
    {
      runId,
      v3Writes: "off",
      synth: {
        actions: [
          {
            id: "A1",
            lane: "memory",
            tier: "auto",
            op: "memory-edit",
            mode: "append",
            content: "Appended review note.",
            target: { memoryIds: [memory.id] },
          },
        ],
      },
    },
    ctx,
  );
  expect(result.errors).toEqual([]);
  expect(result.applied).toHaveLength(1);
  return { memory, result };
}

describe("dreaming memory pre-images follow the memory's redaction", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });
  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("after the value is registered and swept, no pre-image read recovers it", async () => {
    const value = randomToken(32);
    const runId = "preimage-scrub-run";
    await editAndApply(runId, `Project reference ${value}. Keep these notes.`);
    const key = `preimage:${runId}:A1`;
    const kvHex = `SELECT hex(CAST(value AS BLOB)) AS hx FROM kv_entries WHERE namespace = ? AND key = ?`;
    // Positive control: before cleanup the pre-image holds the value.
    expect(hexHas(executeReadOnlyQuery(kvHex, [NS, key]).rows[0]?.[0], value)).toBe(true);

    // memtax-create writes the same kind of copy under its own prefix; a non-pre-image key stays untouched.
    const memtaxKey = `memtax-create:pre:${runId}:m1`;
    const otherKey = `memtax-create:writes:${runId}`;
    for (const k of [memtaxKey, otherKey]) {
      await ctx.swarm.kv_set({
        namespace: NS,
        key: k,
        value: { rows: [{ id: "m1", content: `copy ${value}` }] },
      });
    }

    registerStoredSecret(value, "config:DREAMING_PREIMAGE_TEST_SECRET");
    const stats = await runBootScrubSweep({ reembed: false, version: 990001 });
    expect(stats?.find((s) => s.table === "agent_memory")?.changed).toBe(1);
    expect(stats?.find((s) => s.table === "kv_entries")?.changed).toBe(2);
    expect(hexHas(executeReadOnlyQuery(kvHex, [NS, memtaxKey]).rows[0]?.[0], value)).toBe(false);
    expect(hexHas(executeReadOnlyQuery(kvHex, [NS, otherKey]).rows[0]?.[0], value)).toBe(true);

    // A non-lead generic KV read: no field, decoded or not, carries the value.
    const pre: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key });
    const row = pre?.value?.rows?.[0];
    expect(row?.contentHex).toBeUndefined();
    expect(JSON.stringify(pre)).not.toContain(value);
    expect(String(row?.content)).toContain("[REDACTED:");
    // Arbitrary SQL against kv_entries: the stored bytes are redacted too.
    expect(hexHas(executeReadOnlyQuery(kvHex, [NS, key]).rows[0]?.[0], value)).toBe(false);
  });

  test("an authorized rollback still restores the pre-image from the kv row", async () => {
    const body = `Rollback reference ${randomToken(16)}.\nsecond line of the memory body`;
    const runId = "preimage-rollback-run";
    const { memory, result } = await editAndApply(runId, body);
    await ctx.swarm.kv_set({
      namespace: NS,
      key: `ledger:${runId}`,
      value: { applied: result.applied },
    });

    const out: any = await dreamingRollback({ runId }, ctx);
    expect(out.controls.ok).toBe(true);
    expect(out.failed).toEqual([]);
    expect(out.restored).toEqual([
      { actionId: "A1", kind: "memory-edit", how: "content restored" },
    ]);
    const hx = executeReadOnlyQuery(
      "SELECT hex(CAST(content AS BLOB)) AS hx FROM agent_memory WHERE id = ?",
      [memory.id],
    ).rows[0]?.[0];
    expect(Buffer.from(String(hx), "hex").toString("utf8")).toBe(body);
  });
});
