import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// PR #2430: list, add and remove single credential-pool keys, with a provider check
// before save. Bogus keys on purpose: a provider 401 must reject the key and save nothing.
// A loopback baseUrl trips the API's SSRF guard, so the probe cannot answer and the key is
// saved as "not tested" (the PR's non-401 path) without a real provider key.
type PoolResponse = {
  key: string;
  source: string;
  readOnly: boolean;
  keys: { index: number; suffix: string; status: string }[];
  checks?: { suffix: string; result: string; httpStatus: number | null }[];
};

export const gapPoolKeys: Scenario = {
  name: "gap-pool-keys",
  order: 1000,
  async run(ctx) {
    const fullA = `sk-or-e2e-${ctx.nonce}-AAAAA`;
    const fullB = `sk-or-e2e-${ctx.nonce}-BBBBB`;
    const bogusAnthropic = `sk-ant-api03-e2e-${ctx.nonce}-ZZZZZ`;

    // Auth control.
    expectStatus(
      await ctx.api("GET", "/api/config/pool-keys?key=ANTHROPIC_API_KEY", { apiKey: null }),
      [401],
      "pool keys need credentials",
    );
    const empty = await ctx.api("GET", "/api/config/pool-keys?key=ANTHROPIC_API_KEY");
    expectStatus(empty, [200], "list empty pool");
    expect(
      (empty.json as PoolResponse).source === "none" &&
        (empty.json as PoolResponse).keys.length === 0,
      `fresh pool is empty: ${empty.text}`,
    );

    // Provider 401 -> 422, nothing saved.
    const rejected = await ctx.api("POST", "/api/config/pool-keys", {
      body: { key: "ANTHROPIC_API_KEY", value: bogusAnthropic },
    });
    expectStatus(rejected, [422], "bogus Anthropic key is rejected");
    const rejectedBody = asRecord(rejected.json);
    const checks = rejectedBody.checks as { result: string; httpStatus: number | null }[];
    expect(
      checks[0]?.result === "rejected" && checks[0]?.httpStatus === 401,
      `check result is rejected/401: ${rejected.text}`,
    );
    expect(!rejected.text.includes(bogusAnthropic), "422 body leaks the full key");
    const afterReject = await ctx.api("GET", "/api/config/pool-keys?key=ANTHROPIC_API_KEY");
    expect((afterReject.json as PoolResponse).keys.length === 0, "a rejected key was saved anyway");

    // Validation: spaces 400.
    expectStatus(
      await ctx.api("POST", "/api/config/pool-keys", {
        body: { key: "OPENROUTER_API_KEY", value: "has space", baseUrl: "http://127.0.0.1:9" },
      }),
      [400],
      "key with a space",
    );

    // Add two keys at once; loopback base URL is blocked by the SSRF guard -> not tested, saved.
    const added = await ctx.api("POST", "/api/config/pool-keys", {
      body: {
        key: "OPENROUTER_API_KEY",
        value: `${fullA}, ${fullB}`,
        baseUrl: "http://127.0.0.1:9",
      },
    });
    expectStatus(added, [200], "add two keys");
    const addedBody = added.json as PoolResponse;
    expect(addedBody.keys.length === 2, `pool has two keys: ${added.text}`);
    expect(
      addedBody.checks?.every((check) => check.result === "not_tested"),
      `checks are not_tested: ${JSON.stringify(addedBody.checks)}`,
    );
    expect(
      addedBody.keys[0]?.suffix === "AAAAA" && addedBody.keys[1]?.suffix === "BBBBB",
      `suffixes are the last 5 chars: ${added.text}`,
    );
    expect(!added.text.includes(fullA) && !added.text.includes(fullB), "add response leaks a key");
    const row = ctx.db.get<{ is_secret: number; value: string }>(
      "SELECT isSecret AS is_secret, value FROM swarm_config WHERE key = 'OPENROUTER_API_KEY' AND scope = 'global'",
    );
    expect(row?.is_secret === 1, "stored pool row is a secret");
    expect(!row?.value.includes(fullA), "secret pool row is stored in plaintext");

    const listed = await ctx.api("GET", "/api/config/pool-keys?key=OPENROUTER_API_KEY");
    expect(!listed.text.includes(fullA), "list leaks a full key");
    expect((listed.json as PoolResponse).keys.length === 2, "list shows both keys");

    // Duplicate -> 409.
    expectStatus(
      await ctx.api("POST", "/api/config/pool-keys", {
        body: { key: "OPENROUTER_API_KEY", value: fullA, baseUrl: "http://127.0.0.1:9" },
      }),
      [409],
      "duplicate key",
    );

    // Delete with a wrong suffix (list changed) -> 409; correct -> 200.
    expectStatus(
      await ctx.api("DELETE", "/api/config/pool-keys?key=OPENROUTER_API_KEY&index=0&suffix=ZZZZZ"),
      [409],
      "delete with a stale suffix",
    );
    const del = await ctx.api(
      "DELETE",
      "/api/config/pool-keys?key=OPENROUTER_API_KEY&index=0&suffix=AAAAA",
    );
    expectStatus(del, [200], "delete first key");
    const afterDel = del.json as PoolResponse;
    expect(
      afterDel.keys.length === 1 && afterDel.keys[0]?.suffix === "BBBBB",
      `only B remains: ${del.text}`,
    );
    const last = await ctx.api(
      "DELETE",
      "/api/config/pool-keys?key=OPENROUTER_API_KEY&index=0&suffix=BBBBB",
    );
    expectStatus(last, [200], "delete last key");
    expect((last.json as PoolResponse).source === "none", `empty pool is none: ${last.text}`);
    const gone = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM swarm_config WHERE key = 'OPENROUTER_API_KEY' AND scope = 'global'",
    );
    expect(gone?.n === 0, "pool row was removed with the last key");
  },
};
