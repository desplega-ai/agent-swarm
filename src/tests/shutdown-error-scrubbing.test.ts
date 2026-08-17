import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearVolatileSecretsForTesting,
  refreshSecretScrubberCache,
  registerVolatileSecret,
  scrubSecrets,
} from "../utils/secret-scrubber";

/**
 * A rejected shutdown step (or any other fire-and-forget call) can carry an
 * SDK error whose message embeds an authorization header or token. Logging the
 * raw rejection would put that on stdout, so every such handler converts the
 * rejection to text and passes it through `scrubSecrets` at the egress point.
 *
 * The first group exercises that conversion directly. The second asserts the
 * SIGINT/SIGTERM handlers actually use it: those live at module scope in
 * `src/http/index.ts`, which binds a port on import, so the source is read
 * rather than executed.
 */

const SECRET = "xoxb-9911-shutdown-token-value";

const shutdownSourcePath = `${import.meta.dir}/../http/index.ts`;
const shutdownSource = await Bun.file(shutdownSourcePath).text();

describe("rejection log egress", () => {
  beforeEach(() => {
    registerVolatileSecret(SECRET, "SLACK_BOT_TOKEN");
    refreshSecretScrubberCache();
  });

  afterEach(() => {
    clearVolatileSecretsForTesting();
    refreshSecretScrubberCache();
  });

  /** The exact expression used at every rejection log site in this change. */
  const egress = (err: unknown): string =>
    scrubSecrets(err instanceof Error ? err.message : String(err));

  test("redacts a secret carried in an Error message", () => {
    const logged = egress(new Error(`Slack API request failed: Bearer ${SECRET}`));

    expect(logged).not.toContain(SECRET);
    expect(logged).toContain("[REDACTED:SLACK_BOT_TOKEN]");
  });

  test("keeps the non-sensitive context observable", () => {
    const logged = egress(new Error(`Slack API request failed: Bearer ${SECRET}`));

    expect(logged).toContain("Slack API request failed");
  });

  test("does not emit the Error object itself, only its message", () => {
    const err = new Error("boom");
    // A raw object would serialise fields such as `response`, `config`, or
    // `headers` that SDK errors attach; only the message crosses the boundary.
    expect(egress(err)).toBe("boom");
  });

  test("redacts a secret carried in a non-Error rejection", () => {
    const logged = egress(`token=${SECRET}`);

    expect(logged).not.toContain(SECRET);
    expect(logged).toContain("[REDACTED:SLACK_BOT_TOKEN]");
  });

  test("handles null and undefined rejections without throwing", () => {
    expect(egress(null)).toBe("null");
    expect(egress(undefined)).toBe("undefined");
  });
});

describe("shutdown signal handlers", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} routes its rejection through scrubSecrets`, () => {
      const handler = shutdownSource.match(
        new RegExp(`process\\.on\\("${signal}",[\\s\\S]*?\\n  \\}\\);`),
      )?.[0];

      expect(handler).toBeDefined();
      expect(handler).toContain("shutdown().catch(");
      expect(handler).toContain("scrubSecrets(");
      // The raw rejection must not be handed to console.error.
      expect(handler).not.toMatch(/console\.error\([^)]*,\s*err\s*\)/);
    });
  }

  test("both handlers still call shutdown exactly once", () => {
    expect(shutdownSource.match(/shutdown\(\)\.catch\(/g)).toHaveLength(2);
  });
});
