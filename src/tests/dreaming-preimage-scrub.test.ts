import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { runBootScrubSweep } from "../be/boot-scrub-sweep";
import { closeDb, getDbClient, getKv, initDb, upsertKv } from "../be/db";
import { getMemoryStore } from "../be/memory";
import { registerStoredSecret } from "../be/secret-registry";
import dreamingApply from "../be/seed-scripts/catalog/dreaming-apply";
import dreamingRollback from "../be/seed-scripts/catalog/dreaming-rollback";
import { executeReadOnlyQuery } from "../http/db-query-shared";
import { scrubObject } from "../utils/secret-scrubber";
import { randomToken } from "./synthetic-secret-helpers";

// Lifecycle: a memory body is copied into a dreaming pre-image, then the value is registered as a secret and
// the boot sweep redacts the memory. No read of the pre-image (generic KV read or SQL hex of kv_entries) may
// still recover the value, and an authorized rollback still restores the pre-image. The same holds for every
// other dreaming-v2 copy (legacy hex pre-images, trim and heartbeat state, drafts, results), including on an
// install that already finished the previous sweep version.

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

  test("after the value is registered and swept, no dreaming-v2 read recovers it", async () => {
    const value = randomToken(32);
    const runId = "preimage-scrub-run";
    await editAndApply(runId, `Project reference ${value}. Keep these notes.`);
    const key = `preimage:${runId}:A1`;
    const kvHex = `SELECT hex(CAST(value AS BLOB)) AS hx FROM kv_entries WHERE namespace = ? AND key = ?`;
    const storedText = (ns: string, k: string) =>
      Buffer.from(String(executeReadOnlyQuery(kvHex, [ns, k]).rows[0]?.[0] ?? ""), "hex").toString(
        "utf8",
      );
    // Independent of the sweep's decoder: the stored text plus every hex field decoded.
    const recoverable = (ns: string, k: string) => {
      const text = storedText(ns, k);
      const hexFields = [...text.matchAll(/"\w+Hex":"([0-9a-fA-F]*)"/g)].map((m) =>
        Buffer.from(m[1] ?? "", "hex").toString("utf8"),
      );
      return [text, ...hexFields].some((t) => t.includes(value));
    };

    // A legacy apply pre-image kept a hex copy of the body, which hides the value from a plain scrub.
    const hex = (t: string) => Buffer.from(t, "utf8").toString("hex");
    const legacyBody = `Legacy reference ${value}.\nsecond line`;
    const legacyKey = `preimage:legacy-run:A1`;
    // Every other dreaming-v2 family that copies text: memtax, trim and heartbeat pre-images, state, drafts, results.
    const copies: Record<string, unknown> = {
      [legacyKey]: {
        kind: "memory-edit",
        rows: [{ id: "m-legacy", content: legacyBody, contentHex: hex(legacyBody) }],
      },
      [`memtax-create:pre:${runId}:m1`]: { rows: [{ id: "m1", content: `copy ${value}` }] },
      [`trim-preimage:${runId}:agent-1:soulMd`]: { text: `soul ${value}` },
      "trim-state:agent-1:soulMd": { afterSha: "x", afterText: `trimmed soul ${value}` },
      [`hb-preimage:${runId}`]: { text: `heartbeat ${value}` },
      [`hb-draft:${runId}`]: { text: `draft ${value}` },
      "hb-state:lead": { afterSha: "y", afterText: `heartbeat after ${value}` },
      [`result:${runId}:lane-c`]: { summary: `lane result ${value}` },
    };
    // Negative controls: a legacy hex row without the value keeps its bytes; another namespace is out of scope.
    const cleanKey = "preimage:clean-run:A1";
    const cleanValue = {
      kind: "memory-edit",
      rows: [{ id: "m-clean", content: "plain", contentHex: hex("plain") }],
    };
    for (const [k, v] of Object.entries({ ...copies, [cleanKey]: cleanValue })) {
      await ctx.swarm.kv_set({ namespace: NS, key: k, value: v });
    }
    await ctx.swarm.kv_set({
      namespace: "other-ns",
      key: "note",
      value: { text: `kept ${value}` },
    });
    const cleanBefore = storedText(NS, cleanKey);

    // Positive controls: before the sweep every copy holds the value; the legacy one only through its hex.
    for (const k of [key, ...Object.keys(copies)]) expect(recoverable(NS, k)).toBe(true);
    const legacyStored = JSON.parse(storedText(NS, legacyKey));
    legacyStored.rows[0].content = "plain";
    await ctx.swarm.kv_set({ namespace: NS, key: legacyKey, value: legacyStored });
    expect(storedText(NS, legacyKey)).not.toContain(value);
    expect(recoverable(NS, legacyKey)).toBe(true);

    // The install already finished the previous version, which never swept dreaming-v2.
    await getDbClient().run(
      `INSERT INTO seed_state (kind, key, seededHash, seededAt) VALUES ('maintenance', 'boot-scrub-v9', 'done', datetime('now'))`,
    );
    registerStoredSecret(value, "config:DREAMING_PREIMAGE_TEST_SECRET");
    const stats = await runBootScrubSweep({ reembed: false });
    expect(stats).not.toBeNull();
    expect(stats?.find((s) => s.table === "agent_memory")?.changed).toBe(1);
    expect(stats?.find((s) => s.table === "kv_entries")?.changed).toBe(
      1 + Object.keys(copies).length,
    );
    for (const k of [key, ...Object.keys(copies)]) expect(recoverable(NS, k)).toBe(false);
    // The legacy row's hex is folded into its plain field (stored bytes, redacted), not kept beside it.
    const legacyAfter = JSON.parse(storedText(NS, legacyKey)).rows[0];
    expect(legacyAfter.contentHex).toBeUndefined();
    expect(legacyAfter.content).toBe(
      legacyBody.replace(value, "[REDACTED:config:DREAMING_PREIMAGE_TEST_SECRET]"),
    );
    expect(storedText(NS, cleanKey)).toBe(cleanBefore);
    expect(recoverable("other-ns", "note")).toBe(true);

    // A non-lead generic KV read: no field, decoded or not, carries the value.
    const pre: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key });
    const row = pre?.value?.rows?.[0];
    expect(row?.contentHex).toBeUndefined();
    expect(JSON.stringify(pre)).not.toContain(value);
    expect(String(row?.content)).toContain("[REDACTED:");
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
