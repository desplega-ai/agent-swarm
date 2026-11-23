import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ApiKeyRef, ConfigRepository, NewSwarmConfig, Storage } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

function newConfig(overrides: Partial<NewSwarmConfig> = {}): NewSwarmConfig {
  return {
    id: crypto.randomUUID(),
    scope: "global",
    scopeId: null,
    key: "CT_KEY",
    value: "v",
    isSecret: false,
    envPath: null,
    description: null,
    encrypted: false,
    exportToEnv: true,
    now: T0,
    ...overrides,
  };
}

const ref = (keySuffix: string, scope = "global", scopeId = ""): ApiKeyRef => ({
  keyType: "CT_TYPE",
  keySuffix,
  scope,
  scopeId,
});

export function configContract(engine: ContractEngine): void {
  describe(`config repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: ConfigRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.config;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("config rows keep the stored value shape", async () => {
      const row = await repo.insertConfig(
        newConfig({ id: "c1", key: "CT_A", isSecret: true, encrypted: true, exportToEnv: false }),
      );
      expect(row).toMatchObject({
        id: "c1",
        scope: "global",
        scopeId: null,
        key: "CT_A",
        value: "v",
        isSecret: 1,
        encrypted: 1,
        exportToEnv: 0,
        envPath: null,
        description: null,
        createdAt: T0,
        lastUpdatedAt: T0,
      });
      expect(await repo.findConfigById("c1")).toEqual(row);
      expect(await repo.findConfigByScopeKey("global", null, "CT_A")).toEqual(row);
      expect(await repo.findConfigByScopeKey("global", "x", "CT_A")).toBeNull();
      expect(await repo.findConfigById("missing")).toBeNull();
    });

    test("findConfigByScopeKey matches a NULL scopeId and an exact one", async () => {
      await repo.insertConfig(newConfig({ id: "g", key: "CT_S" }));
      await repo.insertConfig(newConfig({ id: "a", key: "CT_S", scope: "agent", scopeId: "ag1" }));
      expect((await repo.findConfigByScopeKey("global", null, "CT_S"))?.id).toBe("g");
      expect((await repo.findConfigByScopeKey("agent", "ag1", "CT_S"))?.id).toBe("a");
      expect(await repo.findConfigByScopeKey("agent", null, "CT_S")).toBeNull();
    });

    test("listConfigs orders by key in byte order, ties in insertion order", async () => {
      await repo.insertConfig(newConfig({ id: "3", key: "CT_b", scope: "agent", scopeId: "z" }));
      await repo.insertConfig(newConfig({ id: "1", key: "CT_b", scope: "agent", scopeId: "a" }));
      await repo.insertConfig(newConfig({ id: "2", key: "CT_B", scope: "agent", scopeId: "a" }));
      await repo.insertConfig(newConfig({ id: "4", key: "CT_a", scope: "agent", scopeId: "a" }));
      expect((await repo.listConfigs({ scope: "agent" })).map((r) => r.id)).toEqual([
        "2",
        "4",
        "3",
        "1",
      ]);
      expect((await repo.listConfigs({ scope: "agent", scopeId: "a" })).map((r) => r.id)).toEqual([
        "2",
        "4",
        "1",
      ]);
      expect((await repo.listConfigs({ key: "CT_b" })).map((r) => r.id)).toEqual(["3", "1"]);
    });

    test("listGlobalConfigsExcept filters upper-cased keys", async () => {
      await repo.insertConfig(newConfig({ id: "1", key: "ct_drop" }));
      await repo.insertConfig(newConfig({ id: "2", key: "CT_KEEP" }));
      await repo.insertConfig(
        newConfig({ id: "3", key: "CT_AGENT", scope: "agent", scopeId: "a" }),
      );
      const ids = (await repo.listGlobalConfigsExcept(["CT_DROP"]))
        .filter((r) => r.key.toUpperCase().startsWith("CT_"))
        .map((r) => r.id);
      expect(ids).toEqual(["2"]);
    });

    test("updateConfigValue: flags, forced and kept exportToEnv", async () => {
      await repo.insertConfig(newConfig({ id: "c1", exportToEnv: false }));
      const base = {
        value: "w",
        isSecret: true,
        envPath: "/e",
        description: "d",
        encrypted: true,
        now: T1,
        forceNoExport: false,
      };
      expect(await repo.updateConfigValue("c1", { ...base, exportToEnv: null })).toMatchObject({
        value: "w",
        isSecret: 1,
        encrypted: 1,
        exportToEnv: 0,
        envPath: "/e",
        description: "d",
        lastUpdatedAt: T1,
        createdAt: T0,
      });
      expect(await repo.updateConfigValue("c1", { ...base, exportToEnv: true })).toMatchObject({
        exportToEnv: 1,
      });
      expect(await repo.updateConfigValue("c1", { ...base, exportToEnv: null })).toMatchObject({
        exportToEnv: 1,
      });
      expect(
        await repo.updateConfigValue("c1", { ...base, forceNoExport: true, exportToEnv: true }),
      ).toMatchObject({ exportToEnv: 0 });
      expect(await repo.updateConfigValue("missing", { ...base, exportToEnv: null })).toBeNull();
    });

    test("deleteConfig returns the deleted row once", async () => {
      await repo.insertConfig(newConfig({ id: "c1" }));
      expect(await repo.deleteConfig("c1")).toMatchObject({ id: "c1", key: "CT_KEY" });
      expect(await repo.deleteConfig("c1")).toBeNull();
    });

    test("secret and codex account listings, in insertion order", async () => {
      await repo.insertConfig(newConfig({ id: "s2", key: "CT_S2", isSecret: true }));
      await repo.insertConfig(newConfig({ id: "p", key: "CT_P" }));
      await repo.insertConfig(newConfig({ id: "s1", key: "CT_S1", encrypted: true }));
      expect(
        (await repo.listSecretConfigs()).filter((r) => r.key.startsWith("CT_")).map((r) => r.key),
      ).toEqual(["CT_S2", "CT_S1"]);

      for (const key of ["codex_oauth_1", "codex_oauth", "codex_oauth_x", "codex_oauth_10a"]) {
        await repo.insertConfig(newConfig({ key }));
      }
      await repo.insertConfig(newConfig({ key: "codex_oauth_2", scope: "agent", scopeId: "a" }));
      expect((await repo.listCodexOauthConfigs()).map((r) => r.key)).toEqual([
        "codex_oauth_1",
        "codex_oauth",
        "codex_oauth_10a",
      ]);
    });

    test("repos: insert shape, filters, name order, column update, delete", async () => {
      const insert = (id: string, name: string, autoClone: boolean) =>
        repo.insertRepo({
          id,
          url: `https://x/${name}`,
          name,
          clonePath: `/w/${name}`,
          defaultBranch: "main",
          autoClone,
          hooks: '{"enabled":true}',
          guidelines: null,
          now: T0,
        });
      expect(await insert("r1", "beta", true)).toMatchObject({
        id: "r1",
        name: "beta",
        autoClone: 1,
        hooks: '{"enabled":true}',
        guidelines: null,
        createdAt: T0,
        lastUpdatedAt: T0,
      });
      await insert("r2", "Alpha", false);
      await insert("r3", "alpha", true);
      expect((await repo.listRepos({})).map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
      expect((await repo.listRepos({ autoClone: false })).map((r) => r.id)).toEqual(["r2"]);
      expect((await repo.listRepos({ autoClone: true, name: "beta" })).map((r) => r.id)).toEqual([
        "r1",
      ]);
      expect((await repo.findRepoByName("alpha"))?.id).toBe("r3");
      expect((await repo.findRepoByUrl("https://x/beta"))?.id).toBe("r1");
      expect(
        await repo.updateRepo("r1", { autoClone: false, hooks: null, guidelines: "{}" }, T1),
      ).toMatchObject({ autoClone: 0, hooks: null, guidelines: "{}", lastUpdatedAt: T1 });
      expect(await repo.updateRepo("missing", { name: "x" }, T1)).toBeNull();
      expect(await repo.deleteRepo("r1")).toBe(1);
      expect(await repo.deleteRepo("r1")).toBe(0);
      expect(await repo.findRepoById("r1")).toBeNull();
    });

    test("seed state upserts by (kind, key)", async () => {
      await repo.upsertSeedState({ kind: "ct", key: "k", seededHash: "h1", seededAt: T0 });
      await repo.upsertSeedState({ kind: "ct", key: "k", seededHash: "h2", seededAt: T1 });
      expect(await repo.getSeedState("ct", "k")).toEqual({
        kind: "ct",
        key: "k",
        seededHash: "h2",
        seededAt: T1,
      });
      await repo.deleteSeedState("ct", "k");
      expect(await repo.getSeedState("ct", "k")).toBeNull();
    });

    test("key usage upsert counts uses; statuses order by index, ties in insertion order", async () => {
      await repo.upsertKeyUsage(ref("bbb"), 1, "claude", T0);
      await repo.upsertKeyUsage(ref("aaa"), 1, "claude", T0);
      await repo.upsertKeyUsage(ref("ccc"), 0, "claude", T0);
      await repo.upsertKeyUsage(ref("bbb"), 1, "claude", T1);
      const rows = await repo.listKeyStatuses({ keyType: "CT_TYPE" });
      expect(rows.map((r) => r.keySuffix)).toEqual(["ccc", "bbb", "aaa"]);
      expect(rows[1]).toMatchObject({
        keyIndex: 1,
        scope: "global",
        scopeId: "",
        status: "available",
        totalUsageCount: 2,
        lastUsedAt: T1,
        updatedAt: T1,
        provider: "claude",
        consecutiveAuthFailures: 0,
        authFailureSeq: 0,
        plan: null,
      });
      await repo.touchKey(ref("ddd", "agent", "a1"), 4, "codex", T0);
      expect(
        (await repo.listKeyStatuses({ keyType: "CT_TYPE", scope: "agent", scopeId: "a1" })).map(
          (r) => [r.keySuffix, r.keyIndex, r.provider, r.totalUsageCount],
        ),
      ).toEqual([["ddd", 4, "codex", 0]]);
      expect(await repo.hasKeySuffix("CT_TYPE", ["ddd"], "a1")).toBe(true);
      expect(await repo.hasKeySuffix("CT_TYPE", ["ddd"], "a2")).toBe(false);
      expect(await repo.hasKeySuffix("CT_TYPE", ["aaa", "zzz"], "a2")).toBe(true);
      expect(await repo.hasKeySuffix("CT_TYPE", [], "a2")).toBe(false);
    });

    test("status and admission tie orders follow the pre-move SQLite plans", async () => {
      await repo.upsertKeyUsage(ref("s1", "agent", "z"), 1, "claude", T0);
      await repo.upsertKeyUsage(ref("s2"), 1, "claude", T0);
      await repo.upsertKeyUsage(ref("s3"), 0, "claude", T0);
      await repo.upsertKeyUsage(ref("s4", "agent", "a"), 1, "claude", T0);
      const suffixes = (rows: { keySuffix: string }[]) => rows.map((r) => r.keySuffix);
      expect(
        suffixes((await repo.listKeyStatuses({})).filter((r) => r.keyType === "CT_TYPE")),
      ).toEqual(["s3", "s1", "s2", "s4"]);
      expect(suffixes(await repo.listKeyStatuses({ keyType: "CT_TYPE" }))).toEqual([
        "s3",
        "s4",
        "s1",
        "s2",
      ]);
      expect(
        suffixes(
          await repo.listAdmissionRows({ keyType: "CT_TYPE", suffixes: ["s4", "s1", "s2"] }),
        ),
      ).toEqual(["s1", "s2", "s4"]);
    });

    test("labels: manual plans first, then newest update, ties in insertion order", async () => {
      await repo.upsertKeyUsage(ref("k1"), 0, "claude", T0);
      await repo.upsertKeyUsage(ref("k2"), 1, "claude", T1);
      await repo.upsertKeyUsage(ref("k3"), 2, "claude", T1);
      await repo.upsertKeyUsage(ref("k4"), 3, "claude", T0);
      await repo.setManualPlan("CT_TYPE", "k4", "pro", T0);
      expect(
        (await repo.listKeyLabels()).filter((r) => r.keyType === "CT_TYPE").map((r) => r.keySuffix),
      ).toEqual(["k4", "k2", "k3", "k1"]);
    });

    test("detected plans never replace a manual plan; unchanged plans count no change", async () => {
      await repo.upsertKeyUsage(ref("k1"), 0, "claude", T0);
      await repo.upsertKeyUsage(ref("k1", "agent", "a"), 0, "claude", T0);
      expect(await repo.setDetectedPlan("CT_TYPE", "k1", "max")).toBe(2);
      expect(await repo.setDetectedPlan("CT_TYPE", "k1", "max")).toBe(0);
      expect(await repo.setDetectedPlanUnlessManual("CT_TYPE", "k1", "max")).toBe(2);
      expect(await repo.setDetectedPlan("CT_TYPE", "k1", null)).toBe(2);
      expect(await repo.getKeyPlan(ref("k1"))).toBeNull();
      expect(await repo.getKeyPlan(ref("missing"))).toBeUndefined();
      expect(await repo.setManualPlan("CT_TYPE", "k1", "team", T1)).toBe(2);
      expect(await repo.setDetectedPlan("CT_TYPE", "k1", "max")).toBe(0);
      expect(await repo.setDetectedPlanUnlessManual("CT_TYPE", "k1", "max")).toBe(0);
      expect(await repo.getKeyPlan(ref("k1"))).toBe("team");
      expect(await repo.setManualPlan("CT_TYPE", "k1", null, T2)).toBe(2);
      const [row] = await repo.listKeyStatuses({ keyType: "CT_TYPE", scope: "global" });
      expect(row).toMatchObject({ plan: null, planSource: null, updatedAt: T2 });
      expect(await repo.setManualPlan("CT_TYPE", "nope", "team", T1)).toBe(0);
      await repo.setDetectedPlanRaw("CT_TYPE", "k1", "raw");
      await repo.setSeatMismatch("CT_TYPE", "k1", "fable", T1);
      expect(
        (await repo.listKeyStatuses({ keyType: "CT_TYPE" })).map((r) => [
          r.detectedPlanRaw,
          r.lastSeatMismatchAt,
          r.lastSeatMismatchModel,
        ]),
      ).toEqual([
        ["raw", T1, "fable"],
        ["raw", T1, "fable"],
      ]);
    });

    test("rate limits: mark, never shorten a bench, expire, clear", async () => {
      const mark = (until: string, spendCap: string | null = null) =>
        repo.markRateLimited(ref("k1"), {
          keyIndex: 0,
          rateLimitedUntil: until,
          spendCap,
          provider: "claude",
          now: T0,
          benchThreshold: 2,
        });
      await mark(T2, '{"x":1}');
      let [row] = await repo.listKeyStatuses({ keyType: "CT_TYPE" });
      expect(row).toMatchObject({
        status: "rate_limited",
        rateLimitedUntil: T2,
        rateLimitCount: 1,
        spendCap: '{"x":1}',
      });
      // No bench: a later write may shorten the limit.
      await mark(T1);
      [row] = await repo.listKeyStatuses({ keyType: "CT_TYPE" });
      expect(row).toMatchObject({ rateLimitedUntil: T1, rateLimitCount: 2, spendCap: null });

      // Two auth failures reach the bench threshold: the limit only extends.
      expect(await repo.recordAuthFailure(ref("k1"), 0, "claude", T0)).toEqual({
        consecutiveAuthFailures: 1,
        rateLimitedUntil: T1,
      });
      await repo.recordAuthFailure(ref("k1"), 0, "claude", T0);
      await mark(T0);
      [row] = await repo.listKeyStatuses({ keyType: "CT_TYPE" });
      expect(row).toMatchObject({ rateLimitedUntil: T1, consecutiveAuthFailures: 2 });
      await mark(T2);
      [row] = await repo.listKeyStatuses({ keyType: "CT_TYPE" });
      expect(row?.rateLimitedUntil).toBe(T2);

      // A benched key does not expire through clearExpiredRateLimits.
      await repo.clearExpiredRateLimits({ keyType: "CT_TYPE", suffixes: ["k1"] }, "2027-01-01", 2);
      [row] = await repo.listKeyStatuses({ keyType: "CT_TYPE" });
      expect(row?.status).toBe("rate_limited");
      await repo.clearExpiredRateLimits({ keyType: "CT_TYPE", suffixes: ["k1"] }, "2027-01-01", 3);
      [row] = await repo.listKeyStatuses({ keyType: "CT_TYPE" });
      expect(row).toMatchObject({ status: "available", rateLimitedUntil: null, spendCap: null });

      await mark(T2);
      expect(
        await repo.clearRateLimit("CT_TYPE", "k1", {
          now: T1,
          liftAuthBench: false,
          authFence: null,
          benchThreshold: 2,
        }),
      ).toBe(0);
      expect(
        await repo.clearRateLimit("CT_TYPE", "k1", {
          now: T1,
          liftAuthBench: true,
          authFence: 1,
          benchThreshold: 2,
        }),
      ).toBe(0);
      expect(
        await repo.clearRateLimit("CT_TYPE", "k1", {
          now: T1,
          liftAuthBench: true,
          authFence: 2,
          benchThreshold: 2,
        }),
      ).toBe(1);
    });

    test("auth failures take the next global sequence; bench and lift", async () => {
      expect(await repo.recordAuthFailure(ref("k1"), 0, "codex", T0)).toEqual({
        consecutiveAuthFailures: 1,
        rateLimitedUntil: null,
      });
      await repo.recordAuthFailure(ref("k2", "agent", "a"), 0, "codex", T0);
      await repo.recordAuthFailure(ref("k1"), 0, "codex", T0);
      const seq = Object.fromEntries(
        (await repo.listKeyStatuses({ keyType: "CT_TYPE" })).map((r) => [
          r.keySuffix,
          r.authFailureSeq,
        ]),
      );
      expect(seq).toEqual({ k1: 3, k2: 2 });
      await repo.benchKey(ref("k1"), T2, T0);
      // Another login at the same slot of the same scope.
      await repo.recordAuthFailure(ref("k3"), 0, "codex", T0);
      await repo.benchKey(ref("k3"), T2, T0);
      // The fence is below k1's sequence: k1 stays benched, k3 retires.
      const lifted = await repo.liftAuthBench(ref("k1"), { keyIndex: 0, authFence: 2, now: T1 });
      expect(lifted).toEqual(["k3"]);
      const lifted2 = await repo.liftAuthBench(ref("k1"), { keyIndex: 0, authFence: 3, now: T1 });
      expect(lifted2).toEqual(["k1"]);
      const rows = await repo.listKeyStatuses({ keyType: "CT_TYPE", scope: "global" });
      expect(rows.map((r) => [r.keySuffix, r.status, r.consecutiveAuthFailures])).toEqual([
        // Ties within a key type order by status (the lookup index).
        ["k3", "available", 0],
        ["k1", "rate_limited", 0],
      ]);
    });

    test("window snapshots round trip and names set per scope row", async () => {
      expect(await repo.getRateLimitWindows(ref("k1"))).toBeNull();
      await repo.upsertRateLimitWindows(ref("k1"), {
        keyIndex: 2,
        rateLimitWindows: '{"five_hour":{}}',
        providerAccount: null,
        provider: "claude",
        now: T0,
      });
      expect(await repo.getRateLimitWindows(ref("k1"))).toEqual({
        rateLimitWindows: '{"five_hour":{}}',
        providerAccount: null,
      });
      expect(await repo.setKeyName(ref("k1"), "main", T1)).toBe(1);
      expect(await repo.setKeyName(ref("k1", "agent", "a"), "main", T1)).toBe(0);
      const [row] = await repo.listKeyStatuses({ keyType: "CT_TYPE" });
      expect(row).toMatchObject({ name: "main", keyIndex: 2, updatedAt: T1 });
    });

    test("validation results: store, clear in every scope, retire absent", async () => {
      const fail = (suffix: string, scope = "global", scopeId = "") =>
        repo.upsertValidation(ref(suffix, scope, scopeId), {
          keyIndex: 0,
          error: "HTTP 401",
          failedAt: T0,
          provider: "claude",
          now: T0,
        });
      await fail("k1");
      await fail("k1", "agent", "a");
      await fail("k2");
      await fail("k3");
      await repo.clearValidation("CT_TYPE", "k1", T1);
      await repo.clearValidationExcept("CT_TYPE", "global", "", ["k2"], T1);
      const rows = await repo.listKeyStatuses({ keyType: "CT_TYPE" });
      expect(
        rows.map((r) => [r.keySuffix, r.scope, r.lastValidationError, r.lastValidationFailedAt]),
      ).toEqual([
        ["k1", "agent", null, null],
        ["k1", "global", null, null],
        ["k2", "global", "HTTP 401", T0],
        ["k3", "global", null, null],
      ]);
      await repo.clearValidationExcept("CT_TYPE", "global", "", [], T1);
      expect(
        (await repo.listKeyStatuses({ keyType: "CT_TYPE" })).every(
          (r) => r.lastValidationError === null,
        ),
      ).toBe(true);
    });

    test("admission rows by suffix across scopes or by scope", async () => {
      await repo.upsertKeyUsage(ref("k2"), 0, "claude", T0);
      await repo.upsertKeyUsage(ref("k1", "agent", "a"), 1, "claude", T0);
      await repo.upsertKeyUsage(ref("k1"), 1, "claude", T0);
      expect(
        (await repo.listAdmissionRows({ keyType: "CT_TYPE", suffixes: ["k1"] })).map((r) => [
          r.keySuffix,
          r.scope,
        ]),
      ).toEqual([
        ["k1", "agent"],
        ["k1", "global"],
      ]);
      const scoped = await repo.listAdmissionRows({
        keyType: "CT_TYPE",
        scope: "global",
        scopeId: "",
      });
      expect(scoped.map((r) => r.keySuffix)).toEqual(["k2", "k1"]);
      expect(scoped[0]).toEqual({
        keyIndex: 0,
        keySuffix: "k2",
        scope: "global",
        scopeId: "",
        status: "available",
        rateLimitWindows: "{}",
        plan: null,
        authFailureSeq: 0,
        lastValidationFailedAt: null,
        spendCap: null,
      });
    });

    test("pool retirement: delete, reindex and delete by slot", async () => {
      await repo.upsertKeyUsage(ref("k1"), 0, "codex", T0);
      await repo.upsertKeyUsage(ref("k2"), 1, "codex", T0);
      await repo.upsertKeyUsage(ref("k3", "agent", "a"), 1, "codex", T0);
      await repo.deleteGlobalKey("CT_TYPE", "k1");
      await repo.setGlobalKeyIndex("CT_TYPE", "k2", 0);
      await repo.setGlobalKeyIndex("CT_TYPE", "k3", 9);
      expect(
        (await repo.listKeyStatuses({ keyType: "CT_TYPE" })).map((r) => [r.keySuffix, r.keyIndex]),
      ).toEqual([
        ["k2", 0],
        ["k3", 1],
      ]);
      expect(await repo.deleteGlobalKeysAtSlot("CT_TYPE", 5, "k2")).toEqual(["k2"]);
      expect(await repo.deleteGlobalKeysAtSlot("CT_TYPE", 1, null)).toEqual([]);
    });

    test("agent-scoped values, scoped keys and scope-key deletes", async () => {
      await repo.insertConfig(
        newConfig({ scope: "agent", scopeId: "z-agent", key: "CT_P", value: "x" }),
      );
      await repo.insertConfig(
        newConfig({ scope: "agent", scopeId: "a-agent", key: "CT_P", value: "x" }),
      );
      await repo.insertConfig(
        newConfig({ scope: "agent", scopeId: "m-agent", key: "CT_P", value: "y" }),
      );
      await repo.insertConfig(newConfig({ scope: "global", key: "CT_P", value: "x" }));
      // Insertion order, not scopeId order.
      expect(await repo.listAgentScopeIdsWithValue("CT_P", "x")).toEqual(["z-agent", "a-agent"]);
      expect(await repo.listAgentScopeIdsWithValue("CT_P", "none")).toEqual([]);

      await repo.insertConfig(newConfig({ scope: "repo", scopeId: "r1", key: "CT_B", value: "1" }));
      await repo.insertConfig(
        newConfig({ scope: "repo", scopeId: "r1", key: "CT_A", value: "1", isSecret: true }),
      );
      await repo.insertConfig(newConfig({ scope: "repo", scopeId: "r1", key: "CT_C", value: "1" }));
      const keys = ["CT_A", "CT_B"];
      expect(await repo.listScopedKeys("repo", "r1", keys, { includeSecrets: true })).toEqual([
        "CT_A",
        "CT_B",
      ]);
      expect(await repo.listScopedKeys("repo", "r1", keys, { includeSecrets: false })).toEqual([
        "CT_B",
      ]);
      expect(await repo.listScopedKeys("repo", "r2", keys, { includeSecrets: true })).toEqual([]);

      expect(await repo.deleteConfigByScopeKey("agent", "a-agent", "CT_P")).toBe(1);
      expect(await repo.deleteConfigByScopeKey("agent", "a-agent", "CT_P")).toBe(0);
      expect(await repo.deleteConfigByScopeKey("global", null, "CT_P")).toBe(1);
      expect(await repo.findConfigByScopeKey("agent", "z-agent", "CT_P")).not.toBeNull();
    });

    test("listRepoNamesAndUrls returns every repo in insertion order", async () => {
      for (const name of ["zeta", "alpha"]) {
        await repo.insertRepo({
          id: `id-${name}`,
          url: `https://x/${name}`,
          name,
          clonePath: `/w/${name}`,
          defaultBranch: "main",
          autoClone: false,
          hooks: "{}",
          guidelines: null,
          now: T0,
        });
      }
      expect(await repo.listRepoNamesAndUrls()).toEqual([
        { name: "zeta", url: "https://x/zeta" },
        { name: "alpha", url: "https://x/alpha" },
      ]);
    });
  });
}
