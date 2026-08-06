/**
 * Regression coverage for GitHub issue #1102 bug 1: the Codex boot gate
 * (`checkCodexCredentials` in codex-adapter.ts) and the runtime credential
 * pool disagreed on what counts as a usable credential.
 *
 * Root cause: `resolveCodexOAuthCredentialInfo` (runner.ts) falls back to a
 * standalone `~/.codex/auth.json` when the config store has zero
 * `codex_oauth_<n>` slots. That fallback calls
 * `authJsonToCredentialSelection(auth)` with its default `slot = 0` — pure
 * bookkeeping, since there is no real pool slot. The call site used to read
 * that `.index` straight into `ProviderSessionConfig.codexSlot`, which flips
 * `resolveCodexAuthMode` (codex-adapter.ts) into strict pool-revalidation
 * mode: it re-reads `codex_oauth_0` from the config store, finds nothing,
 * and throws `"[auth-error] Codex pool slot 0 revalidation failed: no
 * credentials found in config store"` — on every single task, despite the
 * worker's own auth.json being perfectly valid.
 *
 * The fix threads an explicit `isPoolBacked` flag through
 * `resolveCodexOAuthCredentialInfo`'s return value so only a REAL
 * `codex_oauth_<n>` config-store slot can ever set `codexSlot` downstream.
 * This test proves the flag is `false` for the standalone-auth.json
 * fallback and `true` for the real pool path, using the actual (now
 * exported) runner function rather than a hand-written replica that could
 * drift from the real implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexOAuthCredentialInfo } from "../commands/runner";

const MOCK_API_URL = "http://localhost:3013";
const MOCK_API_KEY = "test-api-key";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "codex-oauth-credential-info-"));
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.env.HOME = originalHome;
  await rm(tmpHome, { recursive: true, force: true });
});

/** Mock `/api/config/resolved` with zero codex_oauth_<n> slots. */
function mockEmptyConfigStore(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ configs: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

async function writeStandaloneAuthJson(): Promise<void> {
  const codexHome = join(tmpHome, ".codex");
  await Bun.write(
    join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "id-standalone",
        access_token: "access-standalone",
        refresh_token: "refresh-standalone",
        account_id: "acct-standalone",
      },
      last_refresh: new Date().toISOString(),
    }),
  );
}

describe("resolveCodexOAuthCredentialInfo — issue #1102 bug 1", () => {
  it("is NOT pool-backed for a standalone auth.json when the config store has zero slots", async () => {
    mockEmptyConfigStore();
    await writeStandaloneAuthJson();

    const info = await resolveCodexOAuthCredentialInfo(MOCK_API_URL, MOCK_API_KEY);

    expect(info).not.toBeNull();
    expect(info!.isPoolBacked).toBe(false);
    // The `.index` is bookkeeping-only for the standalone path (always 0),
    // which is exactly why callers must gate on `isPoolBacked` before ever
    // reading it as a real `codex_oauth_<n>` slot.
    expect(info!.selection.index).toBe(0);
    expect(info!.selection.keyType).toBe("CODEX_OAUTH");
  });

  it("returns null when the config store is empty and there is no auth.json", async () => {
    mockEmptyConfigStore();
    // No auth.json written — worker has no codex credential at all.

    const info = await resolveCodexOAuthCredentialInfo(MOCK_API_URL, MOCK_API_KEY);

    expect(info).toBeNull();
  });

  it("returns null when auth.json exists but is not in chatgpt mode (api-key auth)", async () => {
    mockEmptyConfigStore();
    const codexHome = join(tmpHome, ".codex");
    await Bun.write(
      join(codexHome, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }),
    );

    const info = await resolveCodexOAuthCredentialInfo(MOCK_API_URL, MOCK_API_KEY);

    expect(info).toBeNull();
  });

  it("IS pool-backed when the config store has a real codex_oauth_0 slot", async () => {
    const FUTURE = Date.now() + 3_600_000;
    const creds = {
      access:
        "header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjLXBvb2wifX0=.sig",
      refresh: "rt_pool",
      expires: FUTURE,
      accountId: "acc-pool",
    };
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("/api/config/resolved")) {
        return new Response(
          JSON.stringify({ configs: [{ key: "codex_oauth_0", value: JSON.stringify(creds) }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (href.includes("/api/keys/available")) {
        return new Response(JSON.stringify({ availableIndices: [0] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const info = await resolveCodexOAuthCredentialInfo(MOCK_API_URL, MOCK_API_KEY);

    expect(info).not.toBeNull();
    expect(info!.isPoolBacked).toBe(true);
    expect(info!.selection.index).toBe(0);
    expect(info!.selection.total).toBe(1);
  });
});
