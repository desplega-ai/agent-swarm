import { describe, expect, test } from "bun:test";
import ingest, { LIMITS } from "../../templates/extensions/self-driving/scripts/ingest";

type Kv = Map<string, { value: unknown; ttlSeconds?: number }>;

// Minimal ctx: extension_list returns the stored config, kv_* hit an in-memory map.
function fakeCtx(config: Record<string, unknown> = {}) {
  const kv: Kv = new Map();
  const ctx = {
    swarm: {
      extension_list: async () => ({
        data: { extensions: [{ name: "self-driving", configJson: JSON.stringify(config) }] },
      }),
      kv_getOrNull: async ({ namespace, key }: { namespace: string; key: string }) =>
        kv.get(`${namespace}/${key}`) ?? null,
      kv_set: async (a: {
        namespace: string;
        key: string;
        value: unknown;
        ttlSeconds?: number;
      }) => {
        kv.set(`${a.namespace}/${a.key}`, { value: a.value, ttlSeconds: a.ttlSeconds });
        return { ok: true };
      },
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: test double for ScriptContext
  return { ctx: ctx as any, kv };
}

const payload = (event: Record<string, unknown> = {}, project = "demo-shop-web") => ({
  project,
  event: {
    event_id: "e1",
    title: "TypeError: cart is undefined",
    level: "error",
    fingerprint: ["fp"],
    ...event,
  },
});

describe("self-driving ingest bounds", () => {
  test("accepts a normal payload and records a dedupe key with the cooldown TTL", async () => {
    const { ctx, kv } = fakeCtx({ cooldownSeconds: 120 });
    const res = await ingest({ payload: payload() }, ctx);
    expect(res).toMatchObject({ ok: true, skipped: false, signal: { fingerprint: "fp" } });
    const entries = [...kv.entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toStartWith("ext-self-driving/dedupe:");
    expect(entries[0]?.[1].ttlSeconds).toBe(120);
  });

  test.each([
    ["project", payload({}, "p".repeat(LIMITS.project + 1))],
    ["title", payload({ title: "t".repeat(LIMITS.title + 1) })],
    ["culprit", payload({ culprit: "c".repeat(LIMITS.culprit + 1) })],
    ["event_id", payload({ event_id: "i".repeat(LIMITS.eventId + 1) })],
    [
      "fingerprint count",
      payload({
        fingerprint: Array.from({ length: LIMITS.fingerprintItems + 1 }, (_, i) => `f${i}`),
      }),
    ],
    ["fingerprint item", payload({ fingerprint: ["f".repeat(LIMITS.fingerprintItem + 1)] })],
  ])("rejects an oversized %s before any write", async (_name, body) => {
    const { ctx, kv } = fakeCtx();
    const res = await ingest({ payload: body }, ctx);
    expect(res.ok).toBe(false);
    expect(kv.size).toBe(0);
  });

  test("rejects a payload over the total size limit before parsing", async () => {
    const { ctx, kv } = fakeCtx();
    const body = { ...payload(), padding: "x".repeat(LIMITS.payloadBytes) };
    const res = await ingest({ payload: body }, ctx);
    expect(res).toMatchObject({ ok: false });
    expect(String((res as { error?: string }).error)).toContain("payload too large");
    expect(kv.size).toBe(0);
  });
});

describe("self-driving ingest cooldown", () => {
  test("a repeated event inside the window is skipped with no signal", async () => {
    const { ctx } = fakeCtx();
    expect((await ingest({ payload: payload() }, ctx)).ok).toBe(true);
    const again = await ingest({ payload: payload() }, ctx);
    expect(again).toMatchObject({ ok: true, skipped: true, signal: null });
  });

  test("distinct events on one fingerprint still pass, so the threshold can be reached", async () => {
    const { ctx } = fakeCtx();
    for (const id of ["e1", "e2", "e3"]) {
      expect(await ingest({ payload: payload({ event_id: id }) }, ctx)).toMatchObject({
        skipped: false,
      });
    }
  });

  test("cooldownSeconds 0 turns dedupe off and writes nothing", async () => {
    const { ctx, kv } = fakeCtx({ cooldownSeconds: 0 });
    await ingest({ payload: payload() }, ctx);
    expect(await ingest({ payload: payload() }, ctx)).toMatchObject({ skipped: false });
    expect(kv.size).toBe(0);
  });
});
