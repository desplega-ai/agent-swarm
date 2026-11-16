import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openAICompatibleProviders } from "@desplega/model-catalog";
import type { ApiKeyStatus, PoolKey, UsageSummaryByCredentialRow } from "../api/types";
import {
  AI_PROVIDERS,
  buildProviderRows,
  healthLabel,
  isUnhealthyKey,
  LIST_POOL_VARS,
  matchAiProviders,
  rollUpHealth,
  spendCapText,
  unhealthyCredentialCount,
} from "./ai-providers";

/**
 * The API's `CREDENTIAL_POOL_VARS` (`src/utils/credentials.ts`): the static
 * names in the array literal, plus the canonical key var of every
 * OpenAI-compatible registry provider (the spread). The dashboard never
 * imports `src/`, so the test reads the file.
 */
async function apiPoolVars(): Promise<string[]> {
  const path = join(import.meta.dir, "../../../../src/utils/credentials.ts");
  const source = await Bun.file(path).text();
  const block = source.match(/export const CREDENTIAL_POOL_VARS = \[([\s\S]*?)\] as const;/);
  if (!block?.[1]) throw new Error("CREDENTIAL_POOL_VARS not found in src/utils/credentials.ts");
  const literals = [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1] as string);
  expect(block[1]).toContain("openAICompatibleProviders()");
  return [...literals, ...openAICompatibleProviders().map((p) => p.envVar)];
}

describe("AI provider registry", () => {
  test("every API credential pool var maps to a provider", async () => {
    const vars = await apiPoolVars();
    expect(vars.length).toBeGreaterThan(10);
    const claimed = new Set(AI_PROVIDERS.flatMap((p) => (p.poolVar ? [p.poolVar] : [])));
    const unclaimed = vars.filter((v) => !claimed.has(v));
    expect(unclaimed).toEqual([]);
  });

  test("every provider pool var is an API pool var", async () => {
    const vars = new Set(await apiPoolVars());
    for (const p of AI_PROVIDERS) {
      if (p.poolVar) expect(vars.has(p.poolVar)).toBe(true);
      for (const field of p.fields) {
        if (field.kind === "pool") expect(vars.has(field.key)).toBe(true);
      }
    }
  });

  test("ids are unique, and every provider can be set up", () => {
    const ids = AI_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(17);
    for (const p of AI_PROVIDERS) {
      expect(p.steps.length).toBeGreaterThan(0);
      // Codex signs in through the device flow; every other provider has a field.
      if (p.id !== "codex") expect(p.fields.length).toBeGreaterThan(0);
      expect(Boolean(p.poolVar) || Boolean(p.configuredBy?.length)).toBe(true);
    }
  });

  test("the list reads every pool var once and never the Codex accounts", () => {
    expect(LIST_POOL_VARS).not.toContain("CODEX_OAUTH");
    expect(new Set(LIST_POOL_VARS).size).toBe(LIST_POOL_VARS.length);
  });

  test("search matches name, type and harness", () => {
    expect(matchAiProviders(AI_PROVIDERS, "router").map((p) => p.id)).toEqual(["openrouter"]);
    expect(matchAiProviders(AI_PROVIDERS, "dsh").map((p) => p.id)).toEqual([
      "deepseek",
      "openrouter",
    ]);
    expect(matchAiProviders(AI_PROVIDERS, "").length).toBe(AI_PROVIDERS.length);
  });
});

function poolKey(index: number, suffix: string, extra: Partial<PoolKey> = {}): PoolKey {
  return {
    index,
    suffix,
    status: "ok",
    error: null,
    checkedAt: null,
    rateLimitedUntil: null,
    ...extra,
  };
}

function status(keyType: string, keySuffix: string, extra: Partial<ApiKeyStatus> = {}) {
  return {
    id: `${keyType}-${keySuffix}`,
    keyType,
    keySuffix,
    keyIndex: 0,
    scope: "global",
    scopeId: "",
    status: "available",
    rateLimitedUntil: null,
    lastUsedAt: null,
    lastRateLimitAt: null,
    totalUsageCount: 0,
    rateLimitCount: 0,
    provider: "claude",
    name: null,
    plan: null,
    planSource: null,
    rateLimitWindows: {},
    modelLimits: [],
    createdAt: "",
    updatedAt: "",
    ...extra,
  } as ApiKeyStatus;
}

function usage(keyType: string, keySuffix: string, costUsd: number) {
  return { keyType, keySuffix, costUsd } as UsageSummaryByCredentialRow;
}

describe("status roll-up", () => {
  test("worst state wins", () => {
    expect(rollUpHealth([{ health: "ok" }, { health: "unchecked" }])).toBe("unchecked");
    expect(rollUpHealth([{ health: "ok" }, { health: "limited" }])).toBe("limited");
    expect(rollUpHealth([{ health: "limited" }, { health: "failing" }])).toBe("failing");
    expect(rollUpHealth([])).toBe("ok");
  });

  test("the sidebar rule: rate limited or rejected", () => {
    expect(isUnhealthyKey(status("X", "a"))).toBe(false);
    expect(isUnhealthyKey(status("X", "a", { status: "rate_limited" }))).toBe(true);
    expect(isUnhealthyKey(status("X", "a", { lastValidationFailedAt: "2026-11-04" }))).toBe(true);
  });

  test("a spend-capped key names the cap, not a rate limit", () => {
    const resetsAt = "2026-11-16T00:00:00.000Z";
    const [openrouter] = buildProviderRows({
      pools: {
        OPENROUTER_API_KEY: {
          readOnly: false,
          keys: [
            poolKey(0, "830cc", {
              status: "spend_capped",
              rateLimitedUntil: resetsAt,
              spendCap: { limitUsd: 1, spendUsd: 1.066227867, resetsAt },
            }),
          ],
        },
      },
      codexAccounts: [],
      statuses: [],
      usageToday: [],
      usage7d: [],
    });
    expect(healthLabel(openrouter!)).toBe("1 spend capped");
    expect(openrouter?.reason).toMatch(
      /^Key ending 830cc: Spend cap hit \(\$1\.07 of \$1\.00\), resets /,
    );
    expect(spendCapText({ limitUsd: null, spendUsd: null, resetsAt: null })).toBe(
      "Spend cap hit. Raise the limit, then remove and add the key again",
    );
  });

  test("rows join pools, statuses and usage, and skip providers with no keys", () => {
    const rows = buildProviderRows({
      pools: {
        CLAUDE_CODE_OAUTH_TOKEN: {
          readOnly: false,
          keys: [
            poolKey(0, "a91f2"),
            poolKey(1, "77c2a", {
              status: "rate_limited",
              rateLimitedUntil: "2026-11-04T14:20:00Z",
            }),
          ],
        },
        DEEPSEEK_API_KEY: {
          readOnly: false,
          keys: [poolKey(0, "4f1cc", { status: "rejected", error: "HTTP 401" })],
        },
        OPENROUTER_API_KEY: { readOnly: true, keys: [] },
      },
      codexAccounts: [
        {
          slot: 0,
          configKey: "codex_oauth_0",
          legacy: false,
          suffix: "zz123",
          plan: "pro",
          email: "taras@acme.dev",
          status: "ok",
        },
      ],
      statuses: [
        status("CLAUDE_CODE_OAUTH_TOKEN", "a91f2", {
          name: "team-max",
          rateLimitWindows: {
            five_hour: { status: "allowed", utilization: 0.62, lastSeenAt: "" },
            seven_day: { status: "allowed", utilization: 0.41, lastSeenAt: "" },
          },
        }),
        status("CLAUDE_CODE_OAUTH_TOKEN", "a91f2", { id: "agent-row", scope: "agent" }),
        status("CLAUDE_CODE_OAUTH_TOKEN", "other", { id: "other-row" }),
      ],
      usageToday: [usage("CLAUDE_CODE_OAUTH_TOKEN", "a91f2", 18.4)],
      usage7d: [
        usage("CLAUDE_CODE_OAUTH_TOKEN", "a91f2", 212.9),
        usage("CLAUDE_CODE_OAUTH_TOKEN", "77c2a", 96.2),
      ],
    });

    expect(rows.map((r) => r.provider.id)).toEqual(["claude", "codex", "deepseek"]);
    const [claude, codex, deepseek] = rows;
    expect(claude?.health).toBe("limited");
    expect(healthLabel(claude!)).toBe("1 rate limited");
    expect(claude?.reason).toMatch(/^Key ending 77c2a is back at /);
    expect(claude?.keys[0]).toMatchObject({ label: "team-max", planRaw: null });
    // Every scope row of the credential travels with the key; the selector dedupes them.
    expect(claude?.keys[0]?.statuses.map((s) => s.scope)).toEqual(["global", "agent"]);
    expect(claude?.keys[0]?.status?.scope).toBe("global");
    expect(claude?.costToday).toBeCloseTo(18.4);
    expect(claude?.cost7d).toBeCloseTo(309.1);
    // The stored login's raw claim (`pro`) is kept, never mapped to a price tier.
    expect(codex).toMatchObject({
      health: "ok",
      keys: [{ label: "taras@acme.dev", plan: null, planRaw: "pro" }],
    });
    expect(healthLabel(deepseek!)).toBe("Failing");
    expect(deepseek?.reason).toBe("Key ending 4f1cc: HTTP 401");
  });

  test("the dot counts ChatGPT accounts that need a new sign-in, once each", () => {
    const account = (slot: number, suffix: string | null, s: "ok" | "needs_login") => ({
      slot,
      configKey: `codex_oauth_${slot}`,
      legacy: false,
      suffix,
      plan: null,
      email: null,
      status: s,
    });
    expect(unhealthyCredentialCount([], [account(0, "aa111", "ok")])).toBe(0);
    expect(unhealthyCredentialCount(undefined, [account(0, "aa111", "needs_login")])).toBe(1);
    // A rejected status row for the same account does not count it twice.
    const rejected = status("CODEX_OAUTH", "aa111", { lastValidationFailedAt: "2026-11-04" });
    expect(unhealthyCredentialCount([rejected], [account(0, "aa111", "needs_login")])).toBe(1);
  });

  test("a provider without a pool gets a row once its config keys are all set", () => {
    const base = { pools: {}, codexAccounts: [], statuses: [], usageToday: [], usage7d: [] };
    expect(buildProviderRows(base)).toEqual([]);
    const rows = buildProviderRows({
      ...base,
      presence: { AWS_REGION: true, MANAGED_AGENT_ID: true, MANAGED_ENVIRONMENT_ID: false },
    });
    expect(rows.map((r) => r.provider.id)).toEqual(["bedrock"]);
    expect(rows[0]).toMatchObject({ keys: [], configOnly: true, health: "ok", reason: null });
  });

  test("a stored OPENCODE_API_KEY lists OpenCode Go, so the page is not empty", () => {
    const base = { pools: {}, codexAccounts: [], statuses: [], usageToday: [], usage7d: [] };
    const rows = buildProviderRows({ ...base, presence: { OPENCODE_API_KEY: true } });
    expect(rows.map((r) => r.provider.id)).toEqual(["opencode-go"]);
    expect(rows[0]).toMatchObject({ keys: [], configOnly: true });
  });

  test("a ChatGPT account that needs a new sign-in fails its provider", () => {
    const [codex] = buildProviderRows({
      pools: {},
      codexAccounts: [
        {
          slot: 1,
          configKey: "codex_oauth_1",
          legacy: false,
          suffix: null,
          plan: null,
          email: null,
          status: "needs_login",
        },
      ],
      statuses: [],
      usageToday: [],
      usage7d: [],
    });
    expect(codex?.health).toBe("failing");
    expect(codex?.reason).toBe("Account in slot 1: sign in again");
  });
});
