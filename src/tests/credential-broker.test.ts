import { afterEach, describe, expect, test } from "bun:test";
import {
  type CredentialBindingStore,
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  patchFetchWithCredentialBroker,
  SwarmConfigCredentialBindingStore,
} from "../scripts-runtime/credential-broker";
import type { SwarmConfig } from "../types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    ]);
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
});
