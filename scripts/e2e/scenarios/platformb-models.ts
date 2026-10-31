import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  Cleanup,
  callTool,
  expectToolError,
  expectToolOk,
  registerLead,
  registerWorker,
  retireAgent,
} from "./platformb-helpers";

const REFRESH_STATUSES = ["updated", "not-modified", "skipped-fresh", "skipped-cooldown", "error"];

type RefreshResult = { status: string; json: Record<string, unknown> };

/**
 * `POST /api/models-catalog/refresh` fetches models.dev with no timeout of its own, so the call
 * goes through a raw fetch with one. The result depends on the network the run has: updated,
 * not-modified or error are all documented answers.
 */
async function refreshOverHttp(
  ctx: ScenarioContext,
  body: Record<string, unknown>,
  agentId?: string,
): Promise<{ httpStatus: number; json: Record<string, unknown> }> {
  const started = performance.now();
  const response = await fetch(`${ctx.baseUrl}/api/models-catalog/refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.apiKey}`,
      "Content-Type": "application/json",
      ...(agentId ? { "X-Agent-ID": agentId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  ctx.recordHttpCall(
    "POST",
    "/api/models-catalog/refresh",
    response.status,
    performance.now() - started,
  );
  const json = (await response.json()) as Record<string, unknown>;
  return { httpStatus: response.status, json };
}

function expectRefreshShape(result: Record<string, unknown>, label: string): RefreshResult {
  const status = result.status;
  expect(
    typeof status === "string" && REFRESH_STATUSES.includes(status),
    `${label}: status is ${JSON.stringify(status)}`,
  );
  expect(typeof result.models === "number", `${label}: models is not a number`);
  expect(Array.isArray(result.added), `${label}: added is not an array`);
  expect(
    result.checkedAt === null || typeof result.checkedAt === "number",
    `${label}: checkedAt is neither null nor a number`,
  );
  if (status === "skipped-cooldown") {
    expect(
      typeof result.retryAfterMs === "number" && result.retryAfterMs > 0,
      `${label}: a cooldown answer carries no retryAfterMs`,
    );
  }
  if (status === "error") {
    expect(typeof result.error === "string", `${label}: an error answer carries no error text`);
  }
  return { status, json: result };
}

async function readCatalog(ctx: ScenarioContext): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", "/api/models-catalog");
  expectStatus(response, [200], "read model catalog");
  return asRecord(response.json);
}

async function profileNamed(ctx: ScenarioContext, name: string): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", `/api/model-profiles/${name}`);
  expectStatus(response, [200], `read profile ${name}`);
  return asRecord(response.json);
}

/**
 * Model profiles, the model catalog (read, tiers, overlay, harness support, refresh) and the
 * append-only price book, over HTTP and over the two lead-only catalog tools.
 */
export const platformbModels: Scenario = {
  name: "platformb-models",
  order: 660,
  async run(ctx) {
    const cleanup = new Cleanup();
    const profileNames: string[] = [];
    const overlays: { provider: string; modelId: string }[] = [];
    const priceRows: { provider: string; model: string; tokenClass: string; from: number }[] = [];
    const taskIds: string[] = [];
    let leadId: string | undefined;
    let defaultProfileAgentId: string | undefined;
    let workerConn: Awaited<ReturnType<ScenarioContext["connectMcp"]>> | undefined;
    let leadConn: Awaited<ReturnType<ScenarioContext["connectMcp"]>> | undefined;
    cleanup.add("close MCP", async () => {
      await workerConn?.close();
      await leadConn?.close();
    });
    cleanup.add("retire lead", () => retireAgent(ctx, leadId));
    cleanup.add("cancel tasks", async () => {
      for (const id of taskIds) await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: {} });
    });
    cleanup.add("delete price rows", async () => {
      for (const row of priceRows) {
        await ctx.api(
          "DELETE",
          `/api/pricing/${row.provider}/${row.model}/${row.tokenClass}/${row.from}`,
        );
      }
    });
    cleanup.add("delete overlays", async () => {
      for (const body of overlays) await ctx.api("DELETE", "/api/models-catalog/overlay", { body });
    });
    cleanup.add("delete profiles", async () => {
      for (const name of profileNames) await ctx.api("DELETE", `/api/model-profiles/${name}`);
    });
    cleanup.add("clear the agent default profile", async () => {
      if (!defaultProfileAgentId) return;
      await ctx.api("PATCH", `/api/agents/${defaultProfileAgentId}/runtime`, {
        body: { harness_provider: "claude", profile: null },
      });
    });

    await cleanup.around(async () => {
      const workerId = await registerWorker(ctx, `e2e-platformb-models-worker-${ctx.nonce}`);
      leadId = await registerLead(ctx, `e2e-platformb-models-lead-${ctx.nonce}`);

      // ===== model profiles =====
      let response = await ctx.api("GET", "/api/model-profiles");
      expectStatus(response, [200], "list model profiles");
      const seeded = asRecords(response.json, "profiles");
      const claudeRegular = seeded.find((profile) => profile.name === "claude-regular");
      expect(
        claudeRegular?.harness === "claude" && claudeRegular.seededFrom === "tier:regular",
        "The shipped claude-regular tier profile is missing",
      );
      response = await ctx.api("GET", "/api/model-profiles?harness=codex");
      expectStatus(response, [200], "list codex profiles");
      const codexProfiles = asRecords(response.json, "profiles");
      expect(
        codexProfiles.length > 0 && codexProfiles.every((profile) => profile.harness === "codex"),
        "The harness filter returned a profile from another harness",
      );
      expectStatus(
        await ctx.api("GET", "/api/model-profiles?harness=not-a-harness"),
        [400],
        "list profiles of an unknown harness",
      );

      const profileName = `e2e-prof-${ctx.nonce}`;
      profileNames.push(profileName);
      response = await ctx.api("POST", "/api/model-profiles", {
        body: {
          name: profileName,
          harness: "claude",
          model: "opus",
          effort: "high",
          description: "e2e profile",
        },
      });
      expectStatus(response, [201], "create a model profile");
      const profile = asRecord(response.json);
      expect(
        profile.name === profileName &&
          profile.harness === "claude" &&
          profile.model === "opus" &&
          profile.effort === "high" &&
          profile.allowCustomModel === false &&
          profile.description === "e2e profile" &&
          profile.seededFrom === null,
        `Created profile is ${JSON.stringify(profile)}`,
      );
      const profileRow = ctx.db.get<{ harness: string; model: string; effort: string }>(
        "SELECT harness, model, effort FROM model_profiles WHERE name = ?",
        [profileName],
      );
      expect(
        profileRow?.harness === "claude" &&
          profileRow.model === "opus" &&
          profileRow.effort === "high",
        "Profile is not in model_profiles",
      );
      expect(
        JSON.stringify(await profileNamed(ctx, profileName)) === JSON.stringify(profile),
        "GET profile differs from the create response",
      );

      response = await ctx.api("POST", "/api/model-profiles", {
        body: { name: profileName, harness: "claude", model: "opus" },
      });
      expectStatus(response, [409], "create a duplicate profile");
      response = await ctx.api("POST", "/api/model-profiles", {
        body: { name: `Bad Name ${ctx.nonce}`, harness: "claude", model: "opus" },
      });
      expectStatus(response, [400], "reject an uppercase profile name");
      response = await ctx.api("POST", "/api/model-profiles", {
        body: { name: `e2e-prof-unknown-${ctx.nonce}`, harness: "claude", model: "no-such-model" },
      });
      expectStatus(response, [400], "reject a model outside the catalog");
      expect(
        String(asRecord(response.json).error).includes("allowCustomModel"),
        "The unknown-model error does not mention allowCustomModel",
      );
      response = await ctx.api("POST", "/api/model-profiles", {
        body: {
          name: `e2e-prof-codex-claude-${ctx.nonce}`,
          harness: "codex",
          model: "claude-opus-5-5",
        },
      });
      expectStatus(response, [400], "reject a Claude catalog model on the codex harness");
      expect(
        String(asRecord(response.json).error).includes("does not run on the codex harness"),
        `Harness mismatch error is ${String(asRecord(response.json).error)}`,
      );
      response = await ctx.api("POST", "/api/model-profiles", {
        body: {
          name: `e2e-prof-effort-${ctx.nonce}`,
          harness: "claude",
          model: "opus",
          effort: "off",
        },
      });
      expectStatus(response, [400], "reject an effort the model does not support");
      response = await ctx.api("POST", "/api/model-profiles", {
        body: {
          name: `e2e-prof-effort2-${ctx.nonce}`,
          harness: "claude",
          model: "opus",
          effort: "ludicrous",
        },
      });
      expectStatus(response, [400], "reject an unknown effort level");

      const customName = `e2e-prof-custom-${ctx.nonce}`;
      profileNames.push(customName);
      response = await ctx.api("POST", "/api/model-profiles", {
        body: {
          name: customName,
          harness: "claude",
          model: `gateway-model-${ctx.nonce}`,
          allowCustomModel: true,
        },
      });
      expectStatus(response, [201], "create a profile with a custom model");
      expect(
        asRecord(response.json).allowCustomModel === true &&
          asRecord(response.json).effort === null,
        "Custom-model profile lost its flag",
      );

      // FINDING: the route says `model` must run on the profile's harness, and a Claude catalog id
      // on codex is a 400 (above), but a Claude CLI shortname ("opus") on codex is stored: the
      // shortname check is not harness aware.
      const shortnameName = `e2e-prof-shortname-${ctx.nonce}`;
      profileNames.push(shortnameName);
      response = await ctx.api("POST", "/api/model-profiles", {
        body: { name: shortnameName, harness: "codex", model: "opus" },
      });
      expectStatus(response, [201], "create a codex profile with the Claude shortname opus");

      response = await ctx.api("PATCH", `/api/model-profiles/${profileName}`, {
        body: { model: "sonnet", effort: null, description: "changed" },
      });
      expectStatus(response, [200], "update a profile");
      let updated = asRecord(response.json);
      expect(
        updated.model === "sonnet" &&
          updated.effort === null &&
          updated.description === "changed" &&
          updated.name === profileName &&
          updated.harness === "claude" &&
          updated.id === profile.id,
        `Updated profile is ${JSON.stringify(updated)}`,
      );
      expect(
        ctx.db.get<{ model: string }>("SELECT model FROM model_profiles WHERE name = ?", [
          profileName,
        ])?.model === "sonnet",
        "Profile update is not in model_profiles",
      );
      response = await ctx.api("PATCH", `/api/model-profiles/${profileName}`, {
        body: { effort: "max" },
      });
      expectStatus(response, [400], "reject an effort sonnet does not support");
      response = await ctx.api("PATCH", `/api/model-profiles/${profileName}`, {
        body: { effort: "ludicrous" },
      });
      expectStatus(response, [400], "reject an unknown effort on update");
      expectStatus(
        await ctx.api("PATCH", `/api/model-profiles/e2e-missing-${ctx.nonce}`, {
          body: { description: "ghost" },
        }),
        [404],
        "update a missing profile",
      );
      expectStatus(
        await ctx.api("GET", `/api/model-profiles/e2e-missing-${ctx.nonce}`),
        [404],
        "read a missing profile",
      );
      updated = await profileNamed(ctx, profileName);
      expect(updated.model === "sonnet", "A rejected update changed the profile");

      // Writes are operator only; reads are open.
      for (const [method, path, body] of [
        [
          "POST",
          "/api/model-profiles",
          { name: `e2e-prof-w-${ctx.nonce}`, harness: "claude", model: "opus" },
        ],
        ["PATCH", `/api/model-profiles/${profileName}`, { description: "worker edit" }],
        ["DELETE", `/api/model-profiles/${profileName}`, undefined],
      ] as const) {
        response = await ctx.api(method, path, { agentId: workerId, body });
        expectStatus(response, [403], `worker ${method} ${path}`);
        expect(
          String(asRecord(response.json).error).includes("requires the operator"),
          "Profile write refusal does not name the operator",
        );
      }
      expectStatus(
        await ctx.api("GET", `/api/model-profiles/${profileName}`, { agentId: workerId }),
        [200],
        "a worker reads a profile",
      );

      // Delete is refused for a shipped tier profile and for a profile in use.
      response = await ctx.api("DELETE", "/api/model-profiles/claude-regular");
      expectStatus(response, [409], "delete a shipped tier profile");
      expect(
        String(asRecord(response.json).error).includes("shipped tier profile"),
        "Seed deletion error does not say it is a tier profile",
      );
      response = await ctx.api("PATCH", `/api/agents/${workerId}/runtime`, {
        body: { harness_provider: "claude", profile: profileName },
      });
      expectStatus(response, [200], "make the profile an agent default");
      defaultProfileAgentId = workerId;
      response = await ctx.api("DELETE", `/api/model-profiles/${profileName}`);
      expectStatus(response, [409], "delete a profile that is an agent default");
      expect(
        String(asRecord(response.json).error).includes("default of 1 agent"),
        `In-use error is ${String(asRecord(response.json).error)}`,
      );
      expectStatus(
        await ctx.api("PATCH", `/api/agents/${workerId}/runtime`, {
          body: { harness_provider: "claude", profile: null },
        }),
        [200],
        "clear the agent default profile",
      );
      response = await ctx.api("POST", "/api/tasks", {
        body: { task: `profile holder ${ctx.nonce}`, profile: profileName, source: "api" },
      });
      expectStatus(response, [201], "create a task that holds the profile");
      const holderId = asString(asRecord(response.json).id, "holder task id");
      taskIds.push(holderId);
      response = await ctx.api("DELETE", `/api/model-profiles/${profileName}`);
      expectStatus(response, [409], "delete a profile a task holds");
      expect(
        String(asRecord(response.json).error).includes("held by 1 unfinished"),
        `Task-held error is ${String(asRecord(response.json).error)}`,
      );
      expectStatus(
        await ctx.api("POST", `/api/tasks/${holderId}/cancel`, { body: {} }),
        [200],
        "cancel the holder task",
      );
      for (const name of [profileName, customName, shortnameName]) {
        response = await ctx.api("DELETE", `/api/model-profiles/${name}`);
        expectStatus(response, [200], `delete profile ${name}`);
        expect(asRecord(response.json).deleted === true, "Profile delete did not say deleted");
        expectStatus(
          await ctx.api("GET", `/api/model-profiles/${name}`),
          [404],
          `read deleted profile ${name}`,
        );
        expectStatus(
          await ctx.api("DELETE", `/api/model-profiles/${name}`),
          [404],
          `delete profile ${name} twice`,
        );
        expect(
          ctx.db.get("SELECT id FROM model_profiles WHERE name = ?", [name]) === null,
          "Deleted profile is still in model_profiles",
        );
      }
      profileNames.length = 0;

      // ===== model catalog =====
      const catalog = await readCatalog(ctx);
      expect(catalog.source === "live" || catalog.source === "snapshot", "Catalog source is odd");
      expect(
        catalog.updatedAt === null || typeof catalog.updatedAt === "number",
        "Catalog updatedAt is neither null nor a number",
      );
      if (catalog.source === "snapshot") expect(catalog.updatedAt === null, "Snapshot has a date");
      const providers = asRecord(catalog.providers);
      for (const id of ["anthropic", "openai", "openrouter", "amazon-bedrock"]) {
        const provider = asRecord(providers[id]);
        expect(
          provider.id === id && Object.keys(asRecord(provider.models)).length > 0,
          `Catalog provider ${id} is missing or empty`,
        );
      }
      // FINDING: the route description says the catalog serves only openrouter, anthropic, openai
      // and amazon-bedrock, but the live payload also carries other providers (opencode, vercel...).

      response = await ctx.api("GET", "/api/models-catalog/tiers");
      expectStatus(response, [200], "preview model tiers");
      const tiers = asRecords(response.json, "tiers");
      for (const provider of ["claude", "codex"]) {
        for (const tier of ["smol", "regular", "smart", "ultra"]) {
          const row = tiers.find((entry) => entry.provider === provider && entry.tier === tier);
          expect(row, `Tier preview has no ${provider}/${tier}`);
          expect(
            row.key === `MODEL_TIER_${provider.toUpperCase()}_${tier.toUpperCase()}` &&
              typeof row.defaultValue === "string" &&
              (row.source === "tier-config" || row.source === "tier-default"),
            `Tier row ${provider}/${tier} is ${JSON.stringify(row)}`,
          );
        }
      }

      // Overlay: the lead or the operator writes, a worker does not.
      const overlayModel = `e2e-overlay-${ctx.nonce}`;
      const overlayKey = { provider: "openai", modelId: overlayModel };
      overlays.push(overlayKey);
      const overlayBody = {
        ...overlayKey,
        name: `E2E Overlay ${ctx.nonce}`,
        contextWindow: 123_456,
        maxOutput: 4096,
        reasoning: true,
        pricing: { input: 1.25, output: 5 },
        reason: "e2e overlay",
        verifiedBy: "e2e",
        expiresWhenUpstreamMatches: false,
      };
      response = await ctx.api("PUT", "/api/models-catalog/overlay", {
        agentId: workerId,
        body: overlayBody,
      });
      expectStatus(response, [403], "worker writes an overlay");
      response = await ctx.api("PUT", "/api/models-catalog/overlay", {
        body: { provider: "openai", modelId: overlayModel },
      });
      expectStatus(response, [400], "reject an overlay with no reason");
      response = await ctx.api("PUT", "/api/models-catalog/overlay", { body: overlayBody });
      expectStatus(response, [200], "operator writes an overlay");
      let overlay = asRecord(response.json);
      expect(
        overlay.provider === "openai" &&
          overlay.modelId === overlayModel &&
          overlay.contextWindow === 123_456 &&
          overlay.reason === "e2e overlay" &&
          overlay.expiresWhenUpstreamMatches === false &&
          asRecord(overlay.pricing).input === 1.25 &&
          overlay.family === null &&
          typeof overlay.createdAt === "number",
        `Overlay response is ${JSON.stringify(overlay)}`,
      );
      expect(
        ctx.db.get<{ reason: string }>(
          "SELECT reason FROM model_catalog_overlay WHERE provider = ? AND modelId = ?",
          ["openai", overlayModel],
        )?.reason === "e2e overlay",
        "Overlay is not in model_catalog_overlay",
      );
      const merged = asRecord(asRecord(asRecord((await readCatalog(ctx)).providers).openai).models)[
        overlayModel
      ];
      expect(merged, "An overlay-only model is not served by GET /api/models-catalog");
      expect(
        asRecord(merged).name === `E2E Overlay ${ctx.nonce}` &&
          asRecord(asRecord(merged).limit).context === 123_456 &&
          asRecord(asRecord(merged).cost).output === 5,
        `Catalog entry for the overlay is ${JSON.stringify(merged)}`,
      );
      // An upsert replaces the facts of the same (provider, model) row.
      response = await ctx.api("PUT", "/api/models-catalog/overlay", {
        agentId: leadId,
        body: { ...overlayBody, contextWindow: 200_000, reason: "e2e overlay v2" },
      });
      expectStatus(response, [200], "lead rewrites the overlay");
      overlay = asRecord(response.json);
      expect(
        overlay.contextWindow === 200_000 && overlay.reason === "e2e overlay v2",
        "Overlay upsert did not replace the facts",
      );
      expect(
        Number(
          ctx.db.get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM model_catalog_overlay WHERE provider = ? AND modelId = ?",
            ["openai", overlayModel],
          )?.n,
        ) === 1,
        "Overlay upsert created a second row",
      );
      response = await ctx.api("DELETE", "/api/models-catalog/overlay", {
        agentId: workerId,
        body: overlayKey,
      });
      expectStatus(response, [403], "worker deletes an overlay");
      response = await ctx.api("DELETE", "/api/models-catalog/overlay", { body: overlayKey });
      expectStatus(response, [200], "delete the overlay");
      expect(asRecord(response.json).deleted === true, "Overlay delete did not say deleted");
      response = await ctx.api("DELETE", "/api/models-catalog/overlay", { body: overlayKey });
      expectStatus(response, [200], "delete the overlay twice");
      expect(asRecord(response.json).deleted === false, "A second overlay delete said deleted");
      expect(
        asRecord(asRecord(asRecord((await readCatalog(ctx)).providers).openai).models)[
          overlayModel
        ] === undefined,
        "A deleted overlay is still in the catalog",
      );
      overlays.length = 0;

      // Harness support: written by workers and operators, read by anyone.
      const cliVersion = `9.9.${ctx.nonce}`;
      response = await ctx.api("GET", "/api/models-catalog/harness-support");
      expectStatus(response, [200], "list harness support");
      expect(Array.isArray(asRecord(response.json).rows), "Harness support has no rows array");
      response = await ctx.api("PUT", "/api/models-catalog/harness-support", {
        body: { harness: "claude", cliVersion, modelId: "claude-opus-5-5", status: "ok" },
      });
      expectStatus(response, [200], "operator records harness support");
      let support = asRecord(response.json);
      expect(
        support.harness === "claude" &&
          support.cliVersion === cliVersion &&
          support.modelId === "claude-opus-5-5" &&
          support.status === "ok" &&
          support.error === null &&
          typeof support.checkedAt === "number",
        `Support row is ${JSON.stringify(support)}`,
      );
      response = await ctx.api("PUT", "/api/models-catalog/harness-support", {
        body: {
          harness: "claude",
          cliVersion,
          modelId: "claude-opus-5-5",
          status: "unsupported",
          error: "unknown model claude-opus-5-5",
        },
      });
      expectStatus(response, [200], "operator flips the support row");
      support = asRecord(response.json);
      expect(
        support.status === "unsupported" && support.error === "unknown model claude-opus-5-5",
        "Support upsert did not replace the row",
      );
      response = await ctx.api(
        "GET",
        `/api/models-catalog/harness-support?harness=claude&cliVersion=${cliVersion}`,
      );
      expectStatus(response, [200], "filter harness support");
      const rows = asRecords(response.json, "rows");
      expect(
        rows.length === 1 && rows[0]?.status === "unsupported" && rows[0].cliVersion === cliVersion,
        `Filtered support rows are ${JSON.stringify(rows)}`,
      );
      expect(
        ctx.db.get<{ status: string }>(
          "SELECT status FROM harness_model_support WHERE cliVersion = ?",
          [cliVersion],
        )?.status === "unsupported",
        "Support row is not in harness_model_support",
      );
      response = await ctx.api("PUT", "/api/models-catalog/harness-support", {
        body: { harness: "claude", cliVersion, modelId: "claude-opus-5-5", status: "maybe" },
      });
      expectStatus(response, [400], "reject an unknown support status");
      response = await ctx.api("PUT", "/api/models-catalog/harness-support", {
        agentId: workerId,
        body: { harness: "claude", cliVersion, modelId: "claude-opus-5-5", status: "ok" },
      });
      expectStatus(response, [403], "an agent records support for a CLI it did not register");

      // Refresh, over HTTP then over the lead-only tools.
      let refresh = await refreshOverHttp(ctx, {});
      expect(refresh.httpStatus === 200, `Unforced refresh answered ${refresh.httpStatus}`);
      expectRefreshShape(refresh.json, "unforced refresh");
      response = await ctx.api("POST", "/api/models-catalog/refresh", {
        body: { force: "yes" },
      });
      expectStatus(response, [400], "reject a non-boolean force");
      refresh = await refreshOverHttp(ctx, { force: true }, workerId);
      expect(refresh.httpStatus === 403, `Worker refresh answered ${refresh.httpStatus}`);
      const forced = await refreshOverHttp(ctx, { force: true });
      expect(forced.httpStatus === 200, `Forced refresh answered ${forced.httpStatus}`);
      const forcedResult = expectRefreshShape(forced.json, "forced refresh");
      expect(forcedResult.status !== "skipped-fresh", "A forced refresh reported skipped-fresh");
      ctx.log(`platformb-models: forced catalog refresh answered ${forcedResult.status}`);

      workerConn = await ctx.connectMcp(workerId);
      leadConn = await ctx.connectMcp(leadId);
      const listedProfiles = expectToolOk(
        await callTool(workerConn, "list-model-profiles", { harness: "codex" }),
        "list-model-profiles",
      );
      const toolProfiles = asRecords(listedProfiles.data, "profiles");
      expect(
        toolProfiles.length === codexProfiles.length &&
          toolProfiles.every((entry) => entry.harness === "codex") &&
          toolProfiles.some((entry) => entry.name === "codex-regular"),
        "list-model-profiles disagrees with GET /api/model-profiles?harness=codex",
      );
      expectToolError(
        await callTool(workerConn, "model-catalog-refresh", {}),
        "requires the lead agent",
        "worker model-catalog-refresh",
      );
      // A second forced refresh inside the one-minute window is a cooldown, whatever the first said.
      const second = await callTool(leadConn, "model-catalog-refresh", { force: true });
      if (forcedResult.status !== "skipped-cooldown") {
        expectToolOk(second, "forced model-catalog-refresh inside the cooldown");
        expect(
          second.data.status === "skipped-cooldown" &&
            typeof second.data.retryAfterMs === "number" &&
            second.data.retryAfterMs > 0,
          `Tool refresh inside the cooldown is ${JSON.stringify(second.data)}`,
        );
      }
      const unforced = await callTool(leadConn, "model-catalog-refresh", {});
      if (unforced.isError) {
        // The only failure is a refresh that needed the network and could not reach it.
        expectToolError(unforced, "Model catalog refresh failed", "unforced model-catalog-refresh");
        expect(unforced.data.status === "error", "A failed refresh carries no error status");
      } else {
        expectToolOk(unforced, "unforced model-catalog-refresh");
        expect(
          REFRESH_STATUSES.includes(String(unforced.data.status)) &&
            typeof unforced.data.models === "number" &&
            Array.isArray(unforced.data.added),
          `Tool refresh result is ${JSON.stringify(unforced.data)}`,
        );
        expect(unforced.text.includes(`status=${String(unforced.data.status)}`), "No status text");
      }

      // model-catalog-overlay-upsert
      const toolModel = `e2e-tool-overlay-${ctx.nonce}`;
      overlays.push({ provider: "openai", modelId: toolModel });
      const toolArgs = {
        provider: "openai",
        modelId: toolModel,
        name: "Tool Overlay",
        contextWindow: 2000,
        pricing: { input: 1, output: 2 },
        reason: "e2e tool overlay",
        verifiedBy: "e2e",
      };
      expectToolError(
        await callTool(workerConn, "model-catalog-overlay-upsert", toolArgs),
        "requires the lead agent",
        "worker model-catalog-overlay-upsert",
      );
      expect(
        ctx.db.get("SELECT 1 FROM model_catalog_overlay WHERE modelId = ?", [toolModel]) === null,
        "A refused overlay upsert still wrote a row",
      );
      const upserted = expectToolOk(
        await callTool(leadConn, "model-catalog-overlay-upsert", toolArgs),
        "lead model-catalog-overlay-upsert",
      );
      const toolOverlay = asRecord(upserted.data.overlay);
      expect(
        toolOverlay.modelId === toolModel &&
          toolOverlay.contextWindow === 2000 &&
          toolOverlay.expiresWhenUpstreamMatches === true,
        `Tool overlay is ${JSON.stringify(toolOverlay)}`,
      );
      expect(
        ctx.db.get<{ reason: string }>(
          "SELECT reason FROM model_catalog_overlay WHERE modelId = ?",
          [toolModel],
        )?.reason === "e2e tool overlay",
        "Tool overlay is not in model_catalog_overlay",
      );
      expect(
        (await callTool(leadConn, "model-catalog-overlay-upsert", { provider: "openai" })).isError,
        "model-catalog-overlay-upsert accepted a call with no model or reason",
      );
      expectStatus(
        await ctx.api("DELETE", "/api/models-catalog/overlay", {
          body: { provider: "openai", modelId: toolModel },
        }),
        [200],
        "delete the tool overlay",
      );
      overlays.length = 0;

      // ===== pricing =====
      response = await ctx.api("GET", "/api/pricing");
      expectStatus(response, [200], "list pricing");
      const allRows = asRecords(response.json, "rows");
      const seedRow = allRows.find(
        (row) =>
          row.effectiveFrom === 0 && row.provider === "claude" && !String(row.model).includes("/"),
      );
      expect(seedRow, "The price book has no seeded claude row");
      const seedPath = `/api/pricing/${seedRow.provider}/${seedRow.model}/${seedRow.tokenClass}`;
      response = await ctx.api("GET", seedPath);
      expectStatus(response, [200], "list a seeded triple");
      expect(
        asRecords(response.json, "rows").some(
          (row) => row.effectiveFrom === 0 && row.pricePerMillionUsd === seedRow.pricePerMillionUsd,
        ),
        "The seeded row is missing from its triple history",
      );
      expectStatus(await ctx.api("GET", `${seedPath}/active`), [200], "active seeded price");

      const model = `e2e-price-${ctx.nonce}`;
      const base = `/api/pricing/claude/${model}/input`;
      const past = 1000;
      response = await ctx.api("POST", base, {
        body: { pricePerMillionUsd: 1.5, effectiveFrom: past },
      });
      expectStatus(response, [201], "insert a price row");
      priceRows.push({ provider: "claude", model, tokenClass: "input", from: past });
      const priced = asRecord(response.json);
      expect(
        priced.provider === "claude" &&
          priced.model === model &&
          priced.tokenClass === "input" &&
          priced.effectiveFrom === past &&
          priced.pricePerMillionUsd === 1.5 &&
          typeof priced.createdAt === "number",
        `Price row is ${JSON.stringify(priced)}`,
      );
      expect(
        ctx.db.get<{ price: number }>(
          "SELECT price_per_million_usd AS price FROM pricing WHERE provider = 'claude' AND model = ? AND token_class = 'input' AND effective_from = ?",
          [model, past],
        )?.price === 1.5,
        "The price row is not in the pricing table",
      );
      response = await ctx.api("POST", base, {
        body: { pricePerMillionUsd: 9, effectiveFrom: past },
      });
      expectStatus(response, [409], "insert a duplicate price row");
      // No effectiveFrom means now: the newest row wins.
      response = await ctx.api("POST", base, { body: { pricePerMillionUsd: 3.5 } });
      expectStatus(response, [201], "insert a price row effective now");
      const nowRow = asRecord(response.json);
      const nowFrom = Number(nowRow.effectiveFrom);
      expect(nowFrom > past, "A row with no effectiveFrom was not stamped with the time");
      priceRows.push({ provider: "claude", model, tokenClass: "input", from: nowFrom });
      // A row dated in the future is stored but not active yet.
      const future = Date.now() + 3_600_000;
      response = await ctx.api("POST", base, {
        body: { pricePerMillionUsd: 7, effectiveFrom: future },
      });
      expectStatus(response, [201], "insert a future price row");
      priceRows.push({ provider: "claude", model, tokenClass: "input", from: future });
      for (const [label, path, body] of [
        ["negative price", base, { pricePerMillionUsd: -1 }],
        ["unknown provider", `/api/pricing/nope/${model}/input`, { pricePerMillionUsd: 1 }],
        ["unknown token class", `/api/pricing/claude/${model}/bogus`, { pricePerMillionUsd: 1 }],
        ["missing price", base, {}],
      ] as const) {
        expectStatus(await ctx.api("POST", path, { body }), [400], `reject ${label}`);
      }

      response = await ctx.api("GET", base);
      expectStatus(response, [200], "list a price history");
      const history = asRecords(response.json, "rows");
      expect(
        history.map((row) => row.effectiveFrom).join(",") === [future, nowFrom, past].join(","),
        `Price history order is ${history.map((row) => row.effectiveFrom).join(",")}`,
      );
      response = await ctx.api("GET", `${base}/active`);
      expectStatus(response, [200], "read the active price");
      expect(
        asRecord(response.json).effectiveFrom === nowFrom &&
          asRecord(response.json).pricePerMillionUsd === 3.5,
        `Active price is ${JSON.stringify(response.json)}`,
      );
      expectStatus(
        await ctx.api("GET", `/api/pricing/claude/e2e-no-price-${ctx.nonce}/input/active`),
        [404],
        "active price of an unpriced model",
      );
      expectStatus(
        await ctx.api("GET", `/api/pricing/nope/${model}/input/active`),
        [400],
        "active price of an unknown provider",
      );
      // Every insert is audited.
      const audit = ctx.db.query<{ metadata: string }>(
        "SELECT metadata FROM agent_log WHERE eventType = 'pricing.inserted' AND metadata LIKE ?",
        [`%${model}%`],
      );
      expect(
        audit.length === 3 && JSON.parse(audit[0]?.metadata ?? "{}").model === model,
        `Expected 3 pricing.inserted audit rows for ${model}, found ${audit.length}`,
      );

      // Delete is the typo correction; the next-newest row becomes active again.
      for (const from of [future, nowFrom]) {
        expectStatus(await ctx.api("DELETE", `${base}/${from}`), [204], `delete price row ${from}`);
      }
      response = await ctx.api("GET", `${base}/active`);
      expect(
        asRecord(response.json).effectiveFrom === past &&
          asRecord(response.json).pricePerMillionUsd === 1.5,
        "Deleting the newer rows did not expose the older price",
      );
      expectStatus(await ctx.api("DELETE", `${base}/${future}`), [404], "delete a price row twice");
      expectStatus(
        await ctx.api("DELETE", `${base}/abc`),
        [400],
        "delete with a bad effectiveFrom",
      );
      expectStatus(await ctx.api("DELETE", `${base}/${past}`), [204], "delete the last price row");
      expectStatus(await ctx.api("GET", `${base}/active`), [404], "no price after the deletes");
      const deletedAudit = ctx.db.query<{ metadata: string }>(
        "SELECT metadata FROM agent_log WHERE eventType = 'pricing.deleted' AND metadata LIKE ?",
        [`%${model}%`],
      );
      expect(deletedAudit.length === 3, `Expected 3 pricing.deleted audit rows`);
      priceRows.length = 0;
    });
  },
};
