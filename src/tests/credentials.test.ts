import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateClaudeCredentials, validateOpencodeCredentials } from "../utils/credentials";

// ─── validateClaudeCredentials ───────────────────────────────────────────────

describe("validateClaudeCredentials", () => {
  test("returns 'oauth' when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    expect(validateClaudeCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "tok123" })).toBe("oauth");
  });

  test("returns 'api_key' when only ANTHROPIC_API_KEY is set", () => {
    expect(validateClaudeCredentials({ ANTHROPIC_API_KEY: "sk-ant-123" })).toBe("api_key");
  });

  test("prefers oauth over api_key when both are set", () => {
    expect(
      validateClaudeCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "sk-ant" }),
    ).toBe("oauth");
  });

  test("throws when no credentials are present", () => {
    expect(() => validateClaudeCredentials({})).toThrow();
  });
});

// ─── validateOpencodeCredentials ─────────────────────────────────────────────

describe("validateOpencodeCredentials", () => {
  let tmpHome: string;
  let authDir: string;
  let authFile: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `opencode-test-${Date.now()}`);
    authDir = join(tmpHome, ".local", "share", "opencode");
    authFile = join(authDir, "auth.json");
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test("returns 'openrouter_api_key' when OPENROUTER_API_KEY is set", () => {
    expect(validateOpencodeCredentials({ OPENROUTER_API_KEY: "sk-or-123" })).toBe(
      "openrouter_api_key",
    );
  });

  test("returns 'anthropic_api_key' when only ANTHROPIC_API_KEY is set", () => {
    expect(validateOpencodeCredentials({ ANTHROPIC_API_KEY: "sk-ant-123" })).toBe(
      "anthropic_api_key",
    );
  });

  test("returns 'openai_api_key' when only OPENAI_API_KEY is set", () => {
    expect(validateOpencodeCredentials({ OPENAI_API_KEY: "sk-openai-123" })).toBe("openai_api_key");
  });

  test("returns 'auth_file' when auth.json exists and no env vars are set", () => {
    mkdirSync(authDir, { recursive: true });
    writeFileSync(authFile, JSON.stringify({ token: "test" }));
    expect(validateOpencodeCredentials({})).toBe("auth_file");
  });

  test("throws when no credentials are present and auth.json is absent", () => {
    expect(() => validateOpencodeCredentials({})).toThrow();
  });

  test("prefers OPENROUTER_API_KEY over ANTHROPIC_API_KEY", () => {
    expect(
      validateOpencodeCredentials({ OPENROUTER_API_KEY: "sk-or", ANTHROPIC_API_KEY: "sk-ant" }),
    ).toBe("openrouter_api_key");
  });
});
