import { describe, expect, it } from "bun:test";
import { OPENAI_COMPATIBLE_PROVIDERS } from "@desplega/model-catalog";
import {
  CREDENTIAL_POOL_VARS,
  deriveProviderFromKeyType,
  getModelAwareCredentialVars,
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
  it("resolves comma-separated CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "example-token1,example-token2",
      OTHER_VAR: "unchanged",
    };
    await resolveCredentialPools(env);
    expect(["example-token1", "example-token2"]).toContain(env.CLAUDE_CODE_OAUTH_TOKEN!);
    expect(env.OTHER_VAR).toBe("unchanged");
  });

  it("resolves comma-separated ANTHROPIC_API_KEY", async () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "example-key1,example-key2,example-key3",
    };
    await resolveCredentialPools(env);
    expect(["example-key1", "example-key2", "example-key3"]).toContain(env.ANTHROPIC_API_KEY!);
  });

  it("leaves single values unchanged", async () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "example-single-token",
      ANTHROPIC_API_KEY: "example-single-key",
    };
    await resolveCredentialPools(env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("example-single-token");
    expect(env.ANTHROPIC_API_KEY).toBe("example-single-key");
  });

  it("handles undefined credential vars", async () => {
    const env: Record<string, string | undefined> = {
      SOME_OTHER_VAR: "value",
    };
    await resolveCredentialPools(env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SOME_OTHER_VAR).toBe("value");
  });

  it("keeps a CODEX_OAUTH JSON blob whole despite its commas", async () => {
    const blob = JSON.stringify({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_800_000_000_000,
      accountId: "acct-12345",
    });
    const env: Record<string, string | undefined> = { CODEX_OAUTH: blob };
    const selections = await resolveCredentialPools(env, { provider: "codex" });
    expect(env.CODEX_OAUTH).toBe(blob);
    expect(selections).toHaveLength(1);
    expect(selections[0]?.total).toBe(1);
    expect(selections[0]?.keySuffix).toBe(blob.slice(-5));
  });

  it("resolves both credential vars independently", async () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_OAUTH_TOKEN: "example-oauth1,example-oauth2",
      ANTHROPIC_API_KEY: "example-apikey1,example-apikey2",
    };
    await resolveCredentialPools(env);
    expect(["example-oauth1", "example-oauth2"]).toContain(env.CLAUDE_CODE_OAUTH_TOKEN!);
    expect(["example-apikey1", "example-apikey2"]).toContain(env.ANTHROPIC_API_KEY!);
  });

  it("pools NAN_API_KEY alone for an opencode nan/* model", async () => {
    const env: Record<string, string | undefined> = {
      NAN_API_KEY: "example-nan-a,example-nan-b,example-nan-c",
      OPENROUTER_API_KEY: "example-or-a,example-or-b",
    };
    const selections = await resolveCredentialPools(env, {
      provider: "opencode",
      model: "nan/glm5.3-flash",
    });
    expect(["example-nan-a", "example-nan-b", "example-nan-c"]).toContain(env.NAN_API_KEY!);
    expect(selections).toHaveLength(1);
    expect(selections[0]?.keyType).toBe("NAN_API_KEY");
    expect(selections[0]?.total).toBe(3);
    // OpenRouter is not relevant to a nan/* model and stays untouched.
    expect(env.OPENROUTER_API_KEY).toBe("example-or-a,example-or-b");
  });

  it("pools HELMCODE_API_KEY alone for a pi helmcode/* model", async () => {
    const env: Record<string, string | undefined> = {
      HELMCODE_API_KEY: "example-helm-a,example-helm-b",
    };
    const selections = await resolveCredentialPools(env, {
      provider: "pi",
      model: "helmcode/glm5.3",
    });
    expect(["example-helm-a", "example-helm-b"]).toContain(env.HELMCODE_API_KEY!);
    expect(selections.map((s) => s.keyType)).toEqual(["HELMCODE_API_KEY"]);
  });
});

describe("validateClaudeCredentials", () => {
  it("returns 'oauth' when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "example-some-oauth-token" };
    expect(validateClaudeCredentials(env)).toBe("oauth");
  });

  it("returns 'api_key' when only ANTHROPIC_API_KEY is set", () => {
    const env = { ANTHROPIC_API_KEY: "example-sk-ant-123" };
    expect(validateClaudeCredentials(env)).toBe("api_key");
  });

  it("returns 'oauth' when both are set (oauth takes priority)", () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: "example-some-oauth-token",
      ANTHROPIC_API_KEY: "example-sk-ant-123",
    };
    expect(validateClaudeCredentials(env)).toBe("oauth");
  });

  it("throws when neither credential is set", () => {
    expect(() => validateClaudeCredentials({})).toThrow(
      "No Claude credentials found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or route",
    );
  });

  it("accepts gateway and cloud routes without an Anthropic credential", () => {
    expect(
      validateClaudeCredentials({
        ANTHROPIC_BASE_URL: "http://litellm:4000",
        ANTHROPIC_AUTH_TOKEN: "sk-litellm",
      }),
    ).toBe("gateway");
    expect(
      validateClaudeCredentials({
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_RESOURCE: "res",
        ANTHROPIC_FOUNDRY_API_KEY: "az",
      }),
    ).toBe("foundry");
    expect(
      validateClaudeCredentials({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" }),
    ).toBe("bedrock");
    expect(
      validateClaudeCredentials({
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: "us-east5",
        ANTHROPIC_VERTEX_PROJECT_ID: "p",
      }),
    ).toBe("vertex");
  });

  it("names a route's missing env var", () => {
    expect(() => validateClaudeCredentials({ CLAUDE_CODE_USE_BEDROCK: "1" })).toThrow("AWS_REGION");
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
    expect(CREDENTIAL_POOL_VARS).toContain("NAN_API_KEY");
    expect(CREDENTIAL_POOL_VARS).toContain("HELMCODE_API_KEY");
  });

  it("pools only the canonical NaN var; the alias is normalized by the runner", () => {
    expect(OPENAI_COMPATIBLE_PROVIDERS.nan.aliasEnvVars).toEqual(["HELMCODE_API_NAN"]);
    expect(CREDENTIAL_POOL_VARS as readonly string[]).not.toContain("HELMCODE_API_NAN");
  });
});

describe("deriveProviderFromKeyType", () => {
  it("tags NaN and Helmcode keys as pi, like OpenRouter", () => {
    for (const keyType of ["NAN_API_KEY", "HELMCODE_API_NAN", "HELMCODE_API_KEY"]) {
      expect(deriveProviderFromKeyType(keyType)).toBe("pi");
    }
    expect(deriveProviderFromKeyType("OPENROUTER_API_KEY")).toBe("pi");
    expect(deriveProviderFromKeyType("SOMETHING_ELSE")).toBe("claude");
  });
});

describe("getModelAwareCredentialVars", () => {
  it("excludes OPENAI_API_KEY for opencode with OpenRouter model (slash in name)", () => {
    const vars = getModelAwareCredentialVars("opencode", "google/gemini-3-flash-preview");
    expect(vars).toContain("OPENROUTER_API_KEY");
    expect(vars).toContain("ANTHROPIC_API_KEY");
    expect(vars).not.toContain("OPENAI_API_KEY");
  });

  it("keeps OPENAI_API_KEY for opencode with direct OpenAI model (no slash)", () => {
    const vars = getModelAwareCredentialVars("opencode", "gpt-4o");
    expect(vars).toContain("OPENROUTER_API_KEY");
    expect(vars).toContain("ANTHROPIC_API_KEY");
    expect(vars).toContain("OPENAI_API_KEY");
  });

  it("keeps OPENAI_API_KEY for opencode when model is empty", () => {
    const vars = getModelAwareCredentialVars("opencode", "");
    expect(vars).toContain("OPENAI_API_KEY");
  });

  it("keeps OPENAI_API_KEY for opencode when model is undefined", () => {
    const vars = getModelAwareCredentialVars("opencode");
    expect(vars).toContain("OPENAI_API_KEY");
  });

  it("excludes OPENAI_API_KEY for pi with OpenRouter model (slash in name)", () => {
    const vars = getModelAwareCredentialVars("pi", "anthropic/claude-sonnet-4-20250514");
    expect(vars).toContain("OPENROUTER_API_KEY");
    expect(vars).toContain("ANTHROPIC_API_KEY");
    expect(vars).not.toContain("OPENAI_API_KEY");
  });

  it("keeps OPENAI_API_KEY for pi with direct model (no slash)", () => {
    const vars = getModelAwareCredentialVars("pi", "gpt-4o");
    expect(vars).toContain("OPENROUTER_API_KEY");
    expect(vars).toContain("ANTHROPIC_API_KEY");
    expect(vars).toContain("OPENAI_API_KEY");
  });

  it("keeps OPENAI_API_KEY for pi when model is undefined", () => {
    const vars = getModelAwareCredentialVars("pi");
    expect(vars).toContain("OPENAI_API_KEY");
  });

  it("returns static list for non-slash providers regardless of model", () => {
    const vars = getModelAwareCredentialVars("claude", "google/gemini-3-flash-preview");
    expect(vars).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(vars).toContain("ANTHROPIC_API_KEY");
    expect(vars).not.toContain("OPENAI_API_KEY");
  });

  it("falls back to all pool vars for unknown provider", () => {
    const vars = getModelAwareCredentialVars("unknown-provider", "some-model");
    expect(vars).toEqual(CREDENTIAL_POOL_VARS);
  });

  it("handles OpenRouter-prefixed models", () => {
    const vars = getModelAwareCredentialVars("opencode", "openrouter/openai/gpt-4o");
    expect(vars).not.toContain("OPENAI_API_KEY");
  });

  it("handles Anthropic-prefixed models via OpenRouter", () => {
    const vars = getModelAwareCredentialVars("opencode", "anthropic/claude-sonnet-4-20250514");
    expect(vars).not.toContain("OPENAI_API_KEY");
  });

  it("routes nan/* and helmcode/* to their own key on pi and opencode", () => {
    for (const provider of ["pi", "opencode"]) {
      expect(getModelAwareCredentialVars(provider, "nan/glm5.3-flash")).toEqual(["NAN_API_KEY"]);
      expect(getModelAwareCredentialVars(provider, "helmcode/glm5.3")).toEqual([
        "HELMCODE_API_KEY",
      ]);
      // Only the exact prefix routes: a look-alike is any other provider/model.
      const other = getModelAwareCredentialVars(provider, "other/x");
      expect(getModelAwareCredentialVars(provider, "helmcodex/x")).toEqual(other);
      expect(getModelAwareCredentialVars(provider, "nanx/y")).toEqual(other);
      expect(other).not.toContain("NAN_API_KEY");
      expect(other).not.toContain("HELMCODE_API_KEY");
    }
  });

  it("keeps OpenRouter and bare-id routing byte-identical", () => {
    for (const provider of ["pi", "opencode"]) {
      expect(
        getModelAwareCredentialVars(provider, "openrouter/deepseek/deepseek-v4-flash"),
      ).toEqual(["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]);
      expect(getModelAwareCredentialVars(provider, "openai/gpt-5")).toEqual([
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
      ]);
      expect(getModelAwareCredentialVars(provider, "gpt-4o")).toEqual([
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
      ]);
      // A NaN model routed through OpenRouter is still an OpenRouter model.
      expect(getModelAwareCredentialVars(provider, "openrouter/nan/glm5.3")).toEqual([
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
      ]);
    }
  });

  it("does not apply the nan/helmcode prefix routing to other harnesses", () => {
    expect(getModelAwareCredentialVars("claude", "nan/glm5.3")).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
  });
});
