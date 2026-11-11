/**
 * Convex deploy keys (pass 2 shape rule) and URL-encoded / URL-decoded forms
 * of known values (pass 1). Every key is built at runtime from random bytes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { redactWithEnv } from "../e2b/env";
import {
  createValueScrubber,
  refreshSecretScrubberCache,
  registerVolatileSecret,
  scrubSecrets,
} from "../utils/secret-scrubber";
import { randomToken } from "./synthetic-secret-helpers";

// A base64 token shaped like Convex's `eyJ2...0=`, with `+` and `/` in it.
const token = () => `eyJ2${randomToken(20)}+${randomToken(20)}/${randomToken(12)}=`;
const deployment = () => `${randomToken(6).toLowerCase()}-animal-123`;

const MARK = "[REDACTED:convex_deploy_key]";

describe("convex_deploy_key shape rule", () => {
  const forms: Array<[string, () => string]> = [
    ["prod with |", () => `prod:${deployment()}|${token()}`],
    ["prod with %7C", () => `prod:${deployment()}%7C${token()}`],
    ["prod with %7c", () => `prod:${deployment()}%7c${token()}`],
    ["dev with |", () => `dev:${deployment()}|${token()}`],
    ["preview with |", () => `preview:team-slug:project-slug|${token()}`],
    ["preview with %7C", () => `preview:team-slug:project-slug%7C${token()}`],
    ["project token", () => `project:team-slug:project-slug|${token()}`],
    ["fully URL-encoded token", () => `prod:${deployment()}%7C${encodeURIComponent(token())}`],
  ];
  for (const [label, build] of forms) {
    test(`redacts ${label}`, () => {
      const key = build();
      for (const text of [
        `CONVEX_DEPLOY_KEY=${key}`,
        `key is ${key} here`,
        JSON.stringify({ stdout: `export X="${key}"\n` }),
      ]) {
        const out = scrubSecrets(text);
        expect(out).not.toContain(key.slice(key.length - 20));
      }
      expect(scrubSecrets(`key is ${key} here`)).toBe(`key is ${MARK} here`);
    });
  }

  test("leaves prose and URLs without the token shape alone", () => {
    for (const text of [
      "deploy to prod: done, then dev: pending",
      "see preview:team-slug:project-slug for details",
      "https://example.com/search?q=dev:a%7Cb&filter=x",
      "https://example.com/list?ids=1%7C2%7C3&sort=prod:asc",
      "cat log | grep prod:happy-animal-123|wc -l",
      `prod:happy-animal-123|${"x".repeat(10)}`,
      "notprod:happy-animal-123|eyJ2abcdefghijklmnopqrstuvwxyz",
    ]) {
      expect(scrubSecrets(text)).toBe(text);
    }
  });
});

describe("known values in URL forms", () => {
  afterEach(() => {
    delete process.env.CONVEX_TEST_DEPLOY_KEY;
    refreshSecretScrubberCache();
  });

  // A value no shape rule knows, so only pass 1 can redact it.
  const encodedValue = () => `acme-${randomToken(10)}%7C${randomToken(24)}%3D`;

  test("an env value stored URL-encoded is redacted in its decoded form", () => {
    const stored = encodedValue();
    process.env.CONVEX_TEST_DEPLOY_KEY = stored;
    refreshSecretScrubberCache();
    const decoded = decodeURIComponent(stored);
    expect(scrubSecrets(`v=${stored}`)).toBe("v=[REDACTED:CONVEX_TEST_DEPLOY_KEY]");
    expect(scrubSecrets(`echo ${decoded} done`)).toBe(
      "echo [REDACTED:CONVEX_TEST_DEPLOY_KEY] done",
    );
    expect(scrubSecrets(JSON.stringify({ out: decoded }))).not.toContain(decoded);
  });

  test("an env value stored raw is redacted in its URL-encoded form", () => {
    const raw = `acme-${randomToken(10)}|${randomToken(24)}=`;
    process.env.CONVEX_TEST_DEPLOY_KEY = raw;
    refreshSecretScrubberCache();
    const encoded = encodeURIComponent(raw);
    expect(scrubSecrets(`u=${encoded}`)).toBe("u=[REDACTED:CONVEX_TEST_DEPLOY_KEY]");
  });

  test("volatile secrets and per-run value scrubbers match the decoded form", () => {
    const stored = encodedValue();
    registerVolatileSecret(stored, "VOLATILE_URL_SECRET");
    expect(scrubSecrets(`x ${decodeURIComponent(stored)}`)).toBe(
      "x [REDACTED:VOLATILE_URL_SECRET]",
    );
    const scrub = createValueScrubber([{ value: stored, name: "RUN_SECRET" }]);
    expect(scrub.text(`x ${decodeURIComponent(stored)}`)).toBe("x [REDACTED:RUN_SECRET]");
  });

  test("redactWithEnv matches the decoded form of a runtime env value", () => {
    const stored = encodedValue();
    const out = redactWithEnv(`err: ${decodeURIComponent(stored)}`, {
      CONVEX_DEPLOY_KEY: stored,
    });
    expect(out).toBe("err: [REDACTED:CONVEX_DEPLOY_KEY]");
  });

  test("a decoded form shorter than the floor is not registered", () => {
    // 12 chars encoded, 4 decoded: the decoded form would hit ordinary text.
    const stored = "%41%42%43%44";
    process.env.CONVEX_TEST_DEPLOY_KEY = stored;
    refreshSecretScrubberCache();
    expect(scrubSecrets("ABCD is a word")).toBe("ABCD is a word");
    expect(scrubSecrets(`v ${stored}`)).toBe("v [REDACTED:CONVEX_TEST_DEPLOY_KEY]");
  });

  test("an invalid percent sequence keeps the raw value only", () => {
    const stored = `acme-${randomToken(16)}%ZZ`;
    process.env.CONVEX_TEST_DEPLOY_KEY = stored;
    refreshSecretScrubberCache();
    expect(scrubSecrets(`v ${stored}`)).toBe("v [REDACTED:CONVEX_TEST_DEPLOY_KEY]");
  });
});
