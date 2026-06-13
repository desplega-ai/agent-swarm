import { afterEach, describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../types.ts";
import { apiRuntimeEnv, workerRuntimeEnv } from "./sandbox.ts";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_API_BASE_URL",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function workerEnvFor(config: HarnessConfig): Record<string, string> {
  return workerRuntimeEnv({
    swarmKey: "test-key",
    apiUrl: "https://api.example",
    agentId: "agent-1",
    config,
  });
}

describe("workerRuntimeEnv credential gating (v7.6 §A2 — interim claude OPENROUTER injection removed)", () => {
  test("claude provider + OPENROUTER_API_KEY in controller env → NOT injected (1.97.0 templates ship the SKIP_SESSION_SUMMARY root fix; the summarizer-recursion guard is gone)", () => {
    process.env.OPENROUTER_API_KEY = "or-test-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    const env = workerEnvFor({ id: "claude-haiku", provider: "claude", model: "haiku" });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    // Harness credential gating unchanged: OAuth token still present.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test");
  });

  test("non-claude provider with anthropic-prefixed model → OPENROUTER_API_KEY NOT injected (credential gating stays config-driven)", () => {
    process.env.OPENROUTER_API_KEY = "or-test-key";
    process.env.ANTHROPIC_API_KEY = "ant-test-key";
    const env = workerEnvFor({
      id: "pi-haiku",
      provider: "pi",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("ant-test-key");
  });

  test("config.env can still supply OPENROUTER_API_KEY explicitly (merge order intact)", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    const env = workerEnvFor({
      id: "claude-haiku",
      provider: "claude",
      model: "haiku",
      env: { OPENROUTER_API_KEY: "per-config-key" },
    });
    expect(env.OPENROUTER_API_KEY).toBe("per-config-key");
  });
});

describe("workerRuntimeEnv v7 member env (§9.3 frozen merge order)", () => {
  test("identity envs map from the typed spec fields (TEMPLATE_ID / AGENT_NAME / SYSTEM_PROMPT)", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    const env = workerRuntimeEnv({
      swarmKey: "k",
      apiUrl: "https://api.example",
      agentId: "agent-1",
      config: { id: "claude-haiku", provider: "claude", model: "haiku" },
      spec: { template: "coder", name: "scribe-a", systemPrompt: "Be terse." },
    });
    expect(env.TEMPLATE_ID).toBe("coder");
    expect(env.AGENT_NAME).toBe("scribe-a");
    expect(env.SYSTEM_PROMPT).toBe("Be terse.");
  });

  test("default worker: NO TEMPLATE_ID (a template would rewrite the eval subject's prompt), AGENT_NAME defaults to Worker 0, AGENT_ROLE=worker, MAX_CONCURRENT_TASKS=1", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    const env = workerEnvFor({ id: "claude-haiku", provider: "claude", model: "haiku" });
    expect(env.TEMPLATE_ID).toBeUndefined();
    // v7.5 item 7: AGENT_NAME is now always emitted so agents stop registering
    // under the entrypoint's `worker-<hash>` fallback name.
    expect(env.AGENT_NAME).toBe("Worker 0");
    expect(env.SYSTEM_PROMPT).toBeUndefined();
    expect(env.AGENT_ROLE).toBe("worker");
    expect(env.MAX_CONCURRENT_TASKS).toBe("1");
  });

  test("default worker name follows the 0-based member index (matches sandbox indices + UI workerLabel)", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    const env = workerRuntimeEnv({
      swarmKey: "k",
      apiUrl: "https://api.example",
      agentId: "agent-3",
      config: { id: "claude-haiku", provider: "claude", model: "haiku" },
      index: 2,
    });
    expect(env.AGENT_NAME).toBe("Worker 2");
    expect(env.TEMPLATE_ID).toBeUndefined();
  });

  test("lead member: AGENT_ROLE=lead with the entrypoint's lead default MAX_CONCURRENT_TASKS=2; default TEMPLATE_ID=official/lead, spec.name wins over the Lead default", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    const env = workerRuntimeEnv({
      swarmKey: "k",
      apiUrl: "https://api.example",
      agentId: "agent-lead",
      config: { id: "claude-sonnet", provider: "claude", model: "sonnet" },
      role: "lead",
      spec: { name: "custom-lead" },
    });
    expect(env.AGENT_ROLE).toBe("lead");
    expect(env.MAX_CONCURRENT_TASKS).toBe("2");
    expect(env.AGENT_NAME).toBe("custom-lead");
    // Lead-only template default (v7.5 item 7): production leads run
    // official/lead; its agentDefaults are no-ops vs the pinned boot env.
    expect(env.TEMPLATE_ID).toBe("official/lead");
  });

  test("default lead ({} spec): TEMPLATE_ID=official/lead, AGENT_NAME=Lead (deterministic even if the registry fetch fails)", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    const env = workerRuntimeEnv({
      swarmKey: "k",
      apiUrl: "https://api.example",
      agentId: "agent-lead",
      config: { id: "claude-sonnet", provider: "claude", model: "sonnet" },
      role: "lead",
      index: 1,
      spec: {},
    });
    expect(env.TEMPLATE_ID).toBe("official/lead");
    expect(env.AGENT_NAME).toBe("Lead");
  });

  test("explicit spec.template wins over the lead's official/lead default", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    const env = workerRuntimeEnv({
      swarmKey: "k",
      apiUrl: "https://api.example",
      agentId: "agent-lead",
      config: { id: "claude-sonnet", provider: "claude", model: "sonnet" },
      role: "lead",
      spec: { template: "researcher" },
    });
    expect(env.TEMPLATE_ID).toBe("researcher");
    expect(env.AGENT_NAME).toBe("Lead");
  });

  test("spec.env merges LAST (over config.env)", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    const env = workerRuntimeEnv({
      swarmKey: "k",
      apiUrl: "https://api.example",
      agentId: "agent-1",
      config: {
        id: "claude-haiku",
        provider: "claude",
        model: "haiku",
        env: { EXTRA_FLAG: "from-config" },
      },
      spec: { env: { EXTRA_FLAG: "from-spec", MEMBER_ONLY: "1" } },
    });
    expect(env.EXTRA_FLAG).toBe("from-spec");
    expect(env.MEMBER_ONLY).toBe("1");
  });

  test("credential isolation follows the EFFECTIVE config (pi override on a claude host env)", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test";
    process.env.OPENROUTER_API_KEY = "or-test-key";
    // Member overridden to pi/openrouter: gets OPENROUTER_API_KEY, never the
    // claude OAuth token (claude creds in env win inside the harness).
    const env = workerRuntimeEnv({
      swarmKey: "k",
      apiUrl: "https://api.example",
      agentId: "agent-1",
      config: {
        id: "pi-deepseek-flash",
        provider: "pi",
        model: "openrouter/deepseek/deepseek-v4-flash",
      },
      spec: { configId: "pi-deepseek-flash" },
    });
    expect(env.HARNESS_PROVIDER).toBe("pi");
    expect(env.MODEL_OVERRIDE).toBe("openrouter/deepseek/deepseek-v4-flash");
    expect(env.OPENROUTER_API_KEY).toBe("or-test-key");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("apiRuntimeEnv embedding envs (v7.6 §A2 — EMBEDDING_*-differentiated)", () => {
  test("no EMBEDDING_DIMENSIONS pin (≤1.85-template NaN workaround removed; 1.97.0 defaults the dimension server-side)", () => {
    expect(apiRuntimeEnv("k").EMBEDDING_DIMENSIONS).toBeUndefined();
  });

  test("EMBEDDING_API_KEY / EMBEDDING_MODEL / EMBEDDING_API_BASE_URL pass through when set", () => {
    process.env.EMBEDDING_API_KEY = "emb-test-key";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.EMBEDDING_API_BASE_URL = "https://embed.example/v1";
    const env = apiRuntimeEnv("k");
    expect(env.EMBEDDING_API_KEY).toBe("emb-test-key");
    expect(env.EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(env.EMBEDDING_API_BASE_URL).toBe("https://embed.example/v1");
  });

  test("unset EMBEDDING_* envs are omitted (no empty-string keys)", () => {
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_API_BASE_URL;
    const env = apiRuntimeEnv("k");
    expect(env.EMBEDDING_API_KEY).toBeUndefined();
    expect(env.EMBEDDING_MODEL).toBeUndefined();
    expect(env.EMBEDDING_API_BASE_URL).toBeUndefined();
  });

  test("OPENAI_API_KEY is NOT forwarded to the API sandbox (embeddings no longer rely on the server-side OPENAI_API_KEY fallback)", () => {
    process.env.OPENAI_API_KEY = "oa-test-key";
    process.env.EMBEDDING_API_KEY = "emb-test-key";
    const env = apiRuntimeEnv("k");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.EMBEDDING_API_KEY).toBe("emb-test-key");
  });
});
