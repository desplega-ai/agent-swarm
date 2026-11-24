import { sql } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { Cleanup, retireAgent } from "./platformb-helpers";

/** A high slot index that no other scenario seeds. */
const SLOT = 97;
const KEY = `codex_oauth_${SLOT}`;
const SLOT_PATH = `/api/codex-oauth/slots/${SLOT}/credentials`;
const LOCK_PATH = `/api/oauth/refresh-locks/${KEY}`;

async function registerWorkerWithToken(ctx: ScenarioContext): Promise<{ id: string; token: string }> {
  const created = await ctx.api("POST", "/api/agents", {
    body: { name: `zz-codex-slot-${ctx.nonce}`, role: "worker", status: "online" },
  });
  expectStatus(created, [201], "register worker");
  const id = asString(asRecord(created.json).id, "worker id");
  const minted = await ctx.api("POST", `/api/agents/${id}/token`, { body: {} });
  expectStatus(minted, [200], "mint worker token");
  return { id, token: asString(asRecord(minted.json).plaintext, "worker token") };
}

/**
 * A Codex worker refreshes a pool slot under its refresh lock and must persist the rotated
 * tokens with its own agent key. `PUT /api/config` stays lead-only for agents (it refuses the
 * same write, and any other key), so the worker goes through
 * `PUT /api/codex-oauth/slots/{slot}/credentials`. That route writes only `codex_oauth_<slot>`
 * and only for the caller holding the slot's lock; the quarantine DELETE follows the same rule.
 */
export const platformCodexOAuthSlotStore: Scenario = {
  name: "platform-codex-oauth-slot-store",
  order: 635.5,
  async run(ctx) {
    const cleanup = new Cleanup();
    let worker: { id: string; token: string } | undefined;
    cleanup.add("retire worker", async () => {
      if (!worker) return;
      await ctx.api("DELETE", `/api/agents/${worker.id}/token`).catch(() => undefined);
      await retireAgent(ctx, worker.id);
    });
    cleanup.add(`delete ${KEY}`, async () => {
      const rows = ctx.db.query<{ id: string }>(
        sql`SELECT id FROM swarm_config WHERE key = ${KEY} AND scope = 'global'`,
      );
      for (const row of rows) await ctx.api("DELETE", `/api/config/${row.id}`);
    });

    await cleanup.around(async () => {
      const original = {
        access: `e2e-at-old-${ctx.nonce}`,
        refresh: `e2e-rt-old-${ctx.nonce}`,
        expires: Date.now() + 60_000,
        accountId: `e2e-acct-${ctx.nonce}`,
      };
      const refreshed = {
        ...original,
        access: `e2e-at-new-${ctx.nonce}`,
        refresh: `e2e-rt-new-${ctx.nonce}`,
        expires: Date.now() + 10 * 24 * 60 * 60 * 1000,
      };
      const stored = async () => {
        const resolved = await ctx.api(
          "GET",
          `/api/config/resolved?includeSecrets=true&key=${KEY}`,
        );
        expectStatus(resolved, [200], "operator reads the slot");
        const configs = asRecord(resolved.json).configs as Array<{ value: string }>;
        return configs[0] ? (JSON.parse(configs[0].value) as typeof original) : null;
      };

      // The operator seeds the slot the way codex-login does.
      expectStatus(
        await ctx.api("PUT", "/api/config", {
          body: { scope: "global", key: KEY, value: JSON.stringify(original), isSecret: true },
        }),
        [200],
        "operator seeds the slot",
      );

      worker = await registerWorkerWithToken(ctx);
      const asWorker = { apiKey: worker.token };

      // ── the general config write stays lead-only for a worker token ───────
      for (const key of [KEY, `E2E_CODEX_SLOT_OTHER_${ctx.nonce.toUpperCase()}`]) {
        const refused = await ctx.api("PUT", "/api/config", {
          ...asWorker,
          body: { scope: "global", key, value: "x" },
        });
        expectStatus(refused, [403], `worker writes ${key} through PUT /api/config`);
        expect(
          String(asRecord(refused.json).error).includes("requires the lead agent"),
          "the PUT /api/config refusal changed",
        );
      }

      // ── auth, validation and the lock precondition ─────────────────────────
      const body = (lockOwner: string) => ({ lockOwner, credentials: refreshed });
      expectStatus(
        await ctx.api("PUT", SLOT_PATH, { apiKey: null, body: body("x") }),
        [401],
        "store unauth",
      );
      expectStatus(
        await ctx.api("PUT", `/api/codex-oauth/slots/101/credentials`, {
          ...asWorker,
          body: body("x"),
        }),
        [400],
        "slot above the pool maximum",
      );
      expectStatus(
        await ctx.api("PUT", `/api/codex-oauth/slots/OTHER_KEY/credentials`, {
          ...asWorker,
          body: body("x"),
        }),
        [400],
        "a non-numeric slot",
      );
      expectStatus(
        await ctx.api("PUT", SLOT_PATH, {
          ...asWorker,
          body: { lockOwner: "x", credentials: { access: "a" } },
        }),
        [400],
        "incomplete credentials",
      );
      const unlocked = await ctx.api("PUT", SLOT_PATH, { ...asWorker, body: body("no-lock") });
      expectStatus(unlocked, [409], "store without holding the lock");
      expect((await stored())?.access === original.access, "an unlocked store changed the slot");

      // ── the worker takes the lock and persists the refreshed slot ──────────
      const lock = await ctx.api("POST", LOCK_PATH, { ...asWorker, body: { ttlMs: 60_000 } });
      expectStatus(lock, [200], "worker takes the slot lock");
      const owner = asString(asRecord(lock.json).owner, "lock owner");
      expectStatus(
        await ctx.api("PUT", SLOT_PATH, { ...asWorker, body: body("someone-else") }),
        [409],
        "store with another caller's owner token",
      );
      const ok = await ctx.api("PUT", SLOT_PATH, { ...asWorker, body: body(owner) });
      expectStatus(ok, [200], "worker stores the refreshed slot");
      expect(
        asRecord(ok.json).key === KEY && !ok.text.includes(refreshed.access),
        "the store response names the key and echoes no token",
      );
      const after = await stored();
      expect(
        after?.access === refreshed.access && after.refresh === refreshed.refresh,
        "the refreshed tokens did not land",
      );
      const row = ctx.db.get<{ encrypted: number; isSecret: number }>(
        sql`SELECT encrypted, "isSecret" FROM swarm_config WHERE key = ${KEY} AND scope = 'global'`,
      );
      expect(Number(row?.isSecret) === 1 && Number(row?.encrypted) === 1, "slot row is not a secret");

      // ── quarantine follows the same lock rule ──────────────────────────────
      expectStatus(
        await ctx.api("DELETE", SLOT_PATH, { ...asWorker, body: { lockOwner: "someone-else" } }),
        [409],
        "quarantine with another caller's owner token",
      );
      const quarantined = await ctx.api("DELETE", SLOT_PATH, {
        ...asWorker,
        body: { lockOwner: owner },
      });
      expectStatus(quarantined, [200], "worker quarantines the slot");
      expect(asRecord(quarantined.json).deleted === true, "quarantine did not report the delete");
      expect((await stored()) === null, "the quarantined slot is still readable");

      // ── a released lock no longer authorizes a write ───────────────────────
      expectStatus(
        await ctx.api("DELETE", LOCK_PATH, { ...asWorker, body: { owner } }),
        [204],
        "worker releases the lock",
      );
      expectStatus(
        await ctx.api("PUT", SLOT_PATH, { ...asWorker, body: body(owner) }),
        [409],
        "store after the lock was released",
      );
      expect((await stored()) === null, "a store after release recreated the slot");
    });
  },
};
