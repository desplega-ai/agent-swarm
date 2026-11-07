import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  getLead,
  registerAgent,
  runScript,
  startStub,
  structured,
  toolText,
  withMcp,
} from "./script-helpers";

/**
 * Flow `credential-bindings`: standalone credential broker bindings. A binding maps a swarm
 * config secret to an allowed host and a header or query template; a script's plain `fetch`
 * carries the `[REDACTED:<KEY>]` placeholder and the broker swaps in the real value on the way
 * out, so neither the script source nor its result ever holds the secret. Routes plus the
 * lead-only `credential-bindings` tool (bindings and the OAuth app actions).
 */
export const scriptCredentialBindings: Scenario = {
  name: "script-credential-bindings",
  order: 480,
  async run(ctx) {
    const workerId = await registerAgent(ctx, "bindings");
    const leadId = await getLead(ctx);
    const configKey = `E2E_CRED_${ctx.nonce.toUpperCase()}`;
    const secretValue = `e2e-broker-secret-${ctx.nonce}-4242`;
    const placeholder = `[REDACTED:${configKey}]`;
    const stub = startStub(() => Response.json({ ok: true }));
    const bindingIds: string[] = [];
    let configId: string | undefined;
    let oauthProvider: string | undefined;
    try {
      const config = await ctx.api("PUT", "/api/config", {
        body: {
          scope: "global",
          scopeId: null,
          key: configKey,
          value: secretValue,
          isSecret: true,
        },
      });
      expectStatus(config, [200], "store the secret the binding points at");
      configId = asString(asRecord(config.json).id, "config id");

      // ── list, then validation ──
      const initial = await ctx.api("GET", "/api/credential-bindings");
      expectStatus(initial, [200], "list bindings");
      expect(
        !asRecords(initial.json, "bindings").some((binding) => binding.configKey === configKey),
        "the binding must not exist before it is created",
      );
      const noTemplate = await ctx.api("POST", "/api/credential-bindings", {
        body: { configKey, allowedHosts: [stub.hostname] },
      });
      expectStatus(noTemplate, [400], "binding without a template");
      expect(
        String(asRecord(noTemplate.json).error).includes("headerTemplate or queryTemplate"),
        "the 400 must name the missing template",
      );
      const wrongPlaceholder = await ctx.api("POST", "/api/credential-bindings", {
        body: {
          configKey,
          allowedHosts: [stub.hostname],
          headerTemplate: "Authorization: Bearer nothing",
        },
      });
      expectStatus(wrongPlaceholder, [400], "template without the placeholder");
      expect(
        String(asRecord(wrongPlaceholder.json).error).includes(placeholder),
        "the 400 must show the expected placeholder",
      );
      expectStatus(
        await ctx.api("POST", "/api/credential-bindings", {
          body: {
            configKey,
            allowedHosts: [stub.hostname],
            headerTemplate: `X-Key: ${placeholder}`,
            authKind: "oauth",
          },
        }),
        [400],
        "oauth binding without an authorization id",
      );
      expectStatus(
        await ctx.api("POST", "/api/credential-bindings", {
          body: { configKey, allowedHosts: [], headerTemplate: `X-Key: ${placeholder}` },
        }),
        [400],
        "binding without hosts",
      );
      expectStatus(
        await ctx.api("POST", "/api/credential-bindings", {
          body: { allowedHosts: [stub.hostname], headerTemplate: `X-Key: ${placeholder}` },
        }),
        [400],
        "binding without a configKey",
      );

      // ── create (header) and update by id ──
      const headerBinding = await ctx.api("POST", "/api/credential-bindings", {
        body: {
          configKey,
          allowedHosts: [stub.hostname],
          headerTemplate: `Authorization: Bearer ${placeholder}`,
        },
      });
      expectStatus(headerBinding, [200], "create a header binding");
      const created = asRecord(asRecord(headerBinding.json).binding);
      const headerId = asString(created.id, "binding id");
      bindingIds.push(headerId);
      expect(
        created.configKey === configKey &&
          created.scope === "global" &&
          created.scopeId === null &&
          created.active === true &&
          created.authKind === "config" &&
          created.source === "user" &&
          created.managedByConnectionId === null &&
          JSON.stringify(created.allowedHosts) === JSON.stringify([stub.hostname]),
        `binding record is wrong: ${headerBinding.text}`,
      );
      expect(!headerBinding.text.includes(secretValue), "a binding must never echo the secret");
      const updated = await ctx.api("POST", "/api/credential-bindings", {
        body: {
          id: headerId,
          configKey,
          allowedHosts: [stub.hostname, "api.e2e-example.com"],
          headerTemplate: `Authorization: Bearer ${placeholder}`,
        },
      });
      expectStatus(updated, [200], "update the binding by id");
      const updatedBinding = asRecord(asRecord(updated.json).binding);
      expect(
        updatedBinding.id === headerId &&
          asRecord(updatedBinding).allowedHosts !== undefined &&
          (updatedBinding.allowedHosts as unknown[]).length === 2,
        "an update by id must keep the id and replace the hosts",
      );
      const row = ctx.db.get<{ config_key: string; active: number; source: string }>(
        "SELECT config_key, active, source FROM script_credential_bindings WHERE id = ?",
        [headerId],
      );
      expect(
        row?.config_key === configKey && row.active === 1 && row.source === "user",
        "the binding row is not persisted",
      );

      // ── a script's fetch carries the placeholder; the upstream receives the real secret ──
      const fetchSource = (
        path: string,
        header: boolean,
      ) => `export default async function (args: unknown, ctx: any) {
  const response = await fetch("${stub.origin}${path}", {
    headers: ${header ? `{ Authorization: "Bearer ${placeholder}" }` : "{}"},
  });
  return { status: response.status };
}`;
      const first = await runScript(ctx, workerId, {
        source: fetchSource("/header", true),
        intent: `e2e broker header ${ctx.nonce}`,
      });
      expect(asRecord(first.result).status === 200, "the fetch must succeed");
      const headerRequest = stub.seen.find((request) => request.path === "/header");
      expect(headerRequest, "the stub never received the script's request");
      expect(
        headerRequest.headers.authorization === `Bearer ${secretValue}`,
        "the broker must replace the placeholder with the stored secret",
      );
      expect(
        !JSON.stringify(first).includes(secretValue),
        "the script result must never contain the secret",
      );

      // ── a query-template binding substitutes into the URL ──
      const queryBinding = await ctx.api("POST", "/api/credential-bindings", {
        body: {
          configKey,
          allowedHosts: [stub.hostname],
          queryTemplate: `access_token=${placeholder}`,
        },
      });
      expectStatus(queryBinding, [200], "create a query binding");
      const queryBindingId = asString(asRecord(asRecord(queryBinding.json).binding).id, "id");
      bindingIds.push(queryBindingId);
      expect(queryBindingId !== headerId, "a different template is a different binding");
      await runScript(ctx, workerId, {
        source: `export default async function () {
  const response = await fetch("${stub.origin}/query?access_token=${placeholder}");
  return response.status;
}`,
        intent: `e2e broker query ${ctx.nonce}`,
      });
      const queryRequest = stub.seen.find((request) => request.path.startsWith("/query"));
      expect(
        queryRequest?.path === `/query?access_token=${secretValue}`,
        `the query placeholder must be substituted, got ${queryRequest?.path}`,
      );

      // ── a source that embeds the registered secret is refused ──
      const embedded = await ctx.api("POST", "/api/scripts/run", {
        agentId: workerId,
        body: {
          source: `export default async function () { return "${secretValue}"; }`,
          intent: `e2e embedded ${ctx.nonce}`,
        },
      });
      expectStatus(embedded, [400], "a source that embeds a stored secret");
      const refusal = asRecord(embedded.json);
      expect(
        refusal.error === "source_contains_secret" && !embedded.text.includes(secretValue),
        `the refusal must not echo the secret: ${embedded.text.slice(0, 300)}`,
      );

      // ── list shows both bindings; managed (connection-owned) ones are opt-in ──
      const listed = await ctx.api("GET", "/api/credential-bindings");
      const mine = asRecords(listed.json, "bindings").filter(
        (binding) => binding.configKey === configKey,
      );
      expect(mine.length === 2, `both bindings must be listed, got ${mine.length}`);
      const connection = await ctx.api("POST", "/api/script-connections", {
        body: {
          kind: "openapi",
          slug: `e2e-binding-conn-${ctx.nonce}`,
          openapiSpecJson: JSON.stringify({
            openapi: "3.0.0",
            info: { title: "t", version: "1" },
            servers: [{ url: `${stub.origin}/v1` }],
            paths: {
              "/x": { get: { operationId: "x", responses: { "200": { description: "ok" } } } },
            },
          }),
          auth: { type: "bearer", secret: `conn-${secretValue}`, hosts: [stub.hostname] },
        },
      });
      expectStatus(connection, [200], "create a connection that owns a managed binding");
      const connectionId = asString(
        asRecord(asRecord(connection.json).connection).id,
        "connection id",
      );
      try {
        const managedId = ctx.db.get<{ id: string }>(
          "SELECT id FROM script_credential_bindings WHERE managed_by_connection_id = ?",
          [connectionId],
        )?.id;
        expect(managedId, "the connection must own a managed binding");
        const standalone = await ctx.api("GET", "/api/credential-bindings");
        expect(
          !asRecords(standalone.json, "bindings").some((binding) => binding.id === managedId),
          "managed bindings are hidden from the default list",
        );
        const withManaged = await ctx.api("GET", "/api/credential-bindings?includeManaged=true");
        const managed = asRecords(withManaged.json, "bindings").find(
          (binding) => binding.id === managedId,
        );
        expect(
          managed?.source === "connection" && managed.managedByConnectionId === connectionId,
          "includeManaged=true must list the connection-owned binding",
        );
      } finally {
        await ctx.api("DELETE", `/api/script-connections/${connectionId}`);
      }

      // ── the lead-only `credential-bindings` tool ──
      await withMcp(ctx, workerId, async (mcp) => {
        const denied = await callToolErr(mcp, "credential-bindings", { action: "list" });
        expect(
          toolText(denied).includes("Only the lead can manage credential bindings"),
          "a worker must not manage credential bindings",
        );
      });
      const toolKey = `${configKey}_TOOL`;
      await withMcp(ctx, leadId, async (mcp) => {
        const list = await callToolOk(mcp, "credential-bindings", { action: "list" });
        const toolBindings = asRecords(structured(list), "bindings");
        expect(
          toolBindings.some((binding) => binding.id === headerId && binding.active === true) &&
            toolText(list).includes(configKey),
          "the tool must list the standalone bindings",
        );
        const saved = await callToolOk(mcp, "credential-bindings", {
          action: "upsert",
          configKey: toolKey,
          allowedHosts: [stub.hostname],
          headerTemplate: `Authorization: Bearer [REDACTED:${toolKey}]`,
        });
        const savedBinding = asRecords(structured(saved), "bindings").find(
          (binding) => binding.configKey === toolKey,
        );
        expect(savedBinding && savedBinding.active === true, "upsert must return the binding");
        const toolBindingId = asString(savedBinding.id, "tool binding id");
        bindingIds.push(toolBindingId);
        const viaHttp = await ctx.api("GET", "/api/credential-bindings");
        expect(
          asRecords(viaHttp.json, "bindings").some((binding) => binding.id === toolBindingId),
          "the tool and the HTTP route share the store",
        );
        const disabled = await callToolOk(mcp, "credential-bindings", {
          action: "disable",
          id: toolBindingId,
        });
        expect(toolText(disabled).includes("disabled"), "disable text");
        const afterDisable = ctx.db.get<{ active: number }>(
          "SELECT active FROM script_credential_bindings WHERE id = ?",
          [toolBindingId],
        );
        expect(afterDisable?.active === 0, "disable must deactivate the binding");
        const unknownDisable = await callToolErr(mcp, "credential-bindings", {
          action: "disable",
          id: "00000000-0000-4000-8000-000000000000",
        });
        expect(toolText(unknownDisable).includes("not found"), "disable of an unknown id");
        for (const [args, expected] of [
          [{ action: "upsert", configKey: toolKey }, "allowedHosts and at least one"],
          [{ action: "upsert" }, "configKey is required"],
          [
            {
              action: "upsert",
              configKey: toolKey,
              allowedHosts: [stub.hostname],
              headerTemplate: "no placeholder",
            },
            "must include",
          ],
          [
            {
              action: "upsert",
              configKey: toolKey,
              allowedHosts: [stub.hostname],
              headerTemplate: `X: [REDACTED:${toolKey}]`,
              authKind: "oauth",
            },
            "oauthAuthorizationId is required",
          ],
          [{ action: "oauth-app-upsert", provider: "e2e-incomplete" }, "clientId, clientSecret"],
          [{ action: "oauth-app-upsert", presetId: "no-such-preset" }, "Unknown presetId"],
          [{ action: "oauth-authorize-url" }, "provider is required"],
          [
            { action: "oauth-authorize-url", provider: `e2e-none-${ctx.nonce}` },
            "is not configured",
          ],
          [{ action: "oauth-authorizations-list" }, "provider is required"],
          [
            { action: "oauth-authorizations-list", provider: `e2e-none-${ctx.nonce}` },
            "is not configured",
          ],
        ] as const) {
          const failed = await callToolErr(mcp, "credential-bindings", { ...args });
          expect(
            toolText(failed).includes(expected),
            `${args.action} should fail with "${expected}": ${toolText(failed).slice(0, 200)}`,
          );
        }

        // OAuth app lifecycle through the tool: register, build an authorize URL, list grants
        oauthProvider = `e2eprov${ctx.nonce}`;
        const app = await callToolOk(mcp, "credential-bindings", {
          action: "oauth-app-upsert",
          provider: oauthProvider,
          clientId: `client-${ctx.nonce}`,
          clientSecret: `client-secret-${ctx.nonce}`,
          authorizeUrl: "https://idp.e2e-example.com/authorize",
          tokenUrl: "https://idp.e2e-example.com/token",
          scopes: ["read"],
        });
        expect(
          structured(app).provider === oauthProvider &&
            String(structured(app).redirectUri).endsWith("/api/oauth/callback"),
          "oauth-app-upsert must report the provider and callback URL",
        );
        const authorize = await callToolOk(mcp, "credential-bindings", {
          action: "oauth-authorize-url",
          provider: oauthProvider,
          label: "e2e",
        });
        const authorizeUrl = new URL(asString(structured(authorize).authorizeUrl, "authorize url"));
        expect(
          authorizeUrl.origin === "https://idp.e2e-example.com" &&
            authorizeUrl.searchParams.get("client_id") === `client-${ctx.nonce}` &&
            authorizeUrl.searchParams.get("state") === structured(authorize).state,
          "the authorize URL must carry the client id and the state",
        );
        const grants = await callToolOk(mcp, "credential-bindings", {
          action: "oauth-authorizations-list",
          provider: oauthProvider,
        });
        expect(
          Array.isArray(structured(grants).authorizations) &&
            (structured(grants).authorizations as unknown[]).length === 0,
          "a fresh OAuth app has no authorizations",
        );
      });

      // ── deactivated bindings stop substituting: the header is dropped, not sent raw ──
      stub.seen.length = 0;
      for (const id of [headerId, queryBindingId]) {
        const off = await ctx.api("POST", "/api/credential-bindings", {
          body: {
            id,
            configKey,
            allowedHosts: [stub.hostname],
            ...(id === headerId
              ? { headerTemplate: `Authorization: Bearer ${placeholder}` }
              : { queryTemplate: `access_token=${placeholder}` }),
            active: false,
          },
        });
        expectStatus(off, [200], "deactivate a binding");
        expect(asRecord(asRecord(off.json).binding).active === false, "active:false must stick");
      }
      await runScript(ctx, workerId, {
        source: fetchSource("/after-off", true),
        intent: `e2e broker off ${ctx.nonce}`,
      });
      const afterOff = stub.seen.find((request) => request.path === "/after-off");
      expect(afterOff, "the stub never received the post-deactivation request");
      expect(
        afterOff.headers.authorization === undefined,
        `a deactivated binding must drop the placeholder header, got ${afterOff.headers.authorization}`,
      );
    } finally {
      stub.stop();
      // bindings have no delete route: deactivate what is left so nothing leaks into later scenarios
      for (const id of bindingIds) {
        const stored = ctx.db.get<{
          config_key: string;
          header_template: string | null;
          query_template: string | null;
          allowed_hosts_json: string;
        }>(
          "SELECT config_key, header_template, query_template, allowed_hosts_json FROM script_credential_bindings WHERE id = ?",
          [id],
        );
        if (!stored) continue;
        await ctx.api("POST", "/api/credential-bindings", {
          body: {
            id,
            configKey: stored.config_key,
            allowedHosts: JSON.parse(stored.allowed_hosts_json),
            ...(stored.header_template ? { headerTemplate: stored.header_template } : {}),
            ...(stored.query_template ? { queryTemplate: stored.query_template } : {}),
            active: false,
          },
        });
      }
      if (oauthProvider) await ctx.api("DELETE", `/api/oauth-apps/${oauthProvider}`);
      if (configId) await ctx.api("DELETE", `/api/config/${configId}`);
    }
  },
};
