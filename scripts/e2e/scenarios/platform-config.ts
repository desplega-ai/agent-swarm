import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  cleanupStack,
  deleteConfig,
  expectToolError,
  expectToolOk,
  putConfig,
  registerAgent,
  reloadConfig,
} from "./platform-helpers";

// The swarm_config store over HTTP and over the read-only MCP tools a worker holds:
// scopes, secret masking, scope precedence, validation, the reload endpoint. The
// write-side tools (set-config, delete-config) are lead-only and live in
// platform-lead-tools.

const SECRET_MASK = "********";

export const platformConfig: Scenario = {
  name: "platform-config",
  order: 625,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const prefix = `E2E_PLATFORM_${ctx.nonce.toUpperCase()}`;
    const keyPlain = `${prefix}_PLAIN`;
    const keySecret = `${prefix}_SECRET`;
    const keyScoped = `${prefix}_SCOPED`;
    const keyEnv = `${prefix}_ENV`;
    const track = async (input: Parameters<typeof putConfig>[1], query = "") => {
      const row = await putConfig(ctx, input, query);
      const id = String(row.id);
      cleanup.add(`delete ${input.key}`, async () => {
        await ctx.api("DELETE", `/api/config/${id}`);
      });
      return row;
    };
    try {
      // ── auth ───────────────────────────────────────────────────────────────
      for (const [method, path] of [
        ["GET", "/api/config"],
        ["GET", "/api/config/resolved"],
        ["GET", "/api/config/some-id"],
        ["PUT", "/api/config"],
        ["DELETE", "/api/config/some-id"],
        ["POST", "/api/config/reload"],
      ] as const) {
        expectStatus(
          await ctx.api(method, path, {
            apiKey: null,
            body: method === "PUT" || method === "POST" ? {} : undefined,
          }),
          [401],
          `${method} ${path} unauth`,
        );
      }

      // ── plain values ───────────────────────────────────────────────────────
      const plain = await track({ key: keyPlain, value: "first", description: "e2e plain value" });
      expect(
        plain.scope === "global" &&
          plain.scopeId === null &&
          plain.key === keyPlain &&
          plain.value === "first" &&
          plain.isSecret === false &&
          plain.encrypted === false &&
          plain.exportToEnv === true &&
          plain.description === "e2e plain value",
        `a plain global row carries the documented fields: ${JSON.stringify(plain)}`,
      );
      // Upsert is keyed by (scope, scopeId, key): the second write updates the same row.
      const updated = await putConfig(ctx, { key: keyPlain, value: "second" });
      expect(
        updated.id === plain.id && updated.value === "second",
        "a second PUT updates the same row",
      );
      const byKey = await ctx.api("GET", `/api/config?scope=global&key=${keyPlain}`);
      expect(asRecords(byKey.json, "configs").length === 1, "the key filter finds exactly one row");
      // A non-string value is stored as its string form.
      const numeric = await putConfig(ctx, { key: keyPlain, value: "7" });
      expect(numeric.value === "7", "values are strings");
      const raw = await ctx.api("PUT", "/api/config", {
        body: { scope: "global", key: keyPlain, value: 12 },
      });
      expectStatus(raw, [200], "PUT a numeric value");
      expect(asRecord(raw.json).value === "12", "a numeric value is stored as its string form");

      const byId = await ctx.api("GET", `/api/config/${String(plain.id)}`);
      expectStatus(byId, [200], "get config by id");
      expect(
        asRecord(byId.json).id === plain.id && asRecord(byId.json).value === "12",
        "get by id returns the row",
      );
      expectStatus(
        await ctx.api("GET", "/api/config/no-such-config"),
        [404],
        "get an unknown config",
      );

      // ── secrets ────────────────────────────────────────────────────────────
      const secret = await track({ key: keySecret, value: "s3cret-value", isSecret: true });
      expect(
        secret.value === SECRET_MASK && secret.isSecret === true && secret.encrypted === true,
        "a secret is masked and encrypted on write",
      );
      const stored = ctx.db.get<{ value: string; encrypted: number }>(
        "SELECT value, encrypted FROM swarm_config WHERE id = ?",
        [String(secret.id)],
      );
      expect(
        stored?.encrypted === 1 && stored.value !== "s3cret-value",
        "the secret is stored as ciphertext",
      );
      const listed = asRecords(
        (await ctx.api("GET", `/api/config?scope=global&key=${keySecret}`)).json,
        "configs",
      );
      expect(listed[0]?.value === SECRET_MASK, "list masks secrets");
      const revealedList = asRecords(
        (await ctx.api("GET", `/api/config?scope=global&key=${keySecret}&includeSecrets=true`))
          .json,
        "configs",
      );
      expect(
        revealedList[0]?.value === "s3cret-value",
        "includeSecrets reveals secrets to the operator",
      );
      expect(
        asRecord((await ctx.api("GET", `/api/config/${String(secret.id)}`)).json).value ===
          SECRET_MASK,
        "get by id masks secrets",
      );
      expect(
        asRecord(
          (await ctx.api("GET", `/api/config/${String(secret.id)}?includeSecrets=true`)).json,
        ).value === "s3cret-value",
        "get by id reveals with includeSecrets",
      );
      const revealedWrite = await ctx.api("PUT", "/api/config?includeSecrets=true", {
        body: { scope: "global", key: keySecret, value: "s3cret-value", isSecret: true },
      });
      expect(
        asRecord(revealedWrite.json).value === "s3cret-value",
        "PUT with includeSecrets echoes the value",
      );

      // ── scopes and precedence ──────────────────────────────────────────────
      const agentId = await registerAgent(ctx, "config");
      const repoId = crypto.randomUUID();
      await track({ key: keyScoped, value: "from-global" });
      const agentRow = await track({
        key: keyScoped,
        value: "from-agent",
        scope: "agent",
        scopeId: agentId,
      });
      expect(
        agentRow.scope === "agent" && agentRow.scopeId === agentId,
        "an agent row keeps its scope id",
      );
      const repoRow = await track({
        key: keyScoped,
        value: "from-repo",
        scope: "repo",
        scopeId: repoId,
      });
      expect(repoRow.id !== agentRow.id, "each scope is its own row");
      const resolve = async (query: string) => {
        const response = await ctx.api("GET", `/api/config/resolved?key=${keyScoped}&${query}`);
        expectStatus(response, [200], `resolved ${query}`);
        return asRecords(response.json, "configs");
      };
      const globalOnly = await resolve("");
      expect(
        globalOnly.length === 1 && globalOnly[0]?.value === "from-global",
        "with no ids only the global row resolves",
      );
      const forAgent = await resolve(`agentId=${agentId}`);
      expect(forAgent.length === 1 && forAgent[0]?.value === "from-agent", "agent beats global");
      const forRepo = await resolve(`agentId=${agentId}&repoId=${repoId}`);
      expect(forRepo.length === 1 && forRepo[0]?.value === "from-repo", "repo beats agent");
      const secretResolved = await ctx.api("GET", `/api/config/resolved?key=${keySecret}`);
      expect(
        asRecords(secretResolved.json, "configs")[0]?.value === SECRET_MASK,
        "resolved masks secrets by default",
      );
      const secretRevealed = await ctx.api(
        "GET",
        `/api/config/resolved?key=${keySecret}&includeSecrets=true`,
      );
      expect(
        asRecords(secretRevealed.json, "configs")[0]?.value === "s3cret-value",
        "resolved reveals with includeSecrets",
      );

      const agentList = asRecords(
        (await ctx.api("GET", `/api/config?scope=agent&scopeId=${agentId}`)).json,
        "configs",
      );
      expect(
        agentList.length === 1 && agentList[0]?.key === keyScoped,
        "list filters by scope and scopeId",
      );
      expectStatus(
        await ctx.api("PUT", "/api/config", {
          body: { scope: "agent", key: keyScoped, value: "x" },
        }),
        [400],
        "an agent-scope row needs a scopeId",
      );
      expectStatus(
        await ctx.api("PUT", "/api/config", {
          body: { scope: "planet", key: keyScoped, value: "x" },
        }),
        [400],
        "unknown scope",
      );
      expectStatus(
        await ctx.api("PUT", "/api/config", { body: { scope: "global", key: "", value: "x" } }),
        [400],
        "empty key",
      );

      // ── validation ─────────────────────────────────────────────────────────
      const invalid: Array<[Record<string, unknown>, string]> = [
        [{ key: "API_KEY", value: "x" }, "a reserved key"],
        [{ key: "api_key", value: "x" }, "a reserved key in another case"],
        [{ key: "SECRETS_ENCRYPTION_KEY", value: "x" }, "the encryption key"],
        [{ key: "onboarding_state", value: "x" }, "an internal key"],
        [{ key: "RUNTIME_POOLS_ENABLED", value: "maybe" }, "a boolean-validated key"],
        [{ key: "RUNTIME_DEFAULT_DELIVERY", value: "carrier-pigeon" }, "an enum-validated key"],
        [
          { key: "SLACK_SIGNING_SECRET", value: "x", exportToEnv: true },
          "an API-only key exported to env",
        ],
      ];
      for (const [fields, label] of invalid) {
        const response = await ctx.api("PUT", "/api/config", {
          body: { scope: "global", ...fields },
        });
        expectStatus(response, [400], `PUT ${label}`);
        expect(
          typeof asRecord(response.json).error === "string",
          `${label}: the error names the problem`,
        );
      }
      const reserved = await ctx.api("PUT", "/api/config", {
        body: { scope: "global", key: "API_KEY", value: "x" },
      });
      expect(
        String(asRecord(reserved.json).error).includes("reserved"),
        "the reserved-key error says reserved",
      );
      expect(
        ctx.db.get(
          "SELECT 1 AS one FROM swarm_config WHERE key IN ('API_KEY', 'api_key', 'RUNTIME_POOLS_ENABLED', 'RUNTIME_DEFAULT_DELIVERY')",
        ) === null,
        "rejected writes persist nothing",
      );

      // ── internal rows stay out of the generic API ─────────────────────────
      expectStatus(
        await ctx.api("GET", "/api/onboarding"),
        [200],
        "create the onboarding state row",
      );
      const internal = ctx.db.get<{ id: string }>(
        "SELECT id FROM swarm_config WHERE key = 'onboarding_state'",
      );
      expect(internal, "the onboarding state is stored in swarm_config");
      expect(
        asRecords((await ctx.api("GET", "/api/config?scope=global")).json, "configs").every(
          (c) => c.key !== "onboarding_state",
        ),
        "the list hides internal rows",
      );
      expectStatus(
        await ctx.api("GET", `/api/config/${internal.id}`),
        [404],
        "get an internal row by id",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/config/${internal.id}`),
        [400],
        "delete an internal row",
      );

      // ── reload ─────────────────────────────────────────────────────────────
      await track({ key: keyEnv, value: "env-value" });
      const reloaded = await reloadConfig(ctx);
      expect(
        reloaded.success === true && typeof reloaded.configsLoaded === "number",
        "reload reports success and a count",
      );
      expect(
        Array.isArray(reloaded.keysUpdated) && Array.isArray(reloaded.integrationsReinitialized),
        "reload lists keys and integrations",
      );
      const presence = await ctx.api("GET", `/api/config/env-presence?keys=${keyEnv}`);
      expect(
        asRecord(asRecord(presence.json).presence)[keyEnv] === true,
        "a stored row reaches the server env after reload",
      );

      // ── read tools a worker holds ──────────────────────────────────────────
      const workerId = await registerAgent(ctx, "config-worker");
      const worker = await ctx.connectMcp(workerId);
      try {
        const got = expectToolOk(
          await callTool(worker, "get-config", { key: keySecret }),
          "get-config",
        );
        const gotConfigs = got.data.configs as Array<Record<string, unknown>>;
        expect(
          got.data.count === 1 && gotConfigs[0]?.value === SECRET_MASK,
          "get-config masks secrets",
        );
        const askedSecrets = expectToolOk(
          await callTool(worker, "get-config", { key: keySecret, includeSecrets: true }),
          "get-config includeSecrets",
        );
        expect(
          (askedSecrets.data.configs as Array<Record<string, unknown>>)[0]?.value === SECRET_MASK &&
            askedSecrets.message.includes("requires the lead agent"),
          "a worker asking for secrets still gets them masked, with a note",
        );
        const scoped = expectToolOk(
          await callTool(worker, "get-config", { key: keyScoped, agentId }),
          "get-config with agent scope",
        );
        expect(
          (scoped.data.configs as Array<Record<string, unknown>>)[0]?.value === "from-agent",
          "get-config resolves the agent scope",
        );
        const none = expectToolOk(
          await callTool(worker, "get-config", { key: `${prefix}_NOPE` }),
          "get-config unknown key",
        );
        expect(
          none.data.count === 0 && none.message === "No configs found.",
          "get-config reports an empty result",
        );

        const raw = expectToolOk(
          await callTool(worker, "list-config", { scope: "agent", scopeId: agentId }),
          "list-config",
        );
        const rows = raw.data.configs as Array<Record<string, unknown>>;
        expect(
          raw.data.count === 1 && rows[0]?.key === keyScoped && rows[0]?.value === "from-agent",
          "list-config returns raw rows without resolution",
        );
        const hidden = expectToolOk(
          await callTool(worker, "list-config", { key: keySecret }),
          "list-config secret",
        );
        expect(
          (hidden.data.configs as Array<Record<string, unknown>>)[0]?.value === SECRET_MASK,
          "list-config masks secrets",
        );
        const internalRows = expectToolOk(
          await callTool(worker, "list-config", { key: "onboarding_state" }),
          "list-config internal",
        );
        expect(internalRows.data.count === 0, "list-config hides internal rows");
        const badScope = await callTool(worker, "list-config", { scope: "planet" });
        expect(badScope.isError, "list-config rejects an unknown scope");

        // Writing config is lead-only.
        expectToolError(
          await callTool(worker, "set-config", {
            scope: "global",
            key: `${prefix}_DENIED`,
            value: "x",
          }),
          "set-config as a worker",
          "requires the lead agent",
        );
        expectToolError(
          await callTool(worker, "delete-config", { id: String(plain.id) }),
          "delete-config as a worker",
          "requires the lead agent",
        );
        expect(
          ctx.db.get("SELECT 1 AS one FROM swarm_config WHERE key = ?", [`${prefix}_DENIED`]) ===
            null &&
            ctx.db.get("SELECT 1 AS one FROM swarm_config WHERE id = ?", [String(plain.id)]) !==
              null,
          "the denied calls changed nothing",
        );
      } finally {
        await worker.close();
      }

      // ── delete ─────────────────────────────────────────────────────────────
      await deleteConfig(ctx, String(plain.id));
      expectStatus(
        await ctx.api("GET", `/api/config/${String(plain.id)}`),
        [404],
        "get a deleted config",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/config/${String(plain.id)}`),
        [404],
        "delete a config twice",
      );
      expectStatus(
        await ctx.api("DELETE", "/api/config/no-such-config"),
        [404],
        "delete an unknown config",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM swarm_config WHERE id = ?", [String(plain.id)]) === null,
        "the deleted row is gone from the table",
      );
    } finally {
      await cleanup.run();
    }
  },
};
