import { afterEach, describe, expect, test } from "bun:test";
import { deleteSwarmConfig, upsertSwarmConfig } from "../be/db";
import { buildScriptCredentialBindings } from "../be/script-credential-broker";
import {
  CREDENTIAL_BINDINGS_CONFIG_KEY,
  type CredentialBindingStore,
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  patchFetchWithCredentialBroker,
  SwarmConfigCredentialBindingStore,
} from "../scripts-runtime/credential-broker";
import type { SwarmConfig } from "../types";
import { clearVolatileSecretsForTesting, scrubSecrets } from "../utils/secret-scrubber";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearVolatileSecretsForTesting();
});

function configRow(value: unknown): SwarmConfig {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    scope: "global",
    scopeId: null,
    key: "SCRIPT_CREDENTIAL_BINDINGS",
    value: JSON.stringify(value),
    isSecret: false,
    envPath: null,
    description: null,
    createdAt: "2026-06-26T00:00:00.000Z",
    lastUpdatedAt: "2026-06-26T00:00:00.000Z",
    encrypted: false,
  };
}

function scopedConfigRow(
  scope: "global" | "agent" | "repo",
  scopeId: string | null,
  value: unknown,
): SwarmConfig {
  return {
    ...configRow(value),
    scope,
    scopeId,
  };
}

describe("credential broker", () => {
  test("loads active bindings from swarm_config", () => {
    const store = new SwarmConfigCredentialBindingStore(() => [
      configRow({
        bindings: [
          {
            configKey: "LINEAR_API_KEY",
            allowedHosts: ["api.linear.app"],
            headerTemplate: "Authorization: Bearer [REDACTED:LINEAR_API_KEY]",
            scope: "global",
            active: true,
          },
          {
            configKey: "DISABLED_KEY",
            allowedHosts: ["example.com"],
            headerTemplate: "Authorization: Bearer [REDACTED:DISABLED_KEY]",
            scope: "global",
            active: false,
          },
          {
            configKey: "QUERY_KEY",
            allowedHosts: ["api.example.com"],
            queryTemplate: "api_key=[REDACTED:QUERY_KEY]",
            scope: "global",
            active: true,
          },
        ],
      }),
    ]);

    expect(store.listActiveBindings({})).toEqual([
      {
        configKey: "LINEAR_API_KEY",
        allowedHosts: ["api.linear.app"],
        headerTemplate: "Authorization: Bearer [REDACTED:LINEAR_API_KEY]",
        scope: "global",
        active: true,
        scopeId: null,
      },
      {
        configKey: "QUERY_KEY",
        allowedHosts: ["api.example.com"],
        queryTemplate: "api_key=[REDACTED:QUERY_KEY]",
        scope: "global",
        active: true,
        scopeId: null,
      },
    ]);
  });

  test("falls back to the swarm_config row scope when a binding omits scope", () => {
    const agentId = "22222222-2222-4222-8222-222222222222";
    const store = new SwarmConfigCredentialBindingStore(() => [
      scopedConfigRow("agent", agentId, {
        bindings: [
          {
            configKey: "AGENT_VENDOR_KEY",
            allowedHosts: ["api.vendor.test"],
            headerTemplate: "Authorization: Bearer [REDACTED:AGENT_VENDOR_KEY]",
          },
        ],
      }),
    ]);

    expect(store.listActiveBindings({ agentId })).toHaveLength(1);
    expect(store.listActiveBindings({ agentId: "33333333-3333-4333-8333-333333333333" })).toEqual(
      [],
    );
  });

  test("resolves seeded GITHUB_TOKEN binding", () => {
    const emptyStore: CredentialBindingStore = { listActiveBindings: () => [] };
    const broker = new CredentialBroker(
      emptyStore,
      (key) => (key === "GITHUB_TOKEN" ? "ghp_test" : undefined),
      DEFAULT_CREDENTIAL_BINDINGS,
    );

    expect(broker.resolveBindings({})).toEqual([
      {
        configKey: "GITHUB_TOKEN",
        allowedHosts: ["api.github.com"],
        headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
        scope: "global",
        scopeId: null,
        active: true,
        placeholder: "[REDACTED:GITHUB_TOKEN]",
        value: "ghp_test",
      },
    ]);
  });

  test("registers resolved broker config values with the scrubber", () => {
    const bindingsConfig = upsertSwarmConfig({
      scope: "global",
      key: CREDENTIAL_BINDINGS_CONFIG_KEY,
      value: JSON.stringify({
        bindings: [
          {
            configKey: "VENDOR_SPECIAL_API_KEY",
            allowedHosts: ["api.vendor.test"],
            headerTemplate: "Authorization: Bearer [REDACTED:VENDOR_SPECIAL_API_KEY]",
          },
        ],
      }),
    });
    const secretConfig = upsertSwarmConfig({
      scope: "global",
      key: "VENDOR_SPECIAL_API_KEY",
      value: "not_a_standard_token_shape_12345",
      isSecret: true,
    });

    try {
      const bindings = buildScriptCredentialBindings({});

      expect(bindings.some((binding) => binding.configKey === "VENDOR_SPECIAL_API_KEY")).toBe(true);
      expect(scrubSecrets("echo not_a_standard_token_shape_12345")).toBe(
        "echo [REDACTED:VENDOR_SPECIAL_API_KEY]",
      );
    } finally {
      deleteSwarmConfig(bindingsConfig.id);
      deleteSwarmConfig(secretConfig.id);
    }
  });

  test("substitutes placeholders for allowlisted hosts", async () => {
    let authorization: string | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ ok: true });
    }) as typeof fetch;

    patchFetchWithCredentialBroker([
      {
        configKey: "GITHUB_TOKEN",
        allowedHosts: ["api.github.com"],
        headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
        scope: "global",
        scopeId: null,
        active: true,
        placeholder: "[REDACTED:GITHUB_TOKEN]",
        value: "ghp_secret",
      },
    ]);

    await fetch("https://api.github.com/repos/desplega-ai/agent-swarm", {
      headers: { Authorization: "Bearer [REDACTED:GITHUB_TOKEN]" },
    });

    expect(authorization).toBe("Bearer ghp_secret");
  });

  test("does not substitute placeholders for non-allowlisted hosts", async () => {
    let authorization: string | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ ok: true });
    }) as typeof fetch;

    patchFetchWithCredentialBroker([
      {
        configKey: "GITHUB_TOKEN",
        allowedHosts: ["api.github.com"],
        headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
        scope: "global",
        scopeId: null,
        active: true,
        placeholder: "[REDACTED:GITHUB_TOKEN]",
        value: "ghp_secret",
      },
    ]);

    await fetch("https://example.com/leak", {
      headers: { Authorization: "Bearer [REDACTED:GITHUB_TOKEN]" },
    });

    expect(authorization).toBe("Bearer [REDACTED:GITHUB_TOKEN]");
  });

  test("substitutes query placeholders for allowlisted hosts", async () => {
    let observedUrl: string | null = null;
    globalThis.fetch = (async (input: string | URL | Request) => {
      observedUrl = input instanceof Request ? input.url : input.toString();
      return Response.json({ ok: true });
    }) as typeof fetch;

    patchFetchWithCredentialBroker([
      {
        configKey: "VENDOR_API_KEY",
        allowedHosts: ["api.vendor.test"],
        queryTemplate: "api_key=[REDACTED:VENDOR_API_KEY]",
        scope: "global",
        scopeId: null,
        active: true,
        placeholder: "[REDACTED:VENDOR_API_KEY]",
        value: "vendor_secret",
      },
    ]);

    await fetch("https://api.vendor.test/v1/items?api_key=[REDACTED:VENDOR_API_KEY]&q=one");

    expect(observedUrl).toBe("https://api.vendor.test/v1/items?q=one&api_key=vendor_secret");
  });

  test("does not substitute query placeholders for non-allowlisted hosts", async () => {
    let observedUrl: string | null = null;
    globalThis.fetch = (async (input: string | URL | Request) => {
      observedUrl = input instanceof Request ? input.url : input.toString();
      return Response.json({ ok: true });
    }) as typeof fetch;

    patchFetchWithCredentialBroker([
      {
        configKey: "VENDOR_API_KEY",
        allowedHosts: ["api.vendor.test"],
        queryTemplate: "api_key=[REDACTED:VENDOR_API_KEY]",
        scope: "global",
        scopeId: null,
        active: true,
        placeholder: "[REDACTED:VENDOR_API_KEY]",
        value: "vendor_secret",
      },
    ]);

    await fetch("https://example.com/v1/items?api_key=[REDACTED:VENDOR_API_KEY]&q=one");

    expect(observedUrl).toBe(
      "https://example.com/v1/items?api_key=[REDACTED:VENDOR_API_KEY]&q=one",
    );
  });
});
