import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  cleanupStack,
  fakeJwt,
  jsonResponse,
  putConfig,
  startMockServer,
} from "./platform-helpers";

// Credential-pool telemetry that workers report (usage, rate limits, auth failures,
// validation, seat mismatch), the read side the dashboard and the claim path use
// (available, status, costs, plans), the pool-key config routes, and the Codex ChatGPT
// account routes that share the same key-status table.

type KeyStatus = Record<string, unknown> & {
  keySuffix: string;
  keyIndex: number;
  status: string;
};

async function keyStatuses(ctx: ScenarioContext, keyType: string): Promise<KeyStatus[]> {
  const response = await ctx.api("GET", `/api/keys/status?keyType=${keyType}`);
  expectStatus(response, [200], `status ${keyType}`);
  expect(asRecord(response.json).success === true, "status answers success: true");
  return asRecords(response.json, "keys") as KeyStatus[];
}

async function statusOf(ctx: ScenarioContext, keyType: string, suffix: string): Promise<KeyStatus> {
  const found = (await keyStatuses(ctx, keyType)).find((key) => key.keySuffix === suffix);
  expect(found, `status lists ${keyType} ...${suffix}`);
  return found;
}

async function available(ctx: ScenarioContext, query: string) {
  const response = await ctx.api("GET", `/api/keys/available?${query}`);
  expectStatus(response, [200], `available ${query}`);
  const body = asRecord(response.json);
  expect(body.success === true, "available answers success: true");
  return body as {
    availableIndices: number[];
    rejectedIndices: number[];
    totalKeys: number;
    authFailureFence: number;
    modelBlockedIndices?: number[];
    earliestModelResetAt?: string | null;
    seatBlockedIndices?: number[];
  };
}

async function report(ctx: ScenarioContext, path: string, body: Record<string, unknown>) {
  const response = await ctx.api("POST", `/api/keys/${path}`, { body });
  expectStatus(response, [200], `report ${path}`);
  expect(asRecord(response.json).success === true, `${path} answers success: true`);
  return asRecord(response.json);
}

export const platformKeys: Scenario = {
  name: "platform-keys",
  order: 610,
  async run(ctx) {
    // A key type no provider owns keeps these rows out of every real pool.
    const keyType = `E2E_POOL_${ctx.nonce}`.toUpperCase();
    const suffixA = `a${ctx.nonce.slice(0, 8)}`;
    const suffixB = `b${ctx.nonce.slice(0, 8)}`;
    const future = new Date(Date.now() + 3_600_000).toISOString();

    // ── auth and validation on every route ───────────────────────────────────
    const noAuth: Array<[string, string, unknown?]> = [
      ["GET", `/api/keys/available?keyType=${keyType}&totalKeys=1`],
      ["GET", "/api/keys/status"],
      ["GET", "/api/keys/costs"],
      ["GET", "/api/keys/plans"],
      ["POST", "/api/keys/report-usage", { keyType, keySuffix: "x", keyIndex: 0 }],
      [
        "POST",
        "/api/keys/report-rate-limit",
        { keyType, keySuffix: "x", keyIndex: 0, rateLimitedUntil: future },
      ],
      ["POST", "/api/keys/clear-rate-limit", { keyType, keySuffix: "x" }],
      ["PATCH", "/api/keys/name", { keyType, keySuffix: "x", name: null }],
      ["PATCH", "/api/keys/plan", { keyType, keySuffix: "x", plan: null }],
    ];
    for (const [method, path, body] of noAuth) {
      expectStatus(
        await ctx.api(method, path, { apiKey: null, body }),
        [401],
        `${method} ${path} unauth`,
      );
    }
    const bad: Array<[string, unknown, string]> = [
      ["report-usage", { keySuffix: "x", keyIndex: 0 }, "missing keyType"],
      ["report-usage", { keyType, keySuffix: "x".repeat(11), keyIndex: 0 }, "suffix over 10 chars"],
      ["report-usage", { keyType, keySuffix: "x", keyIndex: -1 }, "negative keyIndex"],
      [
        "report-usage",
        { keyType, keySuffix: "x", keyIndex: 0, taskId: "not-a-uuid" },
        "non-uuid taskId",
      ],
      [
        "report-rate-limit",
        { keyType, keySuffix: "x", keyIndex: 0, rateLimitedUntil: "tomorrow" },
        "non-ISO rateLimitedUntil",
      ],
      ["report-validation", { keyType, keys: [] }, "empty keys list"],
      ["report-auth-failure", { keyType, keySuffix: "x" }, "missing keyIndex"],
      [
        "report-rate-limit-windows",
        { keyType, keySuffix: "x", keyIndex: 0, windows: { five_hour: { status: "allowed" } } },
        "window without lastSeenAt",
      ],
      [
        "report-seat-mismatch",
        { keyType, keySuffix: "x", keyIndex: 0, model: "gpt" },
        "unknown model family",
      ],
      ["clear-rate-limit", { keySuffix: "x" }, "missing keyType"],
    ];
    for (const [path, body, label] of bad) {
      expectStatus(await ctx.api("POST", `/api/keys/${path}`, { body }), [400], `${path} ${label}`);
    }
    expectStatus(
      await ctx.api("GET", "/api/keys/available?keyType=x"),
      [400],
      "available without totalKeys",
    );
    expectStatus(
      await ctx.api("GET", "/api/keys/available?keyType=x&totalKeys=0"),
      [400],
      "available with totalKeys=0",
    );
    expectStatus(
      await ctx.api("GET", "/api/keys/available?keyType=x&totalKeys=2&keySuffixes=only-one"),
      [400],
      "available with a keySuffixes list of the wrong length",
    );

    // ── usage ────────────────────────────────────────────────────────────────
    const task = await ctx.api("POST", "/api/tasks", {
      body: { task: `key usage ${ctx.nonce}`, source: "api" },
    });
    expectStatus(task, [201], "create a task to attribute");
    const taskId = String(asRecord(task.json).id);
    const used = await report(ctx, "report-usage", {
      keyType,
      keySuffix: suffixA,
      keyIndex: 0,
      taskId,
    });
    expect(String(used.message).length > 0, "report-usage acknowledges with a message");
    await report(ctx, "report-usage", { keyType, keySuffix: suffixA, keyIndex: 0 });
    await report(ctx, "report-usage", { keyType, keySuffix: suffixB, keyIndex: 1 });
    const row = ctx.db.get<{
      credentialKeySuffix: string | null;
      credentialKeyType: string | null;
    }>("SELECT credentialKeySuffix, credentialKeyType FROM agent_tasks WHERE id = ?", [taskId]);
    expect(
      row?.credentialKeySuffix === suffixA && row?.credentialKeyType === keyType,
      "report-usage stamps the credential on the task",
    );
    const statusA = await statusOf(ctx, keyType, suffixA);
    expect(
      statusA.totalUsageCount === 2 && statusA.status === "available",
      "two usages are counted",
    );
    expect(
      statusA.scope === "global" && statusA.keyIndex === 0,
      "keys default to the global scope",
    );
    expect(typeof statusA.lastUsedAt === "string", "usage stamps lastUsedAt");
    expect(Array.isArray(statusA.modelLimits), "status carries the derived modelLimits view");
    expect(
      (await keyStatuses(ctx, keyType)).length === 2,
      "the key type filter lists exactly the reported keys",
    );
    const scoped = await ctx.api(
      "GET",
      `/api/keys/status?keyType=${keyType}&scope=agent&scopeId=none`,
    );
    expect(asRecords(scoped.json, "keys").length === 0, "the scope filter hides global keys");

    // ── rate limit, clear, expiry ────────────────────────────────────────────
    await report(ctx, "report-rate-limit", {
      keyType,
      keySuffix: suffixA,
      keyIndex: 0,
      rateLimitedUntil: future,
    });
    const limited = await statusOf(ctx, keyType, suffixA);
    expect(
      limited.status === "rate_limited" &&
        limited.rateLimitedUntil === future &&
        limited.rateLimitCount === 1,
      "report-rate-limit marks the key rate limited",
    );
    expect(
      (await available(ctx, `keyType=${keyType}&totalKeys=2`)).availableIndices.join() === "1",
      "a rate-limited key index is not available",
    );
    // keySuffixes matches by suffix and returns positions in the caller's list.
    expect(
      (
        await available(ctx, `keyType=${keyType}&totalKeys=2&keySuffixes=${suffixB},${suffixA}`)
      ).availableIndices.join() === "0",
      "keySuffixes reports positions in the caller's pool order",
    );
    const cleared = await report(ctx, "clear-rate-limit", { keyType, keySuffix: suffixA });
    expect(cleared.cleared === true, "clear-rate-limit lifts a rate limit");
    const clearedAgain = await report(ctx, "clear-rate-limit", { keyType, keySuffix: suffixA });
    expect(
      clearedAgain.cleared === false &&
        String(clearedAgain.message).includes("was not rate-limited"),
      "clearing a healthy key is a no-op",
    );
    expect(
      (await available(ctx, `keyType=${keyType}&totalKeys=2`)).availableIndices.join() === "0,1",
      "both keys are available again",
    );
    // A rate limit that already expired heals on the next read.
    await report(ctx, "report-rate-limit", {
      keyType,
      keySuffix: suffixB,
      keyIndex: 1,
      rateLimitedUntil: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(
      (await available(ctx, `keyType=${keyType}&totalKeys=2`)).availableIndices.join() === "0,1",
      "an expired rate limit no longer blocks the key",
    );
    expect(
      (await statusOf(ctx, keyType, suffixB)).status === "available",
      "the expired limit is reset to available",
    );

    // ── auth failures bench a key until a fenced proof of health ─────────────
    const first = await report(ctx, "report-auth-failure", {
      keyType,
      keySuffix: suffixA,
      keyIndex: 0,
    });
    expect(
      first.consecutiveAuthFailures === 1 && first.benched === false,
      "one auth failure does not bench",
    );
    const second = await report(ctx, "report-auth-failure", {
      keyType,
      keySuffix: suffixA,
      keyIndex: 0,
    });
    expect(
      second.consecutiveAuthFailures === 2 &&
        second.benched === true &&
        typeof second.rateLimitedUntil === "string",
      "the second consecutive auth failure benches the key",
    );
    const benched = await available(ctx, `keyType=${keyType}&totalKeys=2`);
    expect(benched.availableIndices.join() === "1", "a benched key is not available");
    expect(benched.authFailureFence >= 2, "available hands out the auth-failure fence");
    const plain = await report(ctx, "clear-rate-limit", { keyType, keySuffix: suffixA });
    expect(plain.cleared === false, "a plain clear does not lift an auth bench");
    const stale = await report(ctx, "clear-rate-limit", {
      keyType,
      keySuffix: suffixA,
      clearAuthBench: true,
      keyIndex: 0,
      authFence: 0,
    });
    expect(stale.cleared === false, "a clear with a stale fence keeps the bench");
    const fenced = await report(ctx, "clear-rate-limit", {
      keyType,
      keySuffix: suffixA,
      clearAuthBench: true,
      keyIndex: 0,
      authFence: benched.authFailureFence,
    });
    expect(fenced.cleared === true, "a clear with the current fence lifts the bench");
    expect(
      (await statusOf(ctx, keyType, suffixA)).consecutiveAuthFailures === 0,
      "lifting the bench resets the counter",
    );
    expect(
      (await available(ctx, `keyType=${keyType}&totalKeys=2`)).availableIndices.join() === "0,1",
      "the unbenched key is available",
    );

    // ── live validation results ──────────────────────────────────────────────
    await report(ctx, "report-validation", {
      keyType,
      keys: [
        { keyIndex: 0, keySuffix: suffixA, ok: false, httpStatus: 401 },
        { keyIndex: 1, keySuffix: suffixB, ok: true },
      ],
    });
    const validated = await available(ctx, `keyType=${keyType}&totalKeys=2`);
    expect(
      validated.rejectedIndices.join() === "0" && validated.availableIndices.join() === "1",
      "a key that failed live validation is rejected and unavailable",
    );
    const rejectedStatus = await statusOf(ctx, keyType, suffixA);
    expect(
      typeof rejectedStatus.lastValidationFailedAt === "string" &&
        rejectedStatus.lastValidationError !== null,
      "status shows the validation failure",
    );
    await report(ctx, "report-validation", {
      keyType,
      keys: [{ keyIndex: 0, keySuffix: suffixA, ok: true }],
    });
    expect(
      (await available(ctx, `keyType=${keyType}&totalKeys=2`)).rejectedIndices.length === 0,
      "a passing validation clears the rejection",
    );

    // ── provider rate-limit windows and seat mismatch ────────────────────────
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
    const lastSeenAt = new Date().toISOString();
    await report(ctx, "report-rate-limit-windows", {
      keyType,
      keySuffix: suffixA,
      keyIndex: 0,
      windows: {
        five_hour: { status: "allowed", utilization: 0.4, resetsAt, lastSeenAt },
        seven_day_opus: { status: "rejected", resetsAt, lastSeenAt },
      },
    });
    const windowed = await statusOf(ctx, keyType, suffixA);
    const windows = asRecord(windowed.rateLimitWindows);
    expect(
      asRecord(windows.five_hour).utilization === 0.4 &&
        asRecord(windows.seven_day_opus).status === "rejected",
      "status carries the reported windows",
    );
    const limits = windowed.modelLimits as Array<Record<string, unknown>>;
    expect(
      limits.some((l) => l.model === "opus" && l.window === "seven_day_opus" && l.active === true),
      "a rejected model window shows up as an active model limit",
    );
    const forOpus = await available(ctx, `keyType=${keyType}&totalKeys=2&model=opus`);
    expect(
      forOpus.modelBlockedIndices?.join() === "0",
      "available excludes a key whose opus window is rejected",
    );
    expect(forOpus.availableIndices.join() === "1", "the other key still runs opus");
    expect(
      typeof forOpus.earliestModelResetAt === "string",
      "available reports the earliest model reset",
    );
    const forHaiku = await available(ctx, `keyType=${keyType}&totalKeys=2&model=haiku`);
    expect(
      forHaiku.modelBlockedIndices?.length === 0 && forHaiku.availableIndices.join() === "0,1",
      "other families are unaffected",
    );
    expect(
      (await available(ctx, `keyType=${keyType}&totalKeys=2`)).modelBlockedIndices === undefined,
      "model fields are only present when a model is asked for",
    );
    await report(ctx, "report-seat-mismatch", {
      keyType,
      keySuffix: suffixB,
      keyIndex: 1,
      model: "fable",
    });
    const mismatched = await statusOf(ctx, keyType, suffixB);
    expect(
      mismatched.lastSeatMismatchModel === "fable" &&
        typeof mismatched.lastSeatMismatchAt === "string",
      "report-seat-mismatch is recorded on the key",
    );

    // ── names ────────────────────────────────────────────────────────────────
    const named = await ctx.api("PATCH", "/api/keys/name", {
      body: { keyType, keySuffix: suffixA, name: `Primary ${ctx.nonce}` },
    });
    expectStatus(named, [200], "name a key");
    expect(asRecord(named.json).name === `Primary ${ctx.nonce}`, "the name is echoed");
    expect(
      (await statusOf(ctx, keyType, suffixA)).name === `Primary ${ctx.nonce}`,
      "status shows the name",
    );
    const unnamed = await ctx.api("PATCH", "/api/keys/name", {
      body: { keyType, keySuffix: suffixA, name: "" },
    });
    expectStatus(unnamed, [200], "clear a key name with an empty string");
    expect(asRecord(unnamed.json).name === null, "an empty name clears the label");
    expectStatus(
      await ctx.api("PATCH", "/api/keys/name", { body: { keyType, keySuffix: "nope", name: "x" } }),
      [404],
      "name an unknown key",
    );
    expectStatus(
      await ctx.api("PATCH", "/api/keys/name", {
        body: { keyType, keySuffix: suffixA, name: "x".repeat(61) },
      }),
      [400],
      "name over 60 chars",
    );

    // ── plans ────────────────────────────────────────────────────────────────
    const plans = await ctx.api("GET", "/api/keys/plans");
    expectStatus(plans, [200], "list plans");
    const catalog = asRecords(plans.json, "plans");
    expect(
      typeof asRecord(plans.json).checkedAt === "string",
      "the plan catalog carries checkedAt",
    );
    for (const id of ["claude_pro", "claude_team_standard", "chatgpt_plus"]) {
      const plan = catalog.find((p) => p.id === id);
      expect(
        plan &&
          typeof plan.label === "string" &&
          typeof plan.monthlyUsd === "number" &&
          typeof plan.keyType === "string",
        `plan ${id} has label, keyType and a monthly price`,
      );
    }
    // Plans only apply to their credential type, so use a real OAuth key type with a unique suffix.
    const claudeType = "CLAUDE_CODE_OAUTH_TOKEN";
    const claudeSuffix = `p${ctx.nonce.slice(0, 8)}`;
    await report(ctx, "report-usage", {
      keyType: claudeType,
      keySuffix: claudeSuffix,
      keyIndex: 9,
      plan: "claude_pro",
    });
    const detected = await statusOf(ctx, claudeType, claudeSuffix);
    expect(
      detected.plan === "claude_pro" && detected.planSource === "detected",
      "report-usage records a detected plan",
    );
    const planned = await ctx.api("PATCH", "/api/keys/plan", {
      body: { keyType: claudeType, keySuffix: claudeSuffix, plan: "claude_team_standard" },
    });
    expectStatus(planned, [200], "set a plan");
    expect(asRecord(planned.json).plan === "claude_team_standard", "the plan is echoed");
    const manual = await statusOf(ctx, claudeType, claudeSuffix);
    expect(
      manual.plan === "claude_team_standard" && manual.planSource === "manual",
      "a set plan is manual",
    );
    // A manual plan wins over a later detected one.
    await report(ctx, "report-usage", {
      keyType: claudeType,
      keySuffix: claudeSuffix,
      keyIndex: 9,
      plan: "claude_pro",
    });
    expect(
      (await statusOf(ctx, claudeType, claudeSuffix)).plan === "claude_team_standard",
      "detection does not override a manual plan",
    );
    const seat = await available(
      ctx,
      `keyType=${claudeType}&totalKeys=1&model=fable&keySuffixes=${claudeSuffix}`,
    );
    expect(
      seat.seatBlockedIndices?.join() === "0" && seat.availableIndices.length === 0,
      "a team standard seat cannot run fable, so available blocks it",
    );
    expectStatus(
      await ctx.api("PATCH", "/api/keys/plan", {
        body: { keyType: claudeType, keySuffix: claudeSuffix, plan: "chatgpt_plus" },
      }),
      [400],
      "set a plan of another credential type",
    );
    expectStatus(
      await ctx.api("PATCH", "/api/keys/plan", {
        body: { keyType: claudeType, keySuffix: claudeSuffix, plan: "no_such_plan" },
      }),
      [400],
      "set an unknown plan",
    );
    expectStatus(
      await ctx.api("PATCH", "/api/keys/plan", {
        body: { keyType: claudeType, keySuffix: "nokey", plan: "claude_pro" },
      }),
      [404],
      "set a plan on an unknown key",
    );
    const planCleared = await ctx.api("PATCH", "/api/keys/plan", {
      body: { keyType: claudeType, keySuffix: claudeSuffix, plan: null },
    });
    expectStatus(planCleared, [200], "clear the manual plan");
    expect(asRecord(planCleared.json).plan === null, "a null plan clears the manual plan");
    expect(
      (await statusOf(ctx, claudeType, claudeSuffix)).planSource === null,
      "the cleared plan has no source",
    );

    // ── costs ────────────────────────────────────────────────────────────────
    const costs = await ctx.api("GET", `/api/keys/costs?keyType=${keyType}`);
    expectStatus(costs, [200], "key costs");
    expect(asRecord(costs.json).success === true, "costs answer success: true");
    const costRows = asRecords(costs.json, "costs");
    expect(
      costRows.every(
        (c) =>
          c.keyType === keyType &&
          typeof c.totalCost === "number" &&
          typeof c.taskCount === "number" &&
          typeof c.totalInputTokens === "number",
      ),
      "cost rows are typed and match the key type filter",
    );
    expectStatus(await ctx.api("GET", "/api/keys/costs"), [200], "key costs for every type");
  },
};

const NAN_KEY = "NAN_API_KEY";

export const platformPoolKeys: Scenario = {
  name: "platform-pool-keys",
  order: 615,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    // A stand-in provider: any key containing "reject" gets a 401 from GET /models.
    const provider = startMockServer((request) => {
      const auth = request.headers.get("authorization") ?? "";
      if (request.path.endsWith("/models") && auth.includes("reject")) {
        return jsonResponse({ error: { message: "Invalid API key." } }, 401);
      }
      return jsonResponse({ data: [] });
    });
    cleanup.add("stop provider mock", async () => provider.stop());
    const good = `nan-${ctx.nonce}-good1`;
    const goodSuffix = good.slice(-5);
    const second = `nan-${ctx.nonce}-good2`;
    const baseUrl = `${provider.origin}/v1`;
    try {
      // ── guards ─────────────────────────────────────────────────────────────
      expectStatus(
        await ctx.api("GET", `/api/config/pool-keys?key=${NAN_KEY}`, { apiKey: null }),
        [401],
        "pool unauth",
      );
      expectStatus(
        await ctx.api("GET", "/api/config/pool-keys?key=NOT_A_POOL"),
        [400],
        "pool of a non-credential var",
      );
      expectStatus(
        await ctx.api("GET", "/api/config/pool-keys?key=CODEX_OAUTH"),
        [400],
        "CODEX_OAUTH is not a generic pool",
      );
      expectStatus(await ctx.api("GET", "/api/config/pool-keys"), [400], "pool without key");

      // A pool that comes from the deployment env is read-only.
      const envPool = await ctx.api("GET", "/api/config/pool-keys?key=OPENROUTER_API_KEY");
      expectStatus(envPool, [200], "read the env-backed OpenRouter pool");
      const envBody = asRecord(envPool.json);
      expect(
        envBody.source === "env" && envBody.readOnly === true,
        "a deployment-env pool is read-only",
      );
      expectStatus(
        await ctx.api("POST", "/api/config/pool-keys", {
          body: { key: "OPENROUTER_API_KEY", value: "sk-or-e2e-would-be-new", baseUrl },
        }),
        [409],
        "append to an env-backed pool",
      );
      expectStatus(
        await ctx.api(
          "DELETE",
          "/api/config/pool-keys?key=OPENROUTER_API_KEY&index=0&suffix=abcde",
        ),
        [409],
        "delete from an env-backed pool",
      );

      const empty = await ctx.api("GET", `/api/config/pool-keys?key=${NAN_KEY}`);
      expectStatus(empty, [200], "read an empty pool");
      expect(
        asRecord(empty.json).source === "none" && asRecords(empty.json, "keys").length === 0,
        "an unconfigured pool is empty",
      );

      // ── append ─────────────────────────────────────────────────────────────
      expectStatus(
        await ctx.api("POST", "/api/config/pool-keys", {
          body: { key: NAN_KEY, value: " , ", baseUrl },
        }),
        [400],
        "append no key",
      );
      expectStatus(
        await ctx.api("POST", "/api/config/pool-keys", {
          body: { key: NAN_KEY, value: "has space", baseUrl },
        }),
        [400],
        "append a key with whitespace",
      );
      const rejected = await ctx.api("POST", "/api/config/pool-keys", {
        body: { key: NAN_KEY, value: `nan-${ctx.nonce}-reject`, baseUrl },
      });
      expectStatus(rejected, [422], "append a key the provider rejects");
      const rejectedBody = asRecord(rejected.json);
      expect(
        String(rejectedBody.error).includes("Nothing was saved") &&
          asRecords(rejectedBody, "checks")[0]?.result === "rejected" &&
          asRecords(rejectedBody, "checks")[0]?.httpStatus === 401,
        "a rejected key reports the 401 check and saves nothing",
      );
      expect(
        asRecord((await ctx.api("GET", `/api/config/pool-keys?key=${NAN_KEY}`)).json).source ===
          "none",
        "the rejected key was not stored",
      );

      const added = await ctx.api("POST", "/api/config/pool-keys", {
        body: { key: NAN_KEY, value: good, baseUrl },
      });
      expectStatus(added, [200], "append a good key");
      cleanup.add("remove the pool key", async () => {
        await ctx.api(
          "DELETE",
          `/api/config/pool-keys?key=${NAN_KEY}&index=0&suffix=${goodSuffix}`,
        );
      });
      const addedBody = asRecord(added.json);
      expect(
        addedBody.source === "stored" && addedBody.readOnly === false,
        "the pool is now stored",
      );
      expect(
        asRecords(addedBody, "checks")[0]?.result === "verified" &&
          asRecords(addedBody, "checks")[0]?.suffix === goodSuffix,
        "the good key is verified against the provider",
      );
      const member = asRecords(addedBody, "keys")[0];
      expect(
        member?.index === 0 && member.suffix === goodSuffix && member.status === "ok",
        "the pool lists the member by suffix",
      );
      expect(
        provider.requests.some(
          (r) => r.path === "/v1/models" && r.headers.get("authorization") === `Bearer ${good}`,
        ),
        "the provider check sent the key as a bearer to the base URL",
      );
      expect(!JSON.stringify(addedBody).includes(good), "the full key never leaves the server");

      // The stored pool is a secret global config row.
      const stored = await ctx.api("GET", `/api/config?scope=global&key=${NAN_KEY}`);
      const row = asRecords(stored.json, "configs")[0];
      expect(row?.isSecret === true && row.value !== good, "the pool is stored as a masked secret");
      const revealed = await ctx.api(
        "GET",
        `/api/config?scope=global&key=${NAN_KEY}&includeSecrets=true`,
      );
      expect(
        asRecords(revealed.json, "configs")[0]?.value === good,
        "the operator can reveal the pool with includeSecrets",
      );

      expectStatus(
        await ctx.api("POST", "/api/config/pool-keys", {
          body: { key: NAN_KEY, value: good, baseUrl },
        }),
        [409],
        "append a duplicate key",
      );
      const extended = await ctx.api("POST", "/api/config/pool-keys", {
        body: { key: NAN_KEY, value: second, baseUrl },
      });
      expectStatus(extended, [200], "append a second key");
      expect(asRecords(extended.json, "keys").length === 2, "the pool now has two members");

      // ── the pool feeds the key-status routes ───────────────────────────────
      const pool = await available(ctx, `keyType=${NAN_KEY}&totalKeys=2`);
      expect(pool.availableIndices.join() === "0,1", "a seeded pool has both keys available");
      const status = (await keyStatuses(ctx, NAN_KEY)).find((k) => k.keySuffix === goodSuffix);
      expect(
        status && status.status === "available",
        "a verified pool member has a key-status row",
      );
      await report(ctx, "report-rate-limit", {
        keyType: NAN_KEY,
        keySuffix: goodSuffix,
        keyIndex: 0,
        rateLimitedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      });
      expect(
        (await available(ctx, `keyType=${NAN_KEY}&totalKeys=2`)).availableIndices.join() === "1",
        "rate limiting a pool member removes it from available",
      );
      const limitedPool = asRecords(
        (await ctx.api("GET", `/api/config/pool-keys?key=${NAN_KEY}`)).json,
        "keys",
      );
      expect(limitedPool[0]?.status === "rate_limited", "the pool view shows the rate limit");
      await report(ctx, "clear-rate-limit", { keyType: NAN_KEY, keySuffix: goodSuffix });

      // ── delete ─────────────────────────────────────────────────────────────
      expectStatus(
        await ctx.api("DELETE", `/api/config/pool-keys?key=${NAN_KEY}&index=0&suffix=zzzzz`),
        [409],
        "delete with a stale suffix",
      );
      expectStatus(
        await ctx.api(
          "DELETE",
          `/api/config/pool-keys?key=${NAN_KEY}&index=5&suffix=${goodSuffix}`,
        ),
        [409],
        "delete an out-of-range index",
      );
      expectStatus(
        await ctx.api(
          "DELETE",
          `/api/config/pool-keys?key=${NAN_KEY}&index=0&suffix=${goodSuffix}`,
          { apiKey: null },
        ),
        [401],
        "delete unauth",
      );
      const afterFirst = await ctx.api(
        "DELETE",
        `/api/config/pool-keys?key=${NAN_KEY}&index=0&suffix=${goodSuffix}`,
      );
      expectStatus(afterFirst, [200], "delete the first member");
      const remaining = asRecords(afterFirst.json, "keys");
      expect(
        remaining.length === 1 &&
          remaining[0]?.suffix === second.slice(-5) &&
          remaining[0]?.index === 0,
        "the pool shifts down",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM api_key_status WHERE keyType = ? AND keySuffix = ?", [
          NAN_KEY,
          goodSuffix,
        ]) === null,
        "deleting a member retires its key-status row",
      );
      const last = await ctx.api(
        "DELETE",
        `/api/config/pool-keys?key=${NAN_KEY}&index=0&suffix=${second.slice(-5)}`,
      );
      expectStatus(last, [200], "delete the last member");
      expect(
        asRecords(last.json, "keys").length === 0 && asRecord(last.json).source === "none",
        "an emptied pool drops its config row",
      );
      expect(
        asRecords((await ctx.api("GET", `/api/config?scope=global&key=${NAN_KEY}`)).json, "configs")
          .length === 0,
        "the config row is gone",
      );
    } finally {
      await cleanup.run();
    }
  },
};

export const platformCodexAccounts: Scenario = {
  name: "platform-codex-accounts",
  order: 620,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const slot = 96;
    const configKey = `codex_oauth_${slot}`;
    const accountId = `acct-${ctx.nonce}`;
    const userId = `user-${ctx.nonce}`;
    const email = `codex-${ctx.nonce}@example.com`;
    const creds = {
      access: fakeJwt({
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_user_id: userId },
        "https://api.openai.com/profile": { email },
      }),
      refresh: `refresh-${ctx.nonce}`,
      // Issued about a day ago on a 10-day token: not expiring and not stale for the sweep.
      expires: Date.now() + 9 * 86_400_000,
      accountId,
    };
    try {
      expectStatus(
        await ctx.api("GET", "/api/codex-oauth/accounts", { apiKey: null }),
        [401],
        "accounts unauth",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/codex-oauth/accounts/${slot}`, { apiKey: null }),
        [401],
        "delete account unauth",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth/keep-warm/codex", { apiKey: null }),
        [401],
        "keep-warm unauth",
      );

      const before = await ctx.api("GET", "/api/codex-oauth/accounts");
      expectStatus(before, [200], "list accounts");
      expect(
        !asRecords(before.json, "accounts").some((a) => a.slot === slot),
        "slot 96 starts free",
      );

      const seeded = await putConfig(ctx, {
        key: configKey,
        value: JSON.stringify(creds),
        isSecret: true,
      });
      cleanup.add("delete the codex slot", async () => {
        await ctx.api("DELETE", `/api/codex-oauth/accounts/${slot}`);
      });
      expect(
        seeded.isSecret === true && seeded.value !== JSON.stringify(creds),
        "the credentials row is a masked secret",
      );

      const listed = await ctx.api("GET", "/api/codex-oauth/accounts");
      const account = asRecords(listed.json, "accounts").find((a) => a.slot === slot);
      expect(account, "the seeded slot is listed");
      expect(
        account.configKey === configKey &&
          account.legacy === false &&
          account.plan === "plus" &&
          account.email === email,
        `the account carries plan and email decoded from the JWT: ${JSON.stringify(account)}`,
      );
      expect(
        account.suffix === userId.slice(-5),
        "the key suffix derives from the chatgpt user id",
      );
      expect(account.status === "unchecked", "an account no worker has used is unchecked");
      expect(
        !JSON.stringify(listed.json).includes(creds.refresh),
        "the list never carries the refresh token",
      );
      const suffix = String(account.suffix);

      // A key-status row makes the account "ok"; two auth failures bench it.
      await report(ctx, "report-usage", {
        keyType: "CODEX_OAUTH",
        keySuffix: suffix,
        keyIndex: slot,
      });
      expect(
        asRecords((await ctx.api("GET", "/api/codex-oauth/accounts")).json, "accounts").find(
          (a) => a.slot === slot,
        )?.status === "ok",
        "a used account is ok",
      );

      const warm = await ctx.api("POST", "/api/oauth/keep-warm/codex");
      expectStatus(warm, [200], "keep-warm sweep");
      const warmOutcome = asRecords(warm.json, "results").find((r) => r.slot === slot);
      expect(
        warmOutcome?.outcome === "warm" && warmOutcome.keySuffix === suffix,
        `a fresh slot stays warm: ${JSON.stringify(warmOutcome)}`,
      );

      await report(ctx, "report-auth-failure", {
        keyType: "CODEX_OAUTH",
        keySuffix: suffix,
        keyIndex: slot,
      });
      await report(ctx, "report-auth-failure", {
        keyType: "CODEX_OAUTH",
        keySuffix: suffix,
        keyIndex: slot,
      });
      expect(
        asRecords((await ctx.api("GET", "/api/codex-oauth/accounts")).json, "accounts").find(
          (a) => a.slot === slot,
        )?.status === "needs_login",
        "a benched account needs a login",
      );
      const skipped = asRecords(
        (await ctx.api("POST", "/api/oauth/keep-warm/codex")).json,
        "results",
      ).find((r) => r.slot === slot);
      expect(
        skipped?.outcome === "skipped-benched",
        `keep-warm skips a benched slot: ${JSON.stringify(skipped)}`,
      );

      // ── delete ─────────────────────────────────────────────────────────────
      expectStatus(
        await ctx.api("DELETE", "/api/codex-oauth/accounts/101"),
        [400],
        "slot above the maximum",
      );
      expectStatus(
        await ctx.api("DELETE", "/api/codex-oauth/accounts/abc"),
        [400],
        "non-numeric slot",
      );
      expectStatus(
        await ctx.api("DELETE", "/api/codex-oauth/accounts/95"),
        [404],
        "slot that does not exist",
      );
      const removed = await ctx.api("DELETE", `/api/codex-oauth/accounts/${slot}`);
      expectStatus(removed, [200], "delete the account");
      expect(
        !asRecords(removed.json, "accounts").some((a) => a.slot === slot),
        "delete returns the remaining accounts",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM swarm_config WHERE key = ? AND scope = 'global'", [
          configKey,
        ]) === null,
        "the credentials row is deleted",
      );
      expect(
        ctx.db.get(
          "SELECT 1 AS one FROM api_key_status WHERE keyType = 'CODEX_OAUTH' AND keySuffix = ?",
          [suffix],
        ) === null,
        "deleting the account retires its key-status row",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/codex-oauth/accounts/${slot}`),
        [404],
        "delete the account twice",
      );

      // ── device login ───────────────────────────────────────────────────────
      // The checks that precede the upstream call run here. The start, poll and approved-login
      // outcomes run against a loopback stand-in in platform-codex-device-login.
      expectStatus(
        await ctx.api("POST", "/api/codex-oauth/device", { apiKey: null, body: {} }),
        [401],
        "device start unauth",
      );
      expectStatus(
        await ctx.api("POST", "/api/codex-oauth/device", {
          rawBody: "[1,2]",
          headers: { "Content-Type": "application/json" },
        }),
        [400],
        "device start with a non-object body",
      );
      const unknownFlow = await ctx.api(
        "POST",
        `/api/codex-oauth/device/${crypto.randomUUID()}/poll`,
        { body: {} },
      );
      expectStatus(unknownFlow, [200], "poll an unknown flow");
      expect(asRecord(unknownFlow.json).status === "expired", "an unknown flow reads as expired");
      expectStatus(
        await ctx.api("POST", "/api/codex-oauth/device/not-a-uuid/poll", { body: {} }),
        [400],
        "poll with a bad flow id",
      );
    } finally {
      await cleanup.run();
    }
  },
};
