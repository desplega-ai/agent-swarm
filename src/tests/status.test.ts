/**
 * Unit tests for the Phase 1 `/status` endpoint and its DB helpers.
 *
 * Coverage:
 *   - Identity: defaults vs. all-envs-set.
 *   - Setup state machine: per-milestone permutations (env presence,
 *     OAuth row presence, Jira cloudId, agent activity, completed task).
 *   - DB helpers: `getLiveAgentCounts`, `getInstanceActivity`,
 *     `hasFirstCompletedTask`.
 *   - `validateProviderCredentials` error sanitization (mocked fetch).
 *   - Test-connection cache flips harness.state to `verified`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  getDb,
  getInstanceActivity,
  getLiveAgentCounts,
  hasFirstCompletedTask,
  initDb,
  setAgentHarnessProvider,
  updateAgentActivity,
  updateAgentCredStatus,
} from "../be/db";
import { storeOAuthTokens, upsertOAuthApp } from "../be/db-queries/oauth";
import { validateProviderCredentials } from "../commands/provider-credentials";
import {
  _resetTestConnectionCache,
  buildStatusPayload,
  computeHealth,
  type SetupMilestone,
} from "../http/status";
import type { AgentCredStatus } from "../types";

// Helper for tests: stamp an agent row with a cred_status snapshot so the
// `/status` endpoint sees it. Mirrors what the worker boot loop does via
// `PUT /api/agents/:id/credential-status` after migration 055.
function seedCredStatus(
  agentId: string,
  harnessProvider: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode",
  partial: Partial<AgentCredStatus> = {},
): void {
  setAgentHarnessProvider(agentId, harnessProvider);
  const now = Date.now();
  updateAgentCredStatus(agentId, {
    ready: true,
    missing: [],
    satisfiedBy: "env",
    hint: null,
    liveTest: null,
    reportedAt: now,
    reportKind: "boot",
    ...partial,
  });
}

const TEST_DB_PATH = "./test-status.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// All tests share a fresh DB. Per-test isolation comes from `clearTables` +
// process.env reset in `beforeEach`.
const ENV_KEYS_TO_RESET = [
  "SWARM_CLOUD",
  "SWARM_ORG_NAME",
  "SWARM_ORG_LOGO_URL",
  "SWARM_BRAND_COLOR",
  "SWARM_MARKETING_URL",
  "SWARM_HIDE_CLOUD_PROMO",
  "HARNESS_PROVIDER",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CODEX_OAUTH",
  "DEVIN_API_KEY",
  "DEVIN_ORG_ID",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_DISABLE",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "AGENT_FS_API_URL",
  "SWARM_VERIFY_TTL_MS",
];

const savedEnv = new Map<string, string | undefined>();

function snapshotEnv() {
  for (const k of ENV_KEYS_TO_RESET) savedEnv.set(k, process.env[k]);
}

function clearEnv() {
  for (const k of ENV_KEYS_TO_RESET) {
    delete process.env[k];
  }
}

function restoreEnv() {
  for (const k of ENV_KEYS_TO_RESET) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearTables() {
  const db = getDb();
  db.prepare("DELETE FROM agent_tasks").run();
  db.prepare("DELETE FROM agents").run();
  db.prepare("DELETE FROM oauth_tokens").run();
  db.prepare("DELETE FROM oauth_apps").run();
}

beforeAll(async () => {
  snapshotEnv();
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  restoreEnv();
});

beforeEach(() => {
  clearEnv();
  clearTables();
  _resetTestConnectionCache();
});

afterEach(() => {
  clearEnv();
});

// ─── Identity ────────────────────────────────────────────────────────────────

describe("buildStatusPayload — identity", () => {
  test("defaults when no SWARM_* envs set", () => {
    const payload = buildStatusPayload();
    expect(payload.identity).toEqual({
      name: "Swarm",
      logo_url: null,
      brand_color: null,
      is_cloud: false,
      marketing_url: null,
      hide_cloud_promo: false,
    });
  });

  test("reflects SWARM_* envs when all set", () => {
    process.env.SWARM_CLOUD = "true";
    process.env.SWARM_ORG_NAME = "Acme";
    process.env.SWARM_ORG_LOGO_URL = "https://acme.example/logo.png";
    process.env.SWARM_BRAND_COLOR = "#ff5500";
    process.env.SWARM_MARKETING_URL = "https://swarm.acme.example";
    process.env.SWARM_HIDE_CLOUD_PROMO = "true";

    const payload = buildStatusPayload();
    expect(payload.identity).toEqual({
      name: "Acme",
      logo_url: "https://acme.example/logo.png",
      brand_color: "#ff5500",
      is_cloud: true,
      marketing_url: "https://swarm.acme.example",
      hide_cloud_promo: true,
    });
  });

  test("treats SWARM_CLOUD=1 the same as 'true'", () => {
    process.env.SWARM_CLOUD = "1";
    const payload = buildStatusPayload();
    expect(payload.identity.is_cloud).toBe(true);
  });
});

// ─── Setup state machine ─────────────────────────────────────────────────────

function getMilestone(payload: ReturnType<typeof buildStatusPayload>, id: string) {
  const m = payload.setup.find((row) => row.id === id);
  if (!m) throw new Error(`Milestone "${id}" missing from payload`);
  return m;
}

describe("setup milestones", () => {
  test("all unverified on a clean swarm", () => {
    const payload = buildStatusPayload();
    expect(payload.setup).toHaveLength(7);
    for (const m of payload.setup) {
      expect(m.state).toBe("unverified");
    }
  });

  test("harness becomes `configured` when a worker reports ready creds (no live test yet)", () => {
    process.env.HARNESS_PROVIDER = "claude";
    const a = createAgent({ name: "w-cfg", isLead: false, status: "idle", capabilities: [] });
    seedCredStatus(a.id, "claude", { ready: true, satisfiedBy: "env", liveTest: null });

    const payload = buildStatusPayload();
    expect(getMilestone(payload, "harness").state).toBe("configured");
  });

  test("harness flips to `verified` when a worker's recent live test passed", () => {
    process.env.HARNESS_PROVIDER = "claude";
    const a = createAgent({ name: "w-vfd", isLead: false, status: "idle", capabilities: [] });
    seedCredStatus(a.id, "claude", {
      ready: true,
      satisfiedBy: "env",
      liveTest: { ok: true, error: null, latency_ms: 42, testedAt: Date.now() },
    });

    const payload = buildStatusPayload();
    expect(getMilestone(payload, "harness").state).toBe("verified");
  });

  test("harness stays `unverified` when provider set but no worker registered", () => {
    process.env.HARNESS_PROVIDER = "claude";
    const payload = buildStatusPayload();
    expect(getMilestone(payload, "harness").state).toBe("unverified");
  });

  test("harness stays `unverified` when worker reports missing credentials", () => {
    process.env.HARNESS_PROVIDER = "claude";
    const a = createAgent({ name: "w-miss", isLead: false, status: "idle", capabilities: [] });
    seedCredStatus(a.id, "claude", {
      ready: false,
      missing: ["ANTHROPIC_API_KEY"],
      satisfiedBy: null,
    });

    const payload = buildStatusPayload();
    const m = getMilestone(payload, "harness");
    expect(m.state).toBe("unverified");
    expect(m.hint).toContain("ANTHROPIC_API_KEY");
  });

  // ─── Phase 1.5: typed provider field on harness milestone ────────────────
  describe("harness.provider — typed field, no hint regex (Phase 1.5)", () => {
    test("populates `provider` when HARNESS_PROVIDER is a canonical name", () => {
      process.env.HARNESS_PROVIDER = "claude";
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-1234567890abcdef";
      const m = getMilestone(buildStatusPayload(), "harness");
      expect(m.provider).toBe("claude");
    });

    test("undefined when HARNESS_PROVIDER unset", () => {
      const m = getMilestone(buildStatusPayload(), "harness");
      expect(m.provider).toBeUndefined();
    });

    test("undefined when HARNESS_PROVIDER is an unknown name", () => {
      process.env.HARNESS_PROVIDER = "not-a-real-provider";
      const m = getMilestone(buildStatusPayload(), "harness");
      expect(m.provider).toBeUndefined();
    });

    test("hints never contain HARNESS_PROVIDER= or provider= substrings", () => {
      // Across all three states we care about: unset, set+missing-creds,
      // set+creds-present (configured).
      const cases: Array<() => void> = [
        () => {},
        () => {
          process.env.HARNESS_PROVIDER = "claude";
        },
        () => {
          process.env.HARNESS_PROVIDER = "claude";
          process.env.ANTHROPIC_API_KEY = "sk-ant-test-1234567890";
        },
      ];
      for (const seed of cases) {
        clearEnv();
        seed();
        const m = getMilestone(buildStatusPayload(), "harness");
        expect(m.hint ?? "").not.toMatch(/HARNESS_PROVIDER=/);
        expect(m.hint ?? "").not.toMatch(/provider=/);
      }
    });
  });

  test("slack: needs both bot+app tokens AND not disabled", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const a = buildStatusPayload();
    expect(getMilestone(a, "slack").state).toBe("unverified");

    process.env.SLACK_APP_TOKEN = "xapp-test";
    const b = buildStatusPayload();
    expect(getMilestone(b, "slack").state).toBe("verified");

    process.env.SLACK_DISABLE = "true";
    const c = buildStatusPayload();
    expect(getMilestone(c, "slack").state).toBe("unverified");
  });

  test("github: needs webhook secret + app id + private key", () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    process.env.GITHUB_APP_ID = "12345";
    const a = buildStatusPayload();
    expect(getMilestone(a, "github").state).toBe("unverified");

    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\n...";
    const b = buildStatusPayload();
    expect(getMilestone(b, "github").state).toBe("verified");
  });

  test("linear: row in oauth_tokens flips to verified", () => {
    expect(getMilestone(buildStatusPayload(), "linear").state).toBe("unverified");

    upsertOAuthApp("linear", {
      clientId: "cid",
      clientSecret: "csec",
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      redirectUri: "https://app.example/callback",
      scopes: "read",
    });
    storeOAuthTokens("linear", {
      accessToken: "lin-tok-xyz",
      refreshToken: "ref",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: "read",
    });
    expect(getMilestone(buildStatusPayload(), "linear").state).toBe("verified");
  });

  test("jira: requires both oauth_tokens row AND oauth_apps.metadata.cloudId", () => {
    // Seed app row first (FK on oauth_tokens.provider → oauth_apps.provider).
    upsertOAuthApp("jira", {
      clientId: "cid",
      clientSecret: "csec",
      authorizeUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      redirectUri: "https://app.example/callback",
      scopes: "read:jira-work",
      // metadata intentionally omitted on first upsert
    });
    storeOAuthTokens("jira", {
      accessToken: "jira-tok",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: null,
    });
    // Without cloudId yet — still unverified.
    expect(getMilestone(buildStatusPayload(), "jira").state).toBe("unverified");

    upsertOAuthApp("jira", {
      clientId: "cid",
      clientSecret: "csec",
      authorizeUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      redirectUri: "https://app.example/callback",
      scopes: "read:jira-work",
      metadata: JSON.stringify({ cloudId: "abc-123" }),
    });
    expect(getMilestone(buildStatusPayload(), "jira").state).toBe("verified");
  });

  test("workers: configured when agents exist; verified when lead+worker recently active", () => {
    expect(getMilestone(buildStatusPayload(), "workers").state).toBe("unverified");

    const lead = createAgent({
      name: "lead-1",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    expect(getMilestone(buildStatusPayload(), "workers").state).toBe("configured");

    const worker = createAgent({
      name: "worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    // Still configured — neither has lastActivityAt yet.
    expect(getMilestone(buildStatusPayload(), "workers").state).toBe("configured");

    updateAgentActivity(lead.id);
    updateAgentActivity(worker.id);
    expect(getMilestone(buildStatusPayload(), "workers").state).toBe("verified");
  });

  test("first_task: unverified by default; verified after a completed task", () => {
    expect(getMilestone(buildStatusPayload(), "first_task").state).toBe("unverified");

    getDb()
      .prepare(
        `INSERT INTO agent_tasks (id, task, status, source, swarmVersion, createdAt, lastUpdatedAt)
         VALUES (?, ?, 'completed', 'mcp', '1.0.0',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run("task-completed-1", "first task");
    expect(getMilestone(buildStatusPayload(), "first_task").state).toBe("verified");
  });
});

// ─── DB helpers ──────────────────────────────────────────────────────────────

describe("getLiveAgentCounts", () => {
  test("0/0 on empty DB", () => {
    expect(getLiveAgentCounts(5)).toEqual({ leads_alive: 0, workers_alive: 0 });
  });

  test("counts agents with recent activity, excludes offline", () => {
    const lead = createAgent({ name: "lead-a", isLead: true, status: "idle", capabilities: [] });
    const w1 = createAgent({ name: "worker-a", isLead: false, status: "busy", capabilities: [] });
    const w2 = createAgent({
      name: "worker-b",
      isLead: false,
      status: "offline",
      capabilities: [],
    });
    updateAgentActivity(lead.id);
    updateAgentActivity(w1.id);
    updateAgentActivity(w2.id);
    expect(getLiveAgentCounts(5)).toEqual({ leads_alive: 1, workers_alive: 1 });
  });

  test("excludes agents with stale lastActivityAt", () => {
    const w1 = createAgent({ name: "stale-w", isLead: false, status: "idle", capabilities: [] });
    // Backdate to 1h ago (well outside the 5min window).
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    getDb().prepare(`UPDATE agents SET lastActivityAt = ? WHERE id = ?`).run(past, w1.id);
    expect(getLiveAgentCounts(5).workers_alive).toBe(0);
  });
});

describe("getInstanceActivity", () => {
  test("empty DB returns zeroes", () => {
    expect(getInstanceActivity()).toEqual({
      agents_online: 0,
      leads_online: 0,
      recent_tasks_count: 0,
    });
  });

  test("counts agents online + tasks created in 24h", () => {
    const lead = createAgent({ name: "lead-c", isLead: true, status: "idle", capabilities: [] });
    const worker = createAgent({
      name: "worker-c",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    updateAgentActivity(lead.id);
    updateAgentActivity(worker.id);

    getDb()
      .prepare(
        `INSERT INTO agent_tasks (id, task, status, source, swarmVersion, createdAt, lastUpdatedAt)
         VALUES (?, ?, 'pending', 'mcp', '1.0.0',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run("task-recent-1", "fresh task");

    const a = getInstanceActivity();
    expect(a.agents_online).toBe(2);
    expect(a.leads_online).toBe(1);
    expect(a.recent_tasks_count).toBe(1);
  });
});

describe("hasFirstCompletedTask", () => {
  test("false on empty DB", () => {
    expect(hasFirstCompletedTask()).toBe(false);
  });

  test("flips on first completed task", () => {
    getDb()
      .prepare(
        `INSERT INTO agent_tasks (id, task, status, source, swarmVersion, createdAt, lastUpdatedAt)
         VALUES (?, ?, 'pending', 'mcp', '1.0.0',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run("task-pend-1", "pending task");
    expect(hasFirstCompletedTask()).toBe(false);

    getDb()
      .prepare(
        `INSERT INTO agent_tasks (id, task, status, source, swarmVersion, createdAt, lastUpdatedAt)
         VALUES (?, ?, 'completed', 'mcp', '1.0.0',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run("task-done-1", "done task");
    expect(hasFirstCompletedTask()).toBe(true);
  });
});

// ─── Live test dispatcher (mocked fetch) ─────────────────────────────────────

describe("validateProviderCredentials — error scrubbing", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns ok:false when neither OAuth nor API key is set for claude", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const result = await validateProviderCredentials("claude");
    expect(result.ok).toBe(false);
    // Error names BOTH accepted credentials so OAuth users know they have a path.
    expect(result.error).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(result.error).toContain("ANTHROPIC_API_KEY");
  });

  test("claude with CLAUDE_CODE_OAUTH_TOKEN passes via presence check (no upstream call)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-fake-oauth-token";
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await validateProviderCredentials("claude");
    expect(result.ok).toBe(true);
    expect(fetchCalled).toBe(false);
  });

  test("claude prefers OAuth presence check over API-key live call when both are set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-fake-1234";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-fake-oauth";
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await validateProviderCredentials("claude");
    expect(result.ok).toBe(true);
    expect(fetchCalled).toBe(false);
  });

  test("codex with valid CODEX_OAUTH JSON passes via presence check (no upstream call)", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.CODEX_OAUTH = JSON.stringify({
      access: "oai-access-token-from-oauth",
      refresh: "oai-refresh",
      expires: Date.now() + 3600_000,
      accountId: "acct_123",
    });
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await validateProviderCredentials("codex");
    expect(result.ok).toBe(true);
    expect(fetchCalled).toBe(false);
  });

  test("codex with malformed CODEX_OAUTH falls back to OPENAI_API_KEY", async () => {
    process.env.CODEX_OAUTH = "not-json";
    process.env.OPENAI_API_KEY = "sk-fallback-1234";
    let capturedAuth: string | null = null;
    globalThis.fetch = (async (_url, init) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      capturedAuth = headers.get("authorization");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await validateProviderCredentials("codex");
    expect(result.ok).toBe(true);
    expect(capturedAuth).toBe("Bearer sk-fallback-1234");
  });

  test("opencode resolves OPENROUTER → ANTHROPIC → OPENAI (matching pi)", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-1234";
    let capturedUrl = "";
    globalThis.fetch = (async (url) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await validateProviderCredentials("opencode");
    expect(result.ok).toBe(true);
    // Should hit OpenRouter, NOT OpenAI.
    expect(capturedUrl).toContain("openrouter.ai");
  });

  test("scrubs api key from error message on 401 response", async () => {
    const fakeKey = "sk-ant-fakekey-DO-NOT-LEAK-1234567890abcdef";
    process.env.ANTHROPIC_API_KEY = fakeKey;
    globalThis.fetch = (async () =>
      new Response(`Unauthorized: invalid key ${fakeKey}`, {
        status: 401,
      })) as typeof fetch;
    const result = await validateProviderCredentials("claude");
    expect(result.ok).toBe(false);
    expect(result.error ?? "").not.toContain(fakeKey);
    // The structural anthropic_key regex *or* env-value substitution should
    // catch it. Either way the literal key must not survive.
    expect(result.error).toMatch(/REDACTED|HTTP 401/);
  });

  test("returns ok:true on 2xx response", async () => {
    process.env.OPENAI_API_KEY = "sk-test-1234567890";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    const result = await validateProviderCredentials("codex");
    expect(result.ok).toBe(true);
    expect(typeof result.latency_ms).toBe("number");
  });

  test("rejects unknown provider", async () => {
    const result = await validateProviderCredentials("unknown-provider");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown provider");
  });
});

// ─── Phase 2: aggregate health rollup ────────────────────────────────────────

describe("computeHealth (Phase 2)", () => {
  test("`broken` on a clean swarm — harness + workers both unverified", () => {
    const payload = buildStatusPayload();
    expect(payload.health).toBe("broken");
  });

  test("`broken` when harness has creds but no workers ever joined", () => {
    process.env.HARNESS_PROVIDER = "claude";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-1234567890";
    const payload = buildStatusPayload();
    // Harness flips to `configured`, workers still `unverified` → broken.
    expect(payload.health).toBe("broken");
  });

  test("`degraded` when harness is `configured` (worker reported ready, no live test) and workers verified", () => {
    process.env.HARNESS_PROVIDER = "claude";

    const lead = createAgent({ name: "lead-h", isLead: true, status: "idle", capabilities: [] });
    const worker = createAgent({
      name: "worker-h",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    updateAgentActivity(lead.id);
    updateAgentActivity(worker.id);
    // Worker reports presence-ok but no live test → harness is `configured`.
    seedCredStatus(worker.id, "claude", { ready: true, satisfiedBy: "env", liveTest: null });

    const payload = buildStatusPayload();
    expect(getMilestone(payload, "workers").state).toBe("verified");
    expect(getMilestone(payload, "harness").state).toBe("configured");
    expect(payload.health).toBe("degraded");
  });

  test("`degraded` when workers are `configured` (agents exist, no recent heartbeat)", () => {
    process.env.HARNESS_PROVIDER = "claude";

    const lead = createAgent({ name: "lead-d", isLead: true, status: "idle", capabilities: [] });
    // No updateAgentActivity → workers row stays `configured`, not `verified`.
    // Seed lead's cred_status as `verified` (live test passed) so harness
    // doesn't break the rollup. Then workers === configured alone pushes
    // health to degraded.
    seedCredStatus(lead.id, "claude", {
      ready: true,
      satisfiedBy: "env",
      liveTest: { ok: true, error: null, latency_ms: 12, testedAt: Date.now() },
    });
    const payload = buildStatusPayload();
    expect(getMilestone(payload, "workers").state).toBe("configured");
    expect(payload.health).toBe("degraded");
  });

  test("`ok` when harness verified and workers verified (no other integration is `configured`)", () => {
    // We can't reach the in-memory cache from here, so simulate by directly
    // checking the helper: build a synthetic milestone array.
    // (computeHealth is exported.)
    const synthetic: SetupMilestone[] = [
      { id: "harness", label: "Harness", state: "verified" },
      { id: "slack", label: "Slack", state: "unverified" },
      { id: "github", label: "GitHub", state: "unverified" },
      { id: "linear", label: "Linear", state: "unverified" },
      { id: "jira", label: "Jira", state: "unverified" },
      { id: "workers", label: "Workers", state: "verified" },
      { id: "first_task", label: "First task", state: "verified" },
    ];
    expect(computeHealth(synthetic)).toBe("ok");
  });

  test("`degraded` when an integration is `configured`", () => {
    const synthetic: SetupMilestone[] = [
      { id: "harness", label: "Harness", state: "verified" },
      { id: "slack", label: "Slack", state: "configured" },
      { id: "github", label: "GitHub", state: "unverified" },
      { id: "linear", label: "Linear", state: "unverified" },
      { id: "jira", label: "Jira", state: "unverified" },
      { id: "workers", label: "Workers", state: "verified" },
      { id: "first_task", label: "First task", state: "verified" },
    ];
    expect(computeHealth(synthetic)).toBe("degraded");
  });

  test("integrations in `unverified` alone do NOT degrade health", () => {
    // No integrations are connected — that's the common shape, not a
    // problem. Health should be `ok` as long as harness + workers verified.
    const synthetic: SetupMilestone[] = [
      { id: "harness", label: "Harness", state: "verified" },
      { id: "slack", label: "Slack", state: "unverified" },
      { id: "github", label: "GitHub", state: "unverified" },
      { id: "linear", label: "Linear", state: "unverified" },
      { id: "jira", label: "Jira", state: "unverified" },
      { id: "workers", label: "Workers", state: "verified" },
      { id: "first_task", label: "First task", state: "unverified" },
    ];
    expect(computeHealth(synthetic)).toBe("ok");
  });
});

// ─── Worker-reported live test drives harness.state ──────────────────────────
//
// The pre-refactor in-memory cache is gone — `harness.state` now derives from
// `agents.cred_status.liveTest` (migration 055) read across all agents whose
// `harness_provider` matches. These tests cover the new rollup paths.

describe("worker-reported live test drives harness.state", () => {
  test("a passing recent live test flips harness to `verified`", () => {
    process.env.HARNESS_PROVIDER = "claude";
    const a = createAgent({ name: "w-lt", isLead: false, status: "idle", capabilities: [] });
    seedCredStatus(a.id, "claude", {
      ready: true,
      liveTest: { ok: true, error: null, latency_ms: 80, testedAt: Date.now() },
    });
    expect(getMilestone(buildStatusPayload(), "harness").state).toBe("verified");
  });

  test("a stale live test (older than SWARM_VERIFY_TTL_MS) drops to `configured`", () => {
    process.env.HARNESS_PROVIDER = "claude";
    process.env.SWARM_VERIFY_TTL_MS = "1000"; // 1s — anything older is stale
    const a = createAgent({ name: "w-stl", isLead: false, status: "idle", capabilities: [] });
    seedCredStatus(a.id, "claude", {
      ready: true,
      liveTest: {
        ok: true,
        error: null,
        latency_ms: 80,
        testedAt: Date.now() - 60_000, // 60s ago, well beyond TTL
      },
    });
    expect(getMilestone(buildStatusPayload(), "harness").state).toBe("configured");
  });

  test("a failed live test still leaves harness `configured` if presence is ready", () => {
    process.env.HARNESS_PROVIDER = "claude";
    const a = createAgent({ name: "w-fail", isLead: false, status: "idle", capabilities: [] });
    seedCredStatus(a.id, "claude", {
      ready: true,
      liveTest: {
        ok: false,
        error: "HTTP 401: invalid_api_key",
        latency_ms: 30,
        testedAt: Date.now(),
      },
    });
    // Presence is OK; live test failed → not verified, but still configured.
    expect(getMilestone(buildStatusPayload(), "harness").state).toBe("configured");
  });
});
