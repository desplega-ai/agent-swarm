/**
 * Unit tests for `resolveOpencodeAuth` in
 * `plugin/opencode-plugins/lib/opencode-auth.ts`.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 2 § "Opencode `auth.json` resolver" → "Add unit tests"
 *
 * Uses explicit dependency injection (the `opts` parameter) instead of
 * `bun:test`'s `mock.module()`. The latter is process-wide and leaks across
 * test files in the same `bun test` run (verified in Phase 1).
 *
 * Test cases (per the plan):
 *   1. `auth.json` with `anthropic: {type:"api", key:"sk-..."}` → ApiAuth path
 *   2. Mix of OAuth + api auth → api wins per precedence
 *   3. OAuth refresh returns `newCredentials` → file is rewritten
 *   4. Missing auth.json → returns null
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveOpencodeAuth } from "../lib/opencode-auth";

const origEnv = { ...process.env };

beforeEach(() => {
  // Strip every env var the resolver checks so test runs are deterministic
  // regardless of the developer's local shell.
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...origEnv };
});

describe("resolveOpencodeAuth", () => {
  test("anthropic ApiAuth in auth.json → returns {kind: anthropic, apiKey, modelDefault}", async () => {
    const result = await resolveOpencodeAuth({
      authFilePath: "/fake/auth.json",
      readAuthFile: async () => ({
        anthropic: { type: "api", key: "sk-ant-abc123" },
      }),
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("anthropic");
    if (result!.kind !== "claude-cli") {
      expect(result!.apiKey).toBe("sk-ant-abc123");
      expect(result!.modelDefault).toBe("anthropic/claude-haiku-4-5");
    }
  });

  test("ApiAuth + OAuth mix → api wins (avoids OAuth refresh complexity)", async () => {
    let writes = 0;
    const result = await resolveOpencodeAuth({
      authFilePath: "/fake/auth.json",
      readAuthFile: async () => ({
        // OAuth entry on anthropic — should be tried second by precedence.
        anthropic: {
          type: "oauth",
          refresh: "rt",
          access: "at",
          expires: Date.now() + 60_000,
        },
        // openrouter has higher precedence than anthropic — ApiAuth wins.
        openrouter: { type: "api", key: "sk-or-xyz" },
      }),
      writeAuthFile: async () => {
        writes++;
      },
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("openrouter");
    if (result!.kind !== "claude-cli") {
      expect(result!.apiKey).toBe("sk-or-xyz");
    }
    // No file write — we didn't go through the OAuth path.
    expect(writes).toBe(0);
  });

  test("OAuth path with non-expired access → returns apiKey, writes back to auth.json", async () => {
    const wroteEntries: Array<{ path: string; data: Record<string, unknown> }> = [];
    const result = await resolveOpencodeAuth({
      authFilePath: "/fake/auth.json",
      readAuthFile: async () => ({
        anthropic: {
          type: "oauth",
          refresh: "rt-1",
          access: "at-1",
          expires: Date.now() + 60_000, // not expired
        },
      }),
      writeAuthFile: async (path, data) => {
        wroteEntries.push({ path, data });
      },
      refreshAnthropicOAuth: async () => {
        // Should NOT be called when access is still valid.
        throw new Error("refresh should not be called for non-expired token");
      },
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("anthropic");
    if (result!.kind !== "claude-cli") {
      // Non-expired path returns the existing access token verbatim.
      expect(result!.apiKey).toBe("at-1");
    }
    // The non-expired branch still persists (same tokens) — the resolver
    // doesn't currently branch on "no change", so writes happen
    // unconditionally on the OAuth path. Verify the persist contract.
    expect(wroteEntries.length).toBe(1);
    expect(wroteEntries[0]!.path).toBe("/fake/auth.json");
    const wrote = wroteEntries[0]!.data.anthropic as Record<string, unknown>;
    expect(wrote.type).toBe("oauth");
    expect(wrote.access).toBe("at-1");
  });

  test("OAuth path with expired access → refresh runs, refreshed creds persisted to auth.json", async () => {
    const wroteEntries: Array<Record<string, unknown>> = [];
    let refreshCalled = 0;
    const result = await resolveOpencodeAuth({
      authFilePath: "/fake/auth.json",
      readAuthFile: async () => ({
        anthropic: {
          type: "oauth",
          refresh: "rt-old",
          access: "at-old",
          expires: Date.now() - 60_000, // expired
        },
      }),
      writeAuthFile: async (_path, data) => {
        wroteEntries.push(data);
      },
      refreshAnthropicOAuth: async () => {
        refreshCalled++;
        return {
          access: "at-new",
          refresh: "rt-new",
          expires: Date.now() + 3_600_000,
        };
      },
    });
    expect(refreshCalled).toBe(1);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("anthropic");
    if (result!.kind !== "claude-cli") {
      expect(result!.apiKey).toBe("at-new");
    }
    expect(wroteEntries.length).toBe(1);
    const wrote = wroteEntries[0]!.anthropic as Record<string, unknown>;
    expect(wrote.type).toBe("oauth");
    expect(wrote.access).toBe("at-new");
    expect(wrote.refresh).toBe("rt-new");
  });

  test("missing auth.json (reader returns null) → returns null", async () => {
    const result = await resolveOpencodeAuth({
      authFilePath: "/fake/auth.json",
      readAuthFile: async () => null,
    });
    expect(result).toBeNull();
  });

  test("env OPENROUTER_API_KEY takes precedence over auth.json", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-from-env";
    const result = await resolveOpencodeAuth({
      authFilePath: "/fake/auth.json",
      readAuthFile: async () => {
        throw new Error("reader should not be called");
      },
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("openrouter");
    if (result!.kind !== "claude-cli") {
      expect(result!.apiKey).toBe("sk-or-from-env");
    }
  });

  test("env precedence: openrouter > anthropic > openai", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.OPENAI_API_KEY = "sk-openai";
    // No OPENROUTER_API_KEY → anthropic wins.
    let result = await resolveOpencodeAuth({
      authFilePath: "/fake/auth.json",
      readAuthFile: async () => null,
    });
    expect(result!.kind).toBe("anthropic");

    process.env.OPENROUTER_API_KEY = "sk-or";
    result = await resolveOpencodeAuth({
      authFilePath: "/fake/auth.json",
      readAuthFile: async () => null,
    });
    expect(result!.kind).toBe("openrouter");
  });

  test("WellKnownAuth entry → uses token as apiKey", async () => {
    const result = await resolveOpencodeAuth({
      authFilePath: "/fake/auth.json",
      readAuthFile: async () => ({
        openai: { type: "wellknown", key: "key", token: "sk-from-wellknown" },
      }),
    });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("openai");
    if (result!.kind !== "claude-cli") {
      expect(result!.apiKey).toBe("sk-from-wellknown");
    }
  });

  test("auth.json with only non-anthropic OAuth → returns null (vendored skip)", async () => {
    // openrouter OAuth — vendored plugin doesn't support; should skip and
    // fall through to null.
    const origConsoleError = console.error;
    const errs: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errs.push(args);
    };
    try {
      const result = await resolveOpencodeAuth({
        authFilePath: "/fake/auth.json",
        readAuthFile: async () => ({
          openrouter: {
            type: "oauth",
            refresh: "rt",
            access: "at",
            expires: Date.now() + 60_000,
          },
        }),
      });
      expect(result).toBeNull();
      // Should have logged the skip.
      const sawSkipLog = errs.some((args) => String(args[0] ?? "").includes("OAuth not supported"));
      expect(sawSkipLog).toBe(true);
    } finally {
      console.error = origConsoleError;
    }
  });

  test("auth.json refresh throws → resolver does not throw; returns null", async () => {
    const origConsoleError = console.error;
    const errs: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errs.push(args);
    };
    try {
      const result = await resolveOpencodeAuth({
        authFilePath: "/fake/auth.json",
        readAuthFile: async () => ({
          anthropic: {
            type: "oauth",
            refresh: "rt-bad",
            access: "at-old",
            expires: Date.now() - 60_000, // expired
          },
        }),
        refreshAnthropicOAuth: async () => {
          throw new Error("network down");
        },
      });
      expect(result).toBeNull();
      // Should have logged a refresh-failed error.
      const sawErr = errs.some((args) => String(args[0] ?? "").includes("OAuth refresh failed"));
      expect(sawErr).toBe(true);
    } finally {
      console.error = origConsoleError;
    }
  });

  test("auth.json write fails → resolver still returns the apiKey", async () => {
    const origConsoleError = console.error;
    const errs: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errs.push(args);
    };
    try {
      const result = await resolveOpencodeAuth({
        authFilePath: "/fake/auth.json",
        readAuthFile: async () => ({
          anthropic: {
            type: "oauth",
            refresh: "rt-old",
            access: "at-old",
            expires: Date.now() - 60_000,
          },
        }),
        writeAuthFile: async () => {
          throw new Error("disk full");
        },
        refreshAnthropicOAuth: async () => ({
          access: "at-new",
          refresh: "rt-new",
          expires: Date.now() + 3_600_000,
        }),
      });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("anthropic");
      if (result!.kind !== "claude-cli") {
        expect(result!.apiKey).toBe("at-new");
      }
      const sawPersistErr = errs.some((args) =>
        String(args[0] ?? "").includes("failed to persist refreshed auth.json"),
      );
      expect(sawPersistErr).toBe(true);
    } finally {
      console.error = origConsoleError;
    }
  });
});
