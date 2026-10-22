import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { resetBitbucketBotCache, resolveBitbucketBotAccountId } from "../bitbucket/api";
import {
  getBitbucketToken,
  initBitbucket,
  isBitbucketEnabled,
  resetBitbucket,
  verifyBitbucketWebhook,
} from "../bitbucket/auth";

const ENV_KEYS = [
  "BITBUCKET_WEBHOOK_SECRET",
  "BITBUCKET_TOKEN",
  "BITBUCKET_DISABLE",
  "BITBUCKET_BOT_ACCOUNT_ID",
] as const;

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetBitbucket();
  resetBitbucketBotCache();
});

describe("isBitbucketEnabled", () => {
  test("disabled without a webhook secret", () => {
    expect(isBitbucketEnabled()).toBe(false);
  });

  test("enabled with a webhook secret", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    expect(isBitbucketEnabled()).toBe(true);
  });

  test("BITBUCKET_DISABLE wins over the secret", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    process.env.BITBUCKET_DISABLE = "true";
    expect(isBitbucketEnabled()).toBe(false);
  });
});

describe("verifyBitbucketWebhook", () => {
  test("matches Atlassian's documented test vector", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "It's a Secret to Everybody";
    initBitbucket();
    expect(
      verifyBitbucketWebhook(
        "Hello World!",
        "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
      ),
    ).toBe(true);
  });

  test("rejects a signature made with the wrong secret", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    initBitbucket();
    expect(verifyBitbucketWebhook("{}", sign("other-secret", "{}"))).toBe(false);
    expect(verifyBitbucketWebhook("{}", sign("example-secret", "{}"))).toBe(true);
  });

  test("rejects a tampered body", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    initBitbucket();
    expect(verifyBitbucketWebhook('{"a":2}', sign("example-secret", '{"a":1}'))).toBe(false);
  });

  test("rejects a missing header", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    initBitbucket();
    expect(verifyBitbucketWebhook("{}", undefined)).toBe(false);
  });

  test("rejects a bare hex digest without the sha256= prefix", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    initBitbucket();
    const bare = sign("example-secret", "{}").slice("sha256=".length);
    expect(verifyBitbucketWebhook("{}", bare)).toBe(false);
  });

  test("rejects everything before init and after reset", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    const sig = sign("example-secret", "{}");
    expect(verifyBitbucketWebhook("{}", sig)).toBe(false);
    initBitbucket();
    expect(verifyBitbucketWebhook("{}", sig)).toBe(true);
    resetBitbucket();
    expect(verifyBitbucketWebhook("{}", sig)).toBe(false);
  });
});

describe("initBitbucket", () => {
  test("does not initialize when disabled", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    process.env.BITBUCKET_TOKEN = "example-token";
    process.env.BITBUCKET_DISABLE = "true";
    initBitbucket();
    expect(getBitbucketToken()).toBeNull();
  });

  test("loads the API token", () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    process.env.BITBUCKET_TOKEN = "example-token";
    initBitbucket();
    expect(getBitbucketToken()).toBe("example-token");
  });
});

describe("resolveBitbucketBotAccountId", () => {
  test("prefers BITBUCKET_BOT_ACCOUNT_ID", async () => {
    process.env.BITBUCKET_BOT_ACCOUNT_ID = "557058:env-bot";
    expect(await resolveBitbucketBotAccountId()).toBe("557058:env-bot");
  });

  test("returns null without a token", async () => {
    expect(await resolveBitbucketBotAccountId()).toBeNull();
  });

  test("resolves GET /user with a Bearer token and caches it", async () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    process.env.BITBUCKET_TOKEN = "example-token";
    initBitbucket();
    const calls: Array<{ url: string; auth?: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(input), auth: headers.Authorization });
      return new Response(JSON.stringify({ account_id: "557058:api-bot" }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await resolveBitbucketBotAccountId()).toBe("557058:api-bot");
      expect(await resolveBitbucketBotAccountId()).toBe("557058:api-bot");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual([
      { url: "https://api.bitbucket.org/2.0/user", auth: "Bearer example-token" },
    ]);
  });

  test("returns null on a failed lookup", async () => {
    process.env.BITBUCKET_WEBHOOK_SECRET = "example-secret";
    process.env.BITBUCKET_TOKEN = "example-token";
    initBitbucket();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    try {
      expect(await resolveBitbucketBotAccountId()).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
