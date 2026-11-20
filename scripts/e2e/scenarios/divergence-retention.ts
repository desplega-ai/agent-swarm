import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerWorker } from "./core-helpers";

const KEEP_LATEST = "CONTEXT_VERSIONS_KEEP_LATEST";
const EVENTS_DAYS = "EVENTS_RETENTION_DAYS";

// Cleanup sweeps an operator can drive: the boot-time retention tick (keep the
// newest N profile versions per agent and field, age out events) and lazy KV expiry.
// Each removes exactly the rows past its limit and keeps the rest.
export const divergenceRetention: Scenario = {
  name: "divergence-retention",
  order: 9_457,
  async run(ctx) {
    await kvExpiry(ctx);

    const busy = await registerWorker(ctx, "retention-busy");
    const quiet = await registerWorker(ctx, "retention-quiet");
    const edit = async (agentId: string, field: string, content: string) =>
      expectStatus(
        await ctx.api("PUT", `/api/agents/${agentId}/profile`, {
          body: { [field]: content, changeSource: "api", changeReason: content.slice(0, 40) },
        }),
        [200],
        `edit ${field}`,
      );
    for (let i = 1; i <= 5; i++) await edit(busy, "soulMd", `Busy soul ${i} ${ctx.nonce}`);
    await edit(busy, "identityMd", `Busy identity ${ctx.nonce}`);
    for (let i = 1; i <= 2; i++) await edit(quiet, "soulMd", `Quiet soul ${i} ${ctx.nonce}`);

    const versions = (agentId: string, field: string) =>
      ctx.db
        .query<{ version: number }>(
          sql`SELECT version FROM context_versions WHERE "agentId" = ${agentId} AND field = ${field} ORDER BY version`,
        )
        .map((row) => Number(row.version));
    expect(
      JSON.stringify(versions(busy, "soulMd")) === "[1,2,3,4,5]",
      `busy soulMd versions before the sweep: ${JSON.stringify(versions(busy, "soulMd"))}`,
    );

    const event = await ctx.api("POST", "/api/events", {
      body: {
        category: "system",
        event: "system.boot",
        status: "ok",
        source: "api",
        agentId: busy,
        data: { marker: `retention-${ctx.nonce}` },
      },
    });
    expectStatus(event, [201], "record a fresh event");
    const eventId = asString(asRecord(asRecord(event.json).event).id, "event id");

    const restore = await setGlobalConfig(ctx, { [KEEP_LATEST]: "2", [EVENTS_DAYS]: "1" });
    try {
      // The first retention tick runs at boot.
      await ctx.restartSut();
      const swept = await pollUntil(() => versions(busy, "soulMd").length === 2, 20_000, 200);
      expect(
        swept,
        `keep-latest 2 left busy soulMd versions ${JSON.stringify(versions(busy, "soulMd"))}`,
      );
      expect(
        JSON.stringify(versions(busy, "soulMd")) === "[4,5]",
        `the sweep kept ${JSON.stringify(versions(busy, "soulMd"))}, want the newest two`,
      );
      expect(
        JSON.stringify(versions(busy, "identityMd")) === "[1]",
        "a field's only version must survive",
      );
      expect(
        JSON.stringify(versions(quiet, "soulMd")) === "[1,2]",
        "an agent at the limit must keep every version",
      );
      const newest = ctx.db.get<{ content: string; previousVersionId: string | null }>(
        sql`SELECT content, "previousVersionId" FROM context_versions WHERE "agentId" = ${busy} AND field = 'soulMd' AND version = 4`,
      );
      expect(
        newest?.content === `Busy soul 4 ${ctx.nonce}`,
        "version 4 lost its content in the sweep",
      );
      expect(
        newest?.previousVersionId === null,
        "the oldest kept version still points at a deleted predecessor",
      );
      const agent = await ctx.api("GET", `/api/agents/${busy}`);
      expectStatus(agent, [200], "read the swept agent");
      expect(
        asRecord(agent.json).soulMd === `Busy soul 5 ${ctx.nonce}`,
        "the live profile changed in the sweep",
      );

      const kept = ctx.db.get<{ id: string }>(sql`SELECT id FROM events WHERE id = ${eventId}`);
      expect(kept?.id === eventId, "a fresh event was deleted by a 1-day retention");
      // sutLog holds the restarted process only.
      const log = await ctx.sutLog();
      expect(
        /\[db-retention\] starting \([^)]*context_versions=2/.test(log),
        "the boot did not report context_versions=2 retention",
      );
    } finally {
      await restore();
    }
  },
};

/** Store global config values, returning a function that puts the old ones back. */
async function setGlobalConfig(
  ctx: ScenarioContext,
  values: Record<string, string>,
): Promise<() => Promise<void>> {
  const previous: Array<{ key: string; value: string | null; id: string }> = [];
  for (const [key, value] of Object.entries(values)) {
    const listed = await ctx.api("GET", `/api/config?scope=global&key=${key}`);
    expectStatus(listed, [200], `read ${key}`);
    const before = asRecords(listed.json, "configs")[0];
    const stored = await ctx.api("PUT", "/api/config", { body: { scope: "global", key, value } });
    expectStatus(stored, [200], `set ${key}`);
    previous.push({
      key,
      value: before ? String(before.value) : null,
      id: asString(asRecord(stored.json).id, `${key} id`),
    });
  }
  return async () => {
    for (const { key, value, id } of previous) {
      const response =
        value === null
          ? await ctx.api("DELETE", `/api/config/${id}`)
          : await ctx.api("PUT", "/api/config", { body: { scope: "global", key, value } });
      expectStatus(response, [200, 204], `restore ${key}`);
    }
  };
}

/** An entry past its TTL reads as absent, leaves the list, and INCR restarts it. */
async function kvExpiry(ctx: ScenarioContext): Promise<void> {
  const agentId = await registerWorker(ctx, "retention-kv");
  const short = `ttl-short-${ctx.nonce}`;
  const long = `ttl-long-${ctx.nonce}`;
  const counter = `ttl-counter-${ctx.nonce}`;
  for (const [key, body] of [
    [short, { value: "gone soon", expiresInSec: 1 }],
    [long, { value: "stays", expiresInSec: 3600 }],
  ] as const) {
    expectStatus(await ctx.api("PUT", `/api/kv/${key}`, { agentId, body }), [200], `put ${key}`);
  }
  expectStatus(
    await ctx.api("PUT", `/api/kv/${counter}`, {
      agentId,
      body: { value: 40, valueType: "integer", expiresInSec: 1 },
    }),
    [200],
    "put an expiring counter",
  );
  const gone = async (key: string) =>
    (await ctx.api("GET", `/api/kv/${key}`, { agentId })).status === 404;
  const expired = await pollUntil(
    async () => (await gone(short)) && (await gone(counter)),
    8_000,
    200,
  );
  expect(expired, "the 1 s entries never expired");
  const live = await ctx.api("GET", `/api/kv/${long}`, { agentId });
  expectStatus(live, [200], "an unexpired entry stays");
  expect(asRecord(live.json).value === "stays", "the unexpired entry changed");
  const listed = await ctx.api("GET", `/api/kv?prefix=ttl-`, { agentId });
  expectStatus(listed, [200], "list after expiry");
  const keys = asRecords(listed.json, "entries").map((entry) => entry.key);
  expect(
    keys.includes(long) && !keys.includes(short) && !keys.includes(counter),
    `the list after expiry holds ${JSON.stringify(keys)}`,
  );
  const restarted = await ctx.api("POST", `/api/kv/${counter}/incr`, { agentId, body: { by: 2 } });
  expectStatus(restarted, [200], "incr an expired counter");
  expect(
    asRecord(restarted.json).value === 2 && asRecord(restarted.json).expiresAt == null,
    `incr over an expired entry gave ${restarted.text}`,
  );
}
