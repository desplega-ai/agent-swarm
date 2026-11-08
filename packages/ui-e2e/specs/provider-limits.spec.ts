import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures";

// Fake credentials only. Every value below is generated for this worker's disposable API.

interface ConfigRow {
  id: string;
  key: string;
}

interface WindowUsageResponse {
  windows: Array<{
    statusId: string;
    windowKey: string;
    usage: { sessions: number; completedTasks: number } | null;
  }>;
}

const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.e2esig`;
}

test("provider limits show current windows, account facts, and Swarm usage", async ({
  page,
  api,
  swarm,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const nonce = randomUUID().replaceAll("-", "");
  const claudeSuffix = nonce.slice(0, 5);
  const claudeMaxSuffix = nonce.slice(5, 10);
  const claudeLabel = `Key ending ${claudeSuffix}`;
  const claudeMaxLabel = `Key ending ${claudeMaxSuffix}`;
  const codexSlot = 91;
  const codexUser = `user-${nonce.slice(10, 20)}`;
  const codexSuffix = `${codexUser.slice(-5)}-${codexSlot}`;
  const codexEmail = `codex-${nonce.slice(0, 8)}@example.test`;
  const now = Date.now();

  const call = async <T>(method: string, path: string, body?: unknown, agentId?: string) => {
    const response = await fetch(`${swarm.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${swarm.apiKey}`,
        "Content-Type": "application/json",
        ...(agentId ? { "X-Agent-ID": agentId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  };
  const report = (body: Record<string, unknown>) =>
    api.post("/api/keys/report-rate-limit-windows", body);

  const agent = await api.post<{ id: string }>("/api/agents", {
    name: `e2e-provider-limits-${nonce.slice(0, 8)}`,
    role: "worker",
    status: "online",
  });
  try {
    await api.put("/api/config", {
      scope: "global",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      isSecret: true,
      value: [
        `sk-ant-oat01-${"e".repeat(60)}${claudeSuffix}`,
        `sk-ant-oat01-${"f".repeat(60)}${claudeMaxSuffix}`,
      ].join(","),
    });
    await api.put("/api/config", {
      scope: "global",
      key: `codex_oauth_${codexSlot}`,
      isSecret: true,
      value: JSON.stringify({
        access: fakeJwt({
          "https://api.openai.com/auth": {
            chatgpt_plan_type: "promax",
            chatgpt_user_id: codexUser,
          },
          "https://api.openai.com/profile": { email: codexEmail },
        }),
        refresh: `refresh-${nonce}`,
        expires: now + 9 * 24 * H,
        accountId: `acct-${nonce.slice(0, 8)}`,
      }),
    });

    // Claude: weekly and Fable are current; the 5 h reading reset 187 hours ago.
    await report({
      keyType: "CLAUDE_CODE_OAUTH_TOKEN",
      keySuffix: claudeSuffix,
      keyIndex: 0,
      windows: {
        five_hour: {
          status: "allowed",
          utilization: 0.87,
          resetsAt: sec(now - 187 * H),
          lastSeenAt: iso(now - 192 * H),
        },
        seven_day: {
          status: "allowed",
          utilization: 0.64,
          resetsAt: sec(now + 75 * H),
          lastSeenAt: iso(now - 6 * 60_000),
          overageStatus: "rejected",
          overageDisabledReason: "group_zero_credit_limit",
          isUsingOverage: false,
        },
        seven_day_overage_included: {
          status: "allowed",
          utilization: 0.31,
          resetsAt: sec(now + 75 * H),
          lastSeenAt: iso(now - 6 * 60_000),
        },
      },
    });
    // A second Claude key whose 5 h window resets in two minutes.
    await report({
      keyType: "CLAUDE_CODE_OAUTH_TOKEN",
      keySuffix: claudeMaxSuffix,
      keyIndex: 1,
      windows: {
        five_hour: {
          status: "allowed",
          utilization: 0.42,
          resetsAt: sec(now + 2 * 60_000),
          lastSeenAt: iso(now - 60_000),
        },
      },
    });

    // Codex: a weekly-only primary, the secondary explicitly removed, and account facts.
    const codexAt = iso(now - 4 * 60_000);
    await report({
      keyType: "CODEX_OAUTH",
      keySuffix: codexSuffix,
      keyIndex: codexSlot,
      windows: {
        "codex:codex:primary": {
          source: "codex",
          limitId: "codex",
          status: "allowed",
          utilization: 0.22,
          durationMins: 10080,
          resetsAt: sec(now + 100 * H),
          lastSeenAt: codexAt,
        },
      },
      account: {
        source: "codex",
        observedAt: codexAt,
        ordinaryUsageAllowed: true,
        limits: {
          codex: {
            observedAt: codexAt,
            planRaw: "promax",
            credits: { hasCredits: true, unlimited: false, balance: "125.50" },
            spend: {
              limit: "80",
              used: "20",
              remainingPercent: 75,
              resetsAt: sec(now + 5 * 60_000),
            },
            spendControlReached: true,
            reachedType: "workspace_member_usage_limit_reached",
          },
        },
      },
      replace: [
        { source: "codex", limitId: "codex", observedAt: codexAt, slots: ["primary", "secondary"] },
      ],
    });
    // An older agent-scoped report still holds a 5 h secondary. It must not come back.
    await report({
      keyType: "CODEX_OAUTH",
      keySuffix: codexSuffix,
      keyIndex: codexSlot,
      scope: "agent",
      scopeId: agent.id,
      windows: {
        "codex:codex:secondary": {
          source: "codex",
          limitId: "codex",
          status: "allowed",
          utilization: 0.71,
          durationMins: 300,
          resetsAt: sec(now + 3 * H),
          lastSeenAt: iso(now - 40 * 60_000),
        },
      },
    });

    // One completed Claude session on the first key.
    const task = await call<{ id: string }>("POST", "/api/tasks", {
      task: `e2e provider limits ${nonce.slice(0, 8)}`,
      agentId: agent.id,
      routingReason: "human_pinned",
      source: "api",
      tags: ["e2e"],
    });
    await expect
      .poll(async () => {
        const polled = await call<{ trigger?: { taskId?: string } }>(
          "GET",
          "/api/poll",
          undefined,
          agent.id,
        );
        return polled?.trigger?.taskId;
      })
      .toBe(task.id);
    await call("POST", "/api/session-costs", {
      sessionId: `e2e-provider-limits-${nonce}`,
      agentId: agent.id,
      taskId: task.id,
      totalCostUsd: 0.5,
      provider: "claude",
      harness: "claude",
      model: "claude-opus-5-5",
      credentialKeyType: "CLAUDE_CODE_OAUTH_TOKEN",
      credentialKeySuffix: claudeSuffix,
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 40000,
      durationMs: 600000,
      numTurns: 3,
    });
    await call(
      "POST",
      `/api/tasks/${task.id}/finish`,
      { status: "completed", output: "ok" },
      agent.id,
    );
    const usage = await api.get<WindowUsageResponse>(
      `/api/keys/window-usage?keyType=CLAUDE_CODE_OAUTH_TOKEN&keySuffix=${claudeSuffix}`,
    );
    const weekly = usage.windows.find((w) => w.windowKey === "seven_day")?.usage;
    expect(weekly).toMatchObject({ sessions: 1, completedTasks: 1 });

    // The page clock starts at real time, so the browser alone decides expiry.
    await page.clock.install({ time: now });
    await page.goto("/integrations/ai");
    await page.getByRole("button", { name: /^Claude subscription/ }).click();
    const claude = page.getByRole("region", { name: "Claude subscription tokens" });
    const claudeKey = claude.getByRole("listitem").filter({ hasText: claudeLabel });
    await expect(claudeKey.getByText("Weekly · Fable", { exact: true })).toBeVisible();
    await expect(claudeKey.getByText("36% left", { exact: true })).toBeVisible();
    await expect(claudeKey).not.toContainText(
      "Usage credits: rejected · group zero credit limit · not in use",
    );
    await expect(claudeKey).not.toContainText("87%");
    await expect(claudeKey).not.toContainText("5 h");
    const maxKey = claude.getByRole("listitem").filter({ hasText: claudeMaxLabel });
    await expect(maxKey.getByText("58% left", { exact: true })).toBeVisible();

    // Three minutes later the 5 h window has reset. The server still reports it.
    await page.clock.fastForward("03:00");
    await expect(maxKey).not.toContainText("58% left");
    await expect(maxKey.getByText("No current limit data")).toBeVisible();

    const toggle = claudeKey.getByRole("button", { name: `Limits and usage for ${claudeLabel}` });
    const closedHeight = (await claudeKey.boundingBox())!.height;
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const details = page.getByRole("region", { name: `${claudeLabel} limits and usage` });
    expect((await claudeKey.boundingBox())!.height).toBe(closedHeight);
    await expect(details).toContainText("Usage credits: rejected · group zero credit limit");
    await details.getByText("Swarm usage", { exact: true }).first().click();
    // The weekly card shows what the API counted for that window.
    await expect(details.getByText("Swarm runs: 1 session, 1 task completed")).toBeVisible();
    await expect(details).toContainText("1.2K");

    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    await expect(details).not.toBeVisible();

    await page.getByRole("button", { name: /^Codex \(ChatGPT\)/ }).click();
    const codex = page.getByRole("region", { name: "Codex (ChatGPT) accounts" });
    const codexKey = codex.getByRole("listitem").filter({ hasText: codexEmail });
    await expect(codexKey.getByText("ChatGPT Pro", { exact: true })).toBeVisible();
    await expect(codexKey.getByText("Price tier unknown", { exact: true })).toBeVisible();
    await expect(codexKey.getByText("Weekly", { exact: true })).toBeVisible();
    await expect(codexKey).not.toContainText("71%");
    await codexKey.getByRole("button", { name: `Limits and usage for ${codexEmail}` }).click();
    const codexDetails = page.getByRole("region", { name: `${codexEmail} limits and usage` });
    await expect(codexDetails.getByText("Balance 125.50")).toBeVisible();
    await expect(codexDetails).toContainText("75% left, 20 of 80 used (provider units)");
    await expect(codexDetails).not.toContainText("$80");
    await page.clock.fastForward("03:00");
    await expect(codexDetails).toContainText("Period reset");
    await expect(codexDetails).toContainText(
      "Spend cap reachedPrevious period, current state unknown",
    );
    await expect(codexDetails).not.toContainText("75% left");

    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileTrigger = codexKey.getByRole("button", {
      name: `Limits and usage for ${codexEmail}`,
    });
    await expect(mobileTrigger).toContainText("78% left");
    await mobileTrigger.click();
    await expect(codexDetails).toBeVisible();
    const popover = await page
      .getByRole("dialog", { name: `${codexEmail} quota details` })
      .boundingBox();
    expect(popover!.x).toBeGreaterThanOrEqual(0);
    expect(popover!.x + popover!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.keyboard.press("Escape");
    await clean.assertClean();
  } finally {
    // The worker's disposable API retains status telemetry, the completed task,
    // and its cost row. No delete route removes these audit records. Unique
    // credential suffixes keep them separate from other scenarios.
    const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    const pool = configs.find((config) => config.key === "CLAUDE_CODE_OAUTH_TOKEN");
    if (pool) await api.delete(`/api/config/${pool.id}`);
    await call("DELETE", `/api/codex-oauth/accounts/${codexSlot}`).catch(() => undefined);
    await call("POST", "/close", {}, agent.id).catch(() => undefined);
  }
});
