/**
 * E2E integration tests for the Codex OAuth multi-credential pool (CAI-1280).
 *
 * These tests cover the full round-trip that the runner assembles at task-spawn
 * time and are intentionally focused on the *integration* between the storage
 * layer, the availability-filter, and the materialise-to-disk step — not on
 * the individual function contracts that the unit-test files already cover
 * (codex-oauth-storage.test.ts, codex-oauth-auth-json-fs.test.ts,
 * codex-oauth-adapter.test.ts).
 *
 * Three scenarios:
 *   1. Normal selection — slots 1 + 2 available, slot 0 rate-limited → only
 *      one of slots 1/2 is materialised into auth.json.
 *   2. Refresh-back slot isolation — after picking slot 2, token refresh must
 *      write back to `codex_oauth_2`, NOT to slot 0 or the legacy key.
 *   3. Exhaustion — all three slots rate-limited → runner falls back to
 *      random best-effort selection and still materialises *some* slot's
 *      creds (does not return null / abort the spawn).
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  authJsonToCredentialSelection,
  credentialsToAuthJson,
} from "../providers/codex-oauth/auth-json.js";
import { materializeCodexAuthJson } from "../providers/codex-oauth/auth-json-fs.js";
import { loadAllCodexOAuthSlots, persistCodexOAuth } from "../providers/codex-oauth/storage.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_API_URL = "http://localhost:3013";
const MOCK_API_KEY = "test-api-key";
const FUTURE = Date.now() + 3_600_000;

function makeJwt(userId: string, accountId: string): string {
  const payload = {
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
    },
  };
  return `header.${btoa(JSON.stringify(payload))}.signature`;
}

function makeCreds(suffix: string): CodexOAuthCredentials {
  return {
    access: makeJwt(`user-${suffix}`, `acc-${suffix}`),
    refresh: `rt_${suffix}`,
    expires: FUTURE,
    accountId: `acc-${suffix}`,
  };
}

const slotCreds: Record<number, CodexOAuthCredentials> = {
  0: makeCreds("slot0"),
  1: makeCreds("slot1"),
  2: makeCreds("slot2"),
};

/**
 * Build a mock config-store GET response containing the three credential slots.
 * Mirrors the shape `loadAllCodexOAuthSlots` and `loadCodexOAuth` parse.
 */
function makeConfigResponse(slots: number[] = [0, 1, 2]): Response {
  return new Response(
    JSON.stringify({
      configs: slots.map((s) => ({
        id: `cfg-${s}`,
        key: `codex_oauth_${s}`,
        value: JSON.stringify(slotCreds[s]),
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Replicate the runner's slot-selection algorithm (runner.ts ~line 830-895)
 * so tests can exercise the full chain without importing the unexported
 * `resolveCodexOAuthCredentialInfo` function.
 *
 * Returns `{ selectedSlot, slotEntry }`.
 */
async function runnerSlotSelection(
  slots: Array<{ slot: number; creds: CodexOAuthCredentials }>,
  availableIndices: number[] | undefined,
): Promise<{ selectedSlot: number; slotEntry: { slot: number; creds: CodexOAuthCredentials } }> {
  const allSlotIndices = slots.map((s) => s.slot);
  let selectedSlot: number;

  if (availableIndices && availableIndices.length > 0) {
    const eligible = allSlotIndices.filter((i) => availableIndices.includes(i));
    const pool = eligible.length > 0 ? eligible : allSlotIndices;
    selectedSlot = pool[Math.floor(Math.random() * pool.length)]!;
  } else {
    // No availability info OR all rate-limited — pick randomly (best effort).
    selectedSlot = allSlotIndices[Math.floor(Math.random() * allSlotIndices.length)]!;
  }

  const slotEntry = slots.find((s) => s.slot === selectedSlot)!;
  return { selectedSlot, slotEntry };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Scenario 1: Normal slot selection with availability filter ───────────────

describe("Scenario 1 — 3-slot round-trip with availability filter", () => {
  it("selects from available slots [1,2] and materialises the correct creds into auth.json", async () => {
    // Mock API: three slots in config store.
    globalThis.fetch = async (_url: string | URL | Request) => {
      return makeConfigResponse();
      // (available-indices endpoint not called by loadAllCodexOAuthSlots)
    };

    const slots = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);
    expect(slots).toHaveLength(3);

    // Simulate the runner calling /api/keys/available → [1, 2] (slot 0 rate-limited).
    const availableIndices = [1, 2];
    const { selectedSlot, slotEntry } = await runnerSlotSelection(slots, availableIndices);

    // Must NOT pick the rate-limited slot 0.
    expect(availableIndices).toContain(selectedSlot);
    expect(selectedSlot).not.toBe(0);

    // Materialise auth.json with an injected fs so we can inspect the write.
    let writtenContent = "";
    let writtenPath = "";
    await materializeCodexAuthJson(selectedSlot, slotEntry.creds, {
      homedir: () => "/home/testworker",
      fs: {
        mkdir: async () => undefined,
        writeFile: async (path, data) => {
          writtenPath = path;
          writtenContent = data;
        },
        rename: async () => {},
      },
    });

    // The tmp file is written (atomic pattern).
    expect(writtenPath).toBe("/home/testworker/.codex/auth.json.tmp");

    // auth.json content must reflect the SELECTED slot's credentials.
    const parsed = JSON.parse(writtenContent) as {
      auth_mode: string;
      tokens: { access_token: string; refresh_token: string; account_id: string };
    };
    expect(parsed.auth_mode).toBe("chatgpt");
    expect(parsed.tokens.access_token).toBe(slotEntry.creds.access);
    expect(parsed.tokens.account_id).toBe(slotEntry.creds.accountId);

    // Verify it is definitely NOT slot 0's creds.
    expect(parsed.tokens.access_token).not.toBe(slotCreds[0]!.access);
  });

  it("builds a CredentialSelection with the correct slot index", async () => {
    globalThis.fetch = async () => makeConfigResponse();
    const slots = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);

    const { selectedSlot, slotEntry } = await runnerSlotSelection(slots, [1, 2]);

    const authJson = credentialsToAuthJson(slotEntry.creds);
    const sel = authJsonToCredentialSelection(authJson, selectedSlot, slots.length);

    expect(sel.index).toBe(selectedSlot);
    expect(sel.total).toBe(3);
    expect(sel.keyType).toBe("CODEX_OAUTH");
    // keySuffix is derived from chatgpt_user_id (slot-unique), not accountId.
    const expectedUserId = `user-slot${selectedSlot}`;
    expect(sel.keySuffix).toBe(expectedUserId.slice(-5));
  });
});

// ─── Scenario 2: Refresh-back writes to the picked slot, not slot 0 ──────────

describe("Scenario 2 — refresh-back slot isolation", () => {
  it("persists refreshed credentials to codex_oauth_2, not codex_oauth_0 or legacy", async () => {
    const capturedPuts: Array<{ key: string; value: unknown }> = [];

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        const body = JSON.parse(init!.body as string) as { key: string; value: unknown };
        capturedPuts.push({ key: body.key, value: body.value });
      }
      return new Response(JSON.stringify({ id: "cfg-ok" }), { status: 200 });
    };

    const refreshedCreds: CodexOAuthCredentials = {
      access: "at_refreshed",
      refresh: "rt_refreshed",
      expires: FUTURE,
      accountId: slotCreds[2]!.accountId,
    };

    // Simulate the adapter calling persistCodexOAuth after a token rotation
    // with the slot that the runner passed in config.codexSlot.
    const pickedSlot = 2;
    await persistCodexOAuth(MOCK_API_URL, MOCK_API_KEY, refreshedCreds, pickedSlot);

    expect(capturedPuts).toHaveLength(1);
    const put = capturedPuts[0]!;

    // Must write to slot 2's key.
    expect(put.key).toBe("codex_oauth_2");
    // Must NOT write to slot 0 or the legacy key.
    expect(put.key).not.toBe("codex_oauth_0");
    expect(put.key).not.toBe("codex_oauth");

    // The written value must be the refreshed creds.
    const stored = JSON.parse(put.value as string) as CodexOAuthCredentials;
    expect(stored.access).toBe("at_refreshed");
    expect(stored.refresh).toBe("rt_refreshed");
  });

  it("refresh-back for slot 1 writes to codex_oauth_1", async () => {
    const capturedKeys: string[] = [];

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        const body = JSON.parse(init!.body as string) as { key: string };
        capturedKeys.push(body.key);
      }
      return new Response(JSON.stringify({ id: "cfg-ok" }), { status: 200 });
    };

    await persistCodexOAuth(MOCK_API_URL, MOCK_API_KEY, makeCreds("slot1-refreshed"), 1);

    expect(capturedKeys).toEqual(["codex_oauth_1"]);
  });
});

// ─── Scenario 3: All slots rate-limited — runner falls back to random pick ────

describe("Scenario 3 — slot exhaustion (all rate-limited)", () => {
  it("returns a valid slot when availableIndices is empty (best-effort random pick)", async () => {
    globalThis.fetch = async () => makeConfigResponse();
    const slots = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);
    expect(slots).toHaveLength(3);

    // availableIndices = [] simulates /api/keys/available responding that
    // all 3 slots are currently rate-limited.
    const availableIndices: number[] = [];
    const { selectedSlot, slotEntry } = await runnerSlotSelection(slots, availableIndices);

    // Runner picks randomly — must be one of the three known slots.
    expect([0, 1, 2]).toContain(selectedSlot);
    expect(slotEntry).toBeDefined();
    expect(slotEntry.creds).toBeDefined();
  });

  it("materialises auth.json even when all slots are rate-limited", async () => {
    globalThis.fetch = async () => makeConfigResponse();
    const slots = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);

    const { selectedSlot, slotEntry } = await runnerSlotSelection(slots, []);

    let materialised = false;
    await materializeCodexAuthJson(selectedSlot, slotEntry.creds, {
      homedir: () => "/home/testworker",
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => {
          materialised = true;
        },
        rename: async () => {},
      },
    });

    // The runner does NOT abort the spawn when all slots are exhausted —
    // it materialises a randomly-chosen slot and lets the task attempt proceed.
    expect(materialised).toBe(true);
  });

  it("does not select a slot outside the 3-slot pool", async () => {
    globalThis.fetch = async () => makeConfigResponse();
    const slots = await loadAllCodexOAuthSlots(MOCK_API_URL, MOCK_API_KEY);

    // Run selection 20 times; with 3 slots any out-of-range pick would be a bug.
    for (let i = 0; i < 20; i++) {
      const { selectedSlot } = await runnerSlotSelection(slots, []);
      expect([0, 1, 2]).toContain(selectedSlot);
    }
  });
});
