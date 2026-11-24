import { sql } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { retireAgent } from "./core-helpers";
import { registerAgent, runScript, startStub } from "./script-helpers";

/**
 * Flow `script-credential-egress`: where a config binding's value comes from. A binding
 * resolves from swarm_config rows. The API process env backs only the default
 * `GITHUB_TOKEN` binding. Reserved and API-only keys never resolve, from config or env.
 */
export const scriptCredentialBindingSources: Scenario = {
  name: "script-credential-binding-sources",
  order: 481,
  async run(ctx) {
    const nonce = ctx.nonce.toUpperCase();
    const envOnlyKey = `E2E_ENV_ONLY_${nonce}`;
    const envOnlyValue = `e2e-env-only-${ctx.nonce}-7311`;
    const githubValue = `e2e-github-env-${ctx.nonce}-7312`;
    const configKey = `E2E_CONFIG_BACKED_${nonce}`;
    const configValue = `e2e-config-backed-${ctx.nonce}-7313`;
    const apiOnlyValue = `e2e-api-only-${ctx.nonce}-7314`;
    const operatorKey = asString(ctx.sutEnv.AGENT_SWARM_API_KEY, "the SUT swarm API key");
    const stub = startStub(() => Response.json({ ok: true }));
    const bindingIds: string[] = [];
    const configIds: string[] = [];
    let workerId: string | undefined;
    try {
      await ctx.restartSut({ env: { [envOnlyKey]: envOnlyValue, GITHUB_TOKEN: githubValue } });
      workerId = await registerAgent(ctx, "binding-sources");

      for (const [key, value] of [
        [configKey, configValue],
        ["API_AGENT_FS_API_KEY", apiOnlyValue],
      ] as const) {
        const stored = await ctx.api("PUT", "/api/config", {
          body: { scope: "global", scopeId: null, key, value, isSecret: true },
        });
        expectStatus(stored, [200], `store ${key}`);
        configIds.push(asString(asRecord(stored.json).id, "config id"));
      }

      // One binding per key, each on its own header, all pointed at the stub.
      const keys = [envOnlyKey, "AGENT_SWARM_API_KEY", "API_AGENT_FS_API_KEY", "GITHUB_TOKEN"];
      for (const key of [...keys, configKey]) {
        const binding = await ctx.api("POST", "/api/credential-bindings", {
          body: {
            configKey: key,
            allowedHosts: [stub.hostname],
            headerTemplate: `X-Key-${key.replaceAll("_", "-")}: [REDACTED:${key}]`,
          },
        });
        expectStatus(binding, [200], `create the ${key} binding`);
        bindingIds.push(asString(asRecord(asRecord(binding.json).binding).id, "binding id"));
      }

      const headers = [...keys, configKey]
        .map((key) => `"X-Key-${key.replaceAll("_", "-")}": "[REDACTED:${key}]"`)
        .join(", ");
      await runScript(ctx, workerId, {
        source: `export default async function () {
  const response = await fetch("${stub.origin}/sources", { headers: { ${headers} } });
  return response.status;
}`,
        intent: `e2e binding sources ${ctx.nonce}`,
      });
      const request = stub.seen.find((seen) => seen.path === "/sources");
      expect(request, "the stub never received the script's request");
      const header = (key: string) =>
        request.headers[`x-key-${key.replaceAll("_", "-").toLowerCase()}`];

      // ── refused: env-only keys outside the allowlist, and API-only keys ──
      // The fetch patch drops a header whose placeholder did not resolve.
      for (const key of [envOnlyKey, "AGENT_SWARM_API_KEY", "API_AGENT_FS_API_KEY"]) {
        expect(header(key) === undefined, `${key} must not resolve, got ${header(key)}`);
      }
      const sent = JSON.stringify(request.headers);
      expect(
        !sent.includes(envOnlyValue) && !sent.includes(apiOnlyValue) && !sent.includes(operatorKey),
        "no refused value may reach the upstream",
      );

      // ── still works: config rows, and the GITHUB_TOKEN env fallback ──
      expect(header(configKey) === configValue, "a config-backed binding must still resolve");
      expect(
        header("GITHUB_TOKEN") === githubValue,
        "GITHUB_TOKEN must still resolve from the API env",
      );
    } finally {
      stub.stop();
      // Bindings have no delete route: deactivate them so nothing leaks into later scenarios.
      for (const id of bindingIds) {
        const stored = ctx.db.get<{
          config_key: string;
          header_template: string;
          allowed_hosts_json: string;
        }>(
          sql`SELECT config_key, header_template, allowed_hosts_json FROM script_credential_bindings WHERE id = ${id}`,
        );
        if (!stored) continue;
        await ctx.api("POST", "/api/credential-bindings", {
          body: {
            id,
            configKey: stored.config_key,
            allowedHosts: JSON.parse(stored.allowed_hosts_json),
            headerTemplate: stored.header_template,
            active: false,
          },
        });
      }
      for (const id of configIds) await ctx.api("DELETE", `/api/config/${id}`);
      if (workerId) await retireAgent(ctx, workerId);
      // Boot the base env again, without the extra variables.
      await ctx.restartSut();
    }
  },
};
