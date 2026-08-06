import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PageSessionPayload } from "../utils/page-session";
import { parseCookieHeader, signPageSession, verifyPageSession } from "../utils/page-session";

const ORIGINAL_SECRET = process.env.PAGE_SESSION_SECRET;
const ORIGINAL_API_KEY = process.env.API_KEY;
const ORIGINAL_DATABASE_PATH = process.env.DATABASE_PATH;

/**
 * Replicates the page-session wire format (base64url(JSON payload) + "." +
 * base64url(HMAC-SHA256(payload, secret))) with an ATTACKER-CHOSEN secret —
 * used to simulate forging a cookie the way CWE-798 described (signing with
 * the known default API key) without going through the real `getSecret()`
 * resolution the module under test now uses.
 */
async function forgeToken(payload: PageSessionPayload, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = Buffer.from(sigBuf).toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

beforeAll(() => {
  process.env.PAGE_SESSION_SECRET = "test-secret-fixed-vector-key";
});

afterAll(() => {
  if (ORIGINAL_SECRET !== undefined) process.env.PAGE_SESSION_SECRET = ORIGINAL_SECRET;
  else delete process.env.PAGE_SESSION_SECRET;
  if (ORIGINAL_API_KEY !== undefined) process.env.API_KEY = ORIGINAL_API_KEY;
  else delete process.env.API_KEY;
  if (ORIGINAL_DATABASE_PATH !== undefined) process.env.DATABASE_PATH = ORIGINAL_DATABASE_PATH;
  else delete process.env.DATABASE_PATH;
});

describe("page-session HMAC helpers", () => {
  test("sign produces deterministic output for fixed payload + secret", async () => {
    const payload = { pageId: "deadbeefcafef00d", exp: 1893456000 };
    const a = await signPageSession(payload);
    const b = await signPageSession(payload);
    expect(a).toBe(b);
    // Shape: two base64url parts joined by `.`, no padding `=`.
    expect(a).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test("round-trip: verify returns the original payload", async () => {
    const payload = { pageId: "abc123", exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = await signPageSession(payload);
    const got = await verifyPageSession(token);
    expect(got).toEqual(payload);
  });

  test("expired token (exp in the past) returns null", async () => {
    const payload = { pageId: "abc123", exp: Math.floor(Date.now() / 1000) - 1 };
    const token = await signPageSession(payload);
    const got = await verifyPageSession(token);
    expect(got).toBeNull();
  });

  test("tampered payload returns null", async () => {
    const payload = { pageId: "abc123", exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = await signPageSession(payload);
    const [head, sig] = token.split(".");
    // Re-encode a different payload with the SAME signature — must fail.
    const evil = Buffer.from(JSON.stringify({ pageId: "evil", exp: payload.exp }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(head).toBeDefined();
    const tampered = `${evil}.${sig}`;
    expect(await verifyPageSession(tampered)).toBeNull();
  });

  test("tampered signature (single-bit flip) returns null", async () => {
    const payload = { pageId: "abc123", exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = await signPageSession(payload);
    const [head, sig] = token.split(".");
    expect(sig).toBeDefined();
    // Flip a decoded HMAC byte rather than a base64url character. Flipping the
    // last *character* is flaky: for a 32-byte (SHA-256) HMAC the final base64url
    // char encodes 4 real bits + 2 LSB padding zeros, so "A"→"B" only toggles a
    // padding bit and the decoded HMAC is unchanged (~1/16 probability), causing
    // the verifier to incorrectly accept the token. Operating on decoded bytes is
    // deterministic and still produces a same-length re-encoded token, exercising
    // the constant-time compare branch (not the length-mismatch early-return).
    const sigBytes = Buffer.from(sig!, "base64url");
    sigBytes[0] ^= 0x01;
    const tamperedSig = sigBytes.toString("base64url").replace(/=/g, "");
    const tampered = `${head}.${tamperedSig}`;
    expect(await verifyPageSession(tampered)).toBeNull();
  });

  test("malformed token (no dot) returns null", async () => {
    expect(await verifyPageSession("not-a-token")).toBeNull();
  });

  test("empty / null / undefined token returns null", async () => {
    expect(await verifyPageSession("")).toBeNull();
    expect(await verifyPageSession(null)).toBeNull();
    expect(await verifyPageSession(undefined)).toBeNull();
  });

  test("token signed with different secret is rejected", async () => {
    const payload = { pageId: "abc123", exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = await signPageSession(payload);

    process.env.PAGE_SESSION_SECRET = "different-secret-after-rotation";
    try {
      const got = await verifyPageSession(token);
      expect(got).toBeNull();
    } finally {
      process.env.PAGE_SESSION_SECRET = "test-secret-fixed-vector-key";
    }
  });

  // Regression coverage for CWE-798 (critical-666a794a): `getSecret()` used to
  // fall back to `getApiKey()` when PAGE_SESSION_SECRET was unset, and the
  // swarm API key's documented default is the public value `123123` — so a
  // default install signed page-session cookies with a value anyone could
  // guess. The fix removes that fallback entirely in favor of an
  // auto-generated, persisted-to-disk secret (mirrors `key-bootstrap.ts`).
  describe("CWE-798 fix: no silent API-key inheritance", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(path.join(tmpdir(), "page-session-secret-test-"));
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    // Must-reject: a cookie forged with the API key (default "123123", the
    // exact CWE-798 attack) must NOT verify once PAGE_SESSION_SECRET is unset.
    test("a cookie forged with the (default) API key does not verify", async () => {
      delete process.env.PAGE_SESSION_SECRET;
      process.env.DATABASE_PATH = path.join(tmpDir, "reject-case", "db.sqlite");
      process.env.API_KEY = "123123";
      try {
        const payload = { pageId: "forged", exp: Math.floor(Date.now() / 1000) + 3600 };
        const forged = await forgeToken(payload, "123123");
        expect(await verifyPageSession(forged)).toBeNull();
      } finally {
        process.env.PAGE_SESSION_SECRET = "test-secret-fixed-vector-key";
      }
    });

    // Positive path: signing/verifying still works end-to-end when
    // PAGE_SESSION_SECRET is unset — a distinct secret is generated and
    // persisted to disk on first use instead of refusing to operate or
    // reusing the API key.
    test("generates and persists a distinct secret, and sign/verify still round-trips", async () => {
      delete process.env.PAGE_SESSION_SECRET;
      const dbDir = path.join(tmpDir, "generate-case");
      process.env.DATABASE_PATH = path.join(dbDir, "db.sqlite");
      process.env.API_KEY = "123123";
      try {
        const payload = { pageId: "generated", exp: Math.floor(Date.now() / 1000) + 3600 };
        const token = await signPageSession(payload);
        expect(await verifyPageSession(token)).toEqual(payload);

        const secretFile = path.join(dbDir, ".page-session-secret");
        expect(existsSync(secretFile)).toBe(true);

        // The generated secret must not equal the (forgeable) API key — a
        // token forged with "123123" still must not verify post-generation.
        const forged = await forgeToken(payload, "123123");
        expect(await verifyPageSession(forged)).toBeNull();

        // Idempotent across calls within the same process: a second sign
        // against the same DATABASE_PATH reuses the persisted file, so a
        // token from the first call still verifies.
        const token2 = await signPageSession({ ...payload, pageId: "generated-2" });
        expect(await verifyPageSession(token2)).toEqual({ ...payload, pageId: "generated-2" });
        expect(await verifyPageSession(token)).toEqual(payload);
      } finally {
        process.env.PAGE_SESSION_SECRET = "test-secret-fixed-vector-key";
      }
    });
  });

  test("known-vector regression: payload {pageId:'abc',exp:1893456000} with secret 'test-secret-fixed-vector-key' verifies", async () => {
    const payload = { pageId: "abc", exp: 1893456000 };
    const token = await signPageSession(payload);
    // We don't pin the exact bytes here (Buffer base64url ordering is stable
    // but the test value would be brittle to refactor); instead we re-verify
    // and check the payload survives the round-trip — this exercises the
    // full sign+verify pipeline against a known vector.
    expect(await verifyPageSession(token)).toEqual(payload);
  });
});

describe("parseCookieHeader", () => {
  test("returns undefined when header is absent", () => {
    expect(parseCookieHeader(undefined, "page_session")).toBeUndefined();
    expect(parseCookieHeader("", "page_session")).toBeUndefined();
  });

  test("parses a single cookie", () => {
    expect(parseCookieHeader("page_session=abc.def", "page_session")).toBe("abc.def");
  });

  test("parses one cookie among many", () => {
    const header = "foo=1; page_session=abc.def; bar=2";
    expect(parseCookieHeader(header, "page_session")).toBe("abc.def");
  });

  test("returns first match when duplicate cookies present", () => {
    const header = "page_session=first; page_session=second";
    expect(parseCookieHeader(header, "page_session")).toBe("first");
  });

  test("handles array headers (Node's http types allow string[])", () => {
    expect(parseCookieHeader(["page_session=array-value"], "page_session")).toBe("array-value");
  });

  test("returns undefined when target cookie not in header", () => {
    expect(parseCookieHeader("foo=1; bar=2", "page_session")).toBeUndefined();
  });

  test("does NOT match a cookie whose name is a suffix of another", () => {
    // `xxpage_session=evil` must not be returned for name `page_session`.
    expect(parseCookieHeader("xxpage_session=evil; other=ok", "page_session")).toBeUndefined();
  });
});
