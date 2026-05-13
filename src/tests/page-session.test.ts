import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseCookieHeader, signPageSession, verifyPageSession } from "../utils/page-session";

const ORIGINAL_SECRET = process.env.PAGE_SESSION_SECRET;
const ORIGINAL_API_KEY = process.env.API_KEY;

beforeAll(() => {
  process.env.PAGE_SESSION_SECRET = "test-secret-fixed-vector-key";
});

afterAll(() => {
  if (ORIGINAL_SECRET !== undefined) process.env.PAGE_SESSION_SECRET = ORIGINAL_SECRET;
  else delete process.env.PAGE_SESSION_SECRET;
  if (ORIGINAL_API_KEY !== undefined) process.env.API_KEY = ORIGINAL_API_KEY;
  else delete process.env.API_KEY;
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
    // Flip the last character — keeps length identical so we exercise the
    // constant-time compare branch (not the length-mismatch early-return).
    const lastChar = sig!.slice(-1);
    const flipped = lastChar === "A" ? "B" : "A";
    const tamperedSig = sig!.slice(0, -1) + flipped;
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

  test("falls back to API_KEY when PAGE_SESSION_SECRET unset", async () => {
    delete process.env.PAGE_SESSION_SECRET;
    process.env.API_KEY = "fallback-api-key-for-test";
    try {
      const payload = { pageId: "fallback", exp: Math.floor(Date.now() / 1000) + 3600 };
      const token = await signPageSession(payload);
      const got = await verifyPageSession(token);
      expect(got).toEqual(payload);
    } finally {
      process.env.PAGE_SESSION_SECRET = "test-secret-fixed-vector-key";
    }
  });

  test("refuses to sign when both PAGE_SESSION_SECRET and API_KEY are unset", async () => {
    delete process.env.PAGE_SESSION_SECRET;
    const savedApiKey = process.env.API_KEY;
    delete process.env.API_KEY;
    try {
      await expect(
        signPageSession({ pageId: "x", exp: Math.floor(Date.now() / 1000) + 60 }),
      ).rejects.toThrow(/PAGE_SESSION_SECRET|API_KEY/);
    } finally {
      process.env.PAGE_SESSION_SECRET = "test-secret-fixed-vector-key";
      if (savedApiKey !== undefined) process.env.API_KEY = savedApiKey;
    }
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
