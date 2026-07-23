import { afterEach, describe, expect, mock, test } from "bun:test";
import { deleteSwarmConfig, getDb, upsertSwarmConfig } from "../be/db";
import { upsertCredentialBinding } from "../be/script-connections";
import { buildScriptCredentialBindings } from "../be/script-credential-broker";
import { createApiRegistryClient } from "../scripts-runtime/api-client";
import {
  type CredentialBindingStore,
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  patchFetchWithCredentialBroker,
} from "../scripts-runtime/credential-broker";
import { clearVolatileSecretsForTesting, scrubSecrets } from "../utils/secret-scrubber";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearVolatileSecretsForTesting();
});

describe("credential broker", () => {
  test("resolves seeded GITHUB_TOKEN binding", async () => {
    const emptyStore: CredentialBindingStore = { listActiveBindings: () => [] };
    const broker = new CredentialBroker(
      emptyStore,
      (key) => (key === "GITHUB_TOKEN" ? "ghp_test" : undefined),
      DEFAULT_CREDENTIAL_BINDINGS,
    );

    expect(await broker.resolveBindings({})).toEqual([
      {
        configKey: "GITHUB_TOKEN",
        allowedHosts: ["api.github.com"],
        headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
        scope: "global",
        scopeId: null,
        active: true,
        authKind: "config",
        placeholder: "[REDACTED:GITHUB_TOKEN]",
        value: "ghp_test",
      },
    ]);
  });

  test("resolves OAuth bindings with the OAuth resolver and substitutes their header", async () => {
    const oauthResolver = mock(async (authorizationId: string) =>
      authorizationId === "gmail-authz" ? "gmail-access-token" : undefined,
    );
    const broker = new CredentialBroker(
      {
        listActiveBindings: () => [
          {
            configKey: "GMAIL_SUPPORT_OAUTH_BINDING",
            allowedHosts: ["gmail.googleapis.com"],
            headerTemplate: "Authorization: Bearer [REDACTED:GMAIL_SUPPORT_OAUTH_BINDING]",
            scope: "global",
            scopeId: null,
            active: true,
            authKind: "oauth",
            oauthAuthorizationId: "gmail-authz",
          },
        ],
      },
      () => {
        throw new Error("config resolver must not be used for OAuth bindings");
      },
      [],
      oauthResolver,
    );
    const bindings = await broker.resolveBindings({});

    expect(oauthResolver).toHaveBeenCalledWith("gmail-authz");
    let authorization: string | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ ok: true });
    }) as typeof fetch;
    patchFetchWithCredentialBroker(bindings);

    await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: "Bearer [REDACTED:GMAIL_SUPPORT_OAUTH_BINDING]" },
    });

    expect(authorization).toBe("Bearer gmail-access-token");
  });

  test("partitions a throwing OAuth resolver into failedBindings while others resolve", async () => {
    const broker = new CredentialBroker(
      {
        listActiveBindings: () => [
          {
            configKey: "BROKEN_OAUTH_BINDING",
            allowedHosts: ["api.broken.test"],
            headerTemplate: "Authorization: Bearer [REDACTED:BROKEN_OAUTH_BINDING]",
            scope: "global",
            scopeId: null,
            active: true,
            authKind: "oauth",
            oauthAuthorizationId: "broken-authz",
          },
          {
            configKey: "HEALTHY_OAUTH_BINDING",
            allowedHosts: ["api.healthy.test"],
            headerTemplate: "Authorization: Bearer [REDACTED:HEALTHY_OAUTH_BINDING]",
            scope: "global",
            scopeId: null,
            active: true,
            authKind: "oauth",
            oauthAuthorizationId: "healthy-authz",
          },
        ],
      },
      () => undefined,
      [],
      async (authorizationId: string) => {
        if (authorizationId === "broken-authz") {
          // Duck-typed shape of OAuthRefreshError (server-side class not imported here).
          const err = Object.assign(new Error("refresh rejected (400)"), {
            reason: "refresh_rejected",
            authorizationLabel: "Broken Vendor",
          });
          throw err;
        }
        return "healthy-access-token";
      },
    );

    const { resolved, failed } = await broker.resolveBindingsWithFailures({});

    expect(resolved).toMatchObject([
      { configKey: "HEALTHY_OAUTH_BINDING", value: "healthy-access-token" },
    ]);
    expect(failed).toEqual([
      {
        placeholder: "[REDACTED:BROKEN_OAUTH_BINDING]",
        allowedHosts: ["api.broken.test"],
        reason: "refresh_rejected",
        authorizationLabel: "Broken Vendor",
      },
    ]);

    // The backward-compatible array API returns only the resolved bindings.
    expect(await broker.resolveBindings({})).toMatchObject([
      { configKey: "HEALTHY_OAUTH_BINDING", value: "healthy-access-token" },
    ]);
  });

  test("patched fetch throws for a failed binding but still substitutes healthy ones", async () => {
    let observed: string | null = null;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      observed = new Headers(init?.headers).get("authorization");
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;

    patchFetchWithCredentialBroker(
      [
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
      ],
      [
        {
          placeholder: "[REDACTED:BROKEN_OAUTH_BINDING]",
          allowedHosts: ["api.broken.test"],
          reason: "refresh_rejected",
          authorizationLabel: "Broken Vendor",
        },
      ],
    );

    // Targets the failed binding's host WITH its placeholder → typed throw.
    expect(() =>
      fetch("https://api.broken.test/v1/items", {
        headers: { Authorization: "Bearer [REDACTED:BROKEN_OAUTH_BINDING]" },
      }),
    ).toThrow(/OAuth authorization 'Broken Vendor' is in refresh-failed state: refresh_rejected/);

    // A healthy resolved binding on a different host still substitutes.
    await fetch("https://api.github.com/user", {
      headers: { Authorization: "Bearer [REDACTED:GITHUB_TOKEN]" },
    });
    expect(observed).toBe("Bearer ghp_secret");
  });

  test("resolved OAuth bindings also authenticate ctx.api clients", async () => {
    let authorization: string | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ data: { ok: true } });
    }) as typeof fetch;
    const broker = new CredentialBroker(
      {
        listActiveBindings: () => [
          {
            configKey: "GMAIL_SUPPORT_OAUTH_BINDING",
            allowedHosts: ["gmail.googleapis.com"],
            headerTemplate: "Authorization: Bearer [REDACTED:GMAIL_SUPPORT_OAUTH_BINDING]",
            scope: "global",
            scopeId: null,
            active: true,
            authKind: "oauth",
            oauthAuthorizationId: "gmail-authz",
          },
        ],
      },
      () => undefined,
      [],
      async () => "gmail-access-token",
    );
    patchFetchWithCredentialBroker(await broker.resolveBindings({}));
    const api = createApiRegistryClient([
      {
        slug: "gmailSupport",
        kind: "graphql",
        baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        credential: {
          configKey: "GMAIL_SUPPORT_OAUTH_BINDING",
          headerTemplate: "Authorization: Bearer [REDACTED:GMAIL_SUPPORT_OAUTH_BINDING]",
        },
      },
    ]);

    await api.gmailSupport.graphql("query { me { id } }");

    expect(authorization).toBe("Bearer gmail-access-token");
  });

  test("resolves config bindings via the config resolver even when OAuth authorization metadata is present", async () => {
    const oauthResolver = mock(async () => "should-not-be-used");
    const broker = new CredentialBroker(
      {
        listActiveBindings: () => [
          {
            configKey: "VENDOR_CONFIG_KEY",
            allowedHosts: ["api.vendor.test"],
            headerTemplate: "Authorization: Bearer [REDACTED:VENDOR_CONFIG_KEY]",
            scope: "global",
            scopeId: null,
            active: true,
            authKind: "config",
            oauthAuthorizationId: "vendor-authorization",
          },
        ],
      },
      (key) => (key === "VENDOR_CONFIG_KEY" ? "vendor-config-value" : undefined),
      [],
      oauthResolver,
    );

    const bindings = await broker.resolveBindings({});

    expect(oauthResolver).not.toHaveBeenCalled();
    expect(bindings).toEqual([
      {
        configKey: "VENDOR_CONFIG_KEY",
        allowedHosts: ["api.vendor.test"],
        headerTemplate: "Authorization: Bearer [REDACTED:VENDOR_CONFIG_KEY]",
        scope: "global",
        scopeId: null,
        active: true,
        authKind: "config",
        oauthAuthorizationId: "vendor-authorization",
        placeholder: "[REDACTED:VENDOR_CONFIG_KEY]",
        value: "vendor-config-value",
      },
    ]);
  });

  test("registers resolved broker config values with the scrubber", async () => {
    // The legacy SCRIPT_CREDENTIAL_BINDINGS blob is retired — resolution is now
    // relational-only, so seed a relational binding + its config secret.
    const binding = upsertCredentialBinding({
      configKey: "VENDOR_SPECIAL_API_KEY",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:VENDOR_SPECIAL_API_KEY]",
    });
    const secretConfig = upsertSwarmConfig({
      scope: "global",
      key: "VENDOR_SPECIAL_API_KEY",
      value: "not_a_standard_token_shape_12345",
      isSecret: true,
    });

    try {
      const bindings = await buildScriptCredentialBindings({});

      expect(bindings.some((entry) => entry.configKey === "VENDOR_SPECIAL_API_KEY")).toBe(true);
      expect(scrubSecrets("echo not_a_standard_token_shape_12345")).toBe(
        "echo [REDACTED:VENDOR_SPECIAL_API_KEY]",
      );
    } finally {
      getDb().run("DELETE FROM script_credential_bindings WHERE id = ?", [binding.id]);
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
