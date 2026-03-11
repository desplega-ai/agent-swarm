import { describe, expect, it } from "bun:test";
import {
  CREDENTIAL_POOL_VARS,
  resolveCredentialPools,
  selectRandomCredential,
  validateClaudeCredentials,
} from "./credentials.ts";

describe("selectRandomCredential", () => {
  it("returns single value as-is when no commas", () => {
    const result = selectRandomCredential("my-single-token");
    expect(result.selected).toBe("my-single-token");
    expect(result.index).toBe(0);
    expect(result.total).toBe(1);
  });

  it("returns empty string as-is", () => {
    const result = selectRandomCredential("");
    expect(result.selected).toBe("");
    expect(result.index).toBe(0);
    expect(result.total).toBe(1);
  });

  it("selects one from comma-separated values", () => {
    const credentials = ["token1", "token2", "token3"];
    const result = selectRandomCredential(credentials.join(","));
    expect(credentials).toContain(result.selected);
    expect(result.index).toBeGreaterThanOrEqual(0);
    expect(result.index).toBeLessThan(3);
    expect(result.total).toBe(3);
  });

  it("trims whitespace around credentials", () => {
    const result = selectRandomCredential(" token1 , token2 ");
    expect(["token1", "token2"]).toContain(result.selected);
    expect(result.total).toBe(2);
  });

  it("filters out empty segments from trailing commas", () => {
    const result = selectRandomCredential("token1,,token2,");
    expect(["token1", "token2"]).toContain(result.selected);
    expect(result.total).toBe(2);
  });

  it("treats single value with trailing comma as single credential", () => {
    const result = selectRandomCredential("token1,");
    expect(result.selected).toBe("token1,");
    expect(result.total).toBe(1);
  });

  it("distributes selections across all credentials over many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const result = selectRandomCredential("a,b,c");
      seen.add(result.selected);
    }
    // With 100 iterations and 3 options, we should see all 3
    expect(seen.size).toBe(3);
  });
});

describe("resolveCredentialPools", () => {
  it("resolves comma-separated CLAUDE_CODE_OAUTH_TOKEN", () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "token1,token2",
      OTHER_VAR: "unchanged",
    };
    resolveCredentialPools(env);
    expect(["token1", "token2"]).toContain(env.CLAUDE_CODE_OAUTH_TOKEN!);
    expect(env.OTHER_VAR).toBe("unchanged");
  });

  it("resolves comma-separated ANTHROPIC_API_KEY", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "key1,key2,key3",
    };
    resolveCredentialPools(env);
    expect(["key1", "key2", "key3"]).toContain(env.ANTHROPIC_API_KEY!);
  });

  it("leaves single values unchanged", () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "single-token",
      ANTHROPIC_API_KEY: "single-key",
    };
    resolveCredentialPools(env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("single-token");
    expect(env.ANTHROPIC_API_KEY).toBe("single-key");
  });

  it("handles undefined credential vars", () => {
    const env: Record<string, string | undefined> = {
      SOME_OTHER_VAR: "value",
    };
    resolveCredentialPools(env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SOME_OTHER_VAR).toBe("value");
  });

  it("resolves both credential vars independently", () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "oauth1,oauth2",
      ANTHROPIC_API_KEY: "apikey1,apikey2",
    };
    resolveCredentialPools(env);
    expect(["oauth1", "oauth2"]).toContain(env.CLAUDE_CODE_OAUTH_TOKEN!);
    expect(["apikey1", "apikey2"]).toContain(env.ANTHROPIC_API_KEY!);
  });
});

describe("validateClaudeCredentials", () => {
  it("returns 'oauth' when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "some-oauth-token" };
    expect(validateClaudeCredentials(env)).toBe("oauth");
  });

  it("returns 'api_key' when only ANTHROPIC_API_KEY is set", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-123" };
    expect(validateClaudeCredentials(env)).toBe("api_key");
  });

  it("returns 'oauth' when both are set (oauth takes priority)", () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: "some-oauth-token",
      ANTHROPIC_API_KEY: "sk-ant-123",
    };
    expect(validateClaudeCredentials(env)).toBe("oauth");
  });

  it("throws when neither credential is set", () => {
    expect(() => validateClaudeCredentials({})).toThrow(
      "No Claude credentials found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.",
    );
  });

  it("treats empty string as missing", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "" };
    expect(() => validateClaudeCredentials(env)).toThrow("No Claude credentials found");
  });

  it("treats undefined values as missing", () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
    };
    expect(() => validateClaudeCredentials(env)).toThrow("No Claude credentials found");
  });
});

describe("CREDENTIAL_POOL_VARS", () => {
  it("contains expected env var names", () => {
    expect(CREDENTIAL_POOL_VARS).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(CREDENTIAL_POOL_VARS).toContain("ANTHROPIC_API_KEY");
  });
});
