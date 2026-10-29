/**
 * A pool refresh or persist failure must never print a token. The OpenAI
 * token endpoint and the config store may echo the request body in an error
 * response; that text reaches console logs, the thrown error and, through
 * `buildPoolRevalidationFailureReason`, the task's failure reason.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetFetchForTesting, setFetchForTesting } from "../providers/codex-oauth/flow.js";
import { persistCodexOAuth, storeCodexOAuth } from "../providers/codex-oauth/storage.js";
import { loadChatgptSubscriptionCredential } from "../providers/codex-oauth/subscription.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";
import { isCodexAuthFailureReason } from "../utils/codex-auth-failure";

const API_URL = "http://localhost:3013";
const OLD_REFRESH = "rt_synthetic_pool_refresh_0123456789abcdef";
const NEW_ACCESS = "at_synthetic_rotated_access_0123456789abcdef";
const NEW_REFRESH = "rt_synthetic_rotated_refresh_0123456789abcdef";
const SECRETS = [OLD_REFRESH, NEW_ACCESS, NEW_REFRESH];
const CONFIG = { apiUrl: API_URL, apiKey: "test-key", codexSlot: 0, model: "openai-codex/gpt-5.5" };

const originalFetch = globalThis.fetch;
let logged: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

/** A transport error whose message echoes the request carrying the tokens. */
function rejectedPersist(): never {
  throw new TypeError(
    `fetch failed: socket closed while sending {"value":"{\\"access\\":\\"${NEW_ACCESS}\\",\\"refresh\\":\\"${NEW_REFRESH}\\"}"} (${encodeURIComponent(NEW_REFRESH)})`,
  );
}

/** Config store holding one expired slot; `putResponse` answers the persist. */
function installConfigStore(putResponse: () => Response): void {
  const creds: CodexOAuthCredentials = {
    access: "at_expired",
    refresh: OLD_REFRESH,
    expires: Date.now() - 1000,
    accountId: "acct-egress",
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (href.includes("/api/oauth/refresh-locks/")) {
      return Response.json(method === "POST" ? { owner: "owner-1" } : { released: true });
    }
    if (method === "GET" && href.includes("/api/config/resolved")) {
      return Response.json({ configs: [{ key: "codex_oauth_0", value: JSON.stringify(creds) }] });
    }
    if (method === "PUT" && href.includes("/api/config")) return putResponse();
    if (method === "DELETE" && href.includes("/api/config")) return Response.json({});
    throw new Error(`Unexpected fetch: ${method} ${href}`);
  }) as typeof fetch;
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a rejection");
}

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(encodeURIComponent(secret));
  }
}

beforeEach(() => {
  logged = [];
  for (const method of ["log", "error", "warn"] as const) {
    spies.push(
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" "));
      }),
    );
  }
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  globalThis.fetch = originalFetch;
  resetFetchForTesting();
});

describe("pool refresh failure egress", () => {
  test("a 401 echoing the submitted refresh token is redacted and still counts", async () => {
    installConfigStore(() => Response.json({}));
    setFetchForTesting((async (_url: string | URL | Request, init?: RequestInit) => {
      const form = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ error: "invalid_grant", echo: OLD_REFRESH, request: form }),
        { status: 401 },
      );
    }) as typeof fetch);

    const reason = await failureOf(loadChatgptSubscriptionCredential(CONFIG));

    expect(reason).toContain("refresh rejected (401");
    expect(reason).toContain("invalid_grant");
    expect(isCodexAuthFailureReason(reason)).toBe(true);
    expectNoSecret(reason);
    expect(logged.length).toBeGreaterThan(0);
    expectNoSecret(logged.join("\n"));
  });

  test("a refresh response missing fields never logs the tokens it did carry", async () => {
    installConfigStore(() => Response.json({}));
    setFetchForTesting((async () =>
      Response.json({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH })) as typeof fetch);

    const reason = await failureOf(loadChatgptSubscriptionCredential(CONFIG));

    expectNoSecret(reason);
    expectNoSecret(logged.join("\n"));
  });

  test("a persist failure echoing the rotated tokens is redacted and stays transient", async () => {
    installConfigStore(
      () => new Response(`rejected value ${NEW_ACCESS} ${NEW_REFRESH}`, { status: 500 }),
    );
    setFetchForTesting((async () =>
      Response.json({
        access_token: NEW_ACCESS,
        refresh_token: NEW_REFRESH,
        expires_in: 864000,
      })) as typeof fetch);

    const reason = await failureOf(loadChatgptSubscriptionCredential(CONFIG));

    expect(reason).toContain("HTTP 500");
    expect(isCodexAuthFailureReason(reason)).toBe(false);
    expectNoSecret(reason);
    expectNoSecret(logged.join("\n"));
  });

  test("a persist fetch rejection echoing the rotated tokens never reaches the reason or logs", async () => {
    installConfigStore(rejectedPersist);
    setFetchForTesting((async () =>
      Response.json({
        access_token: NEW_ACCESS,
        refresh_token: NEW_REFRESH,
        expires_in: 864000,
      })) as typeof fetch);

    const reason = await failureOf(loadChatgptSubscriptionCredential(CONFIG));

    expect(reason).toContain("Failed to store codex_oauth_0 config: fetch failed");
    expect(isCodexAuthFailureReason(reason)).toBe(false);
    expectNoSecret(reason);
    expectNoSecret(logged.join("\n"));
  });
});

describe("persist egress", () => {
  const rotated: CodexOAuthCredentials = {
    access: NEW_ACCESS,
    refresh: NEW_REFRESH,
    expires: Date.now() + 864000_000,
    accountId: "acct-egress",
  };

  test("storeCodexOAuth rethrows a fetch rejection with no token and no raw cause", async () => {
    globalThis.fetch = (async () => rejectedPersist()) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await storeCodexOAuth(API_URL, "test-key", rotated, 0);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toContain("fetch failed");
    expect(err.cause).toBeUndefined();
    expectNoSecret(Bun.inspect(err));
  });

  test("persistCodexOAuth logs a fetch rejection or an echoing response without tokens", async () => {
    globalThis.fetch = (async () => rejectedPersist()) as unknown as typeof fetch;
    await persistCodexOAuth(API_URL, "test-key", rotated, 0);
    globalThis.fetch = (async () =>
      new Response(`rejected value ${NEW_ACCESS} ${NEW_REFRESH}`, { status: 500 })) as typeof fetch;
    await persistCodexOAuth(API_URL, "test-key", rotated, 0);

    expect(logged.join("\n")).toContain("fetch failed");
    expect(logged.join("\n")).toContain("HTTP 500");
    expectNoSecret(logged.join("\n"));
  });
});
