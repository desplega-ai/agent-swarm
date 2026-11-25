import { sql } from "../db";
// WORKFLOW_INPUT_ENV_ALLOWLIST limits which API env vars a workflow input may read with ${NAME}.
// Set: a name outside the list fails the run before any node runs, and the value reaches no step row, run row or log;
// a listed name still resolves. A webhook hmacSecret outside the list answers 500 and starts no run.
// The key is human-only: the shared key and a lead get refused, and a user token must send a valid
// name list. An explicitly empty or blank list denies all env refs; unset keeps legacy behavior.
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { createUser, expectToolError, registerLead, withMcp } from "./core-helpers";
import { expectRunStatus, triggerWorkflow, type WorkflowNodeDef } from "./workflow-helpers";

const reverse = (s: string) => s.split("").reverse().join("");

export const authzWorkflowEnv: Scenario = {
  name: "authz-workflow-env",
  order: 362,
  async run(ctx) {
    const allowedName = `E2E_WFENV_ALLOWED_${ctx.nonce.toUpperCase()}`;
    const deniedName = `E2E_WFENV_DENIED_${ctx.nonce.toUpperCase()}`;
    const allowedValue = `allowedval${ctx.nonce}`;
    const deniedValue = `deniedval${ctx.nonce}`;
    const emptyControl = `E2E_WFENV_EMPTY_${ctx.nonce.toUpperCase()}`;
    const vars = { [allowedName]: allowedValue, [deniedName]: deniedValue, [emptyControl]: "" };
    const workflowIds: string[] = [];
    const key = "WORKFLOW_INPUT_ENV_ALLOWLIST";
    let configOverride: { id: string; apiKey: string } | undefined;

    const scriptNode: WorkflowNodeDef = {
      id: "s",
      type: "script",
      config: { runtime: "bash", script: 'printf %s "$B" | rev', env: { B: "{{input.b}}" } },
    };
    const makeWorkflow = async (label: string, envName: string): Promise<string> => {
      const created = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `authz-env-${label}-${ctx.nonce}`,
          definition: { nodes: [scriptNode] },
          input: { b: `\${${envName}}` },
        },
      });
      expectStatus(created, [201], `operator creates the ${label} workflow`);
      const id = asString(asRecord(created.json).id, "workflow id");
      workflowIds.push(id);
      return id;
    };
    const runOf = async (workflowId: string) => (await triggerWorkflow(ctx, workflowId, {})).runId;
    const dump = async (runId: string): Promise<string> => {
      const detail = await ctx.api("GET", `/api/workflow-runs/${runId}`);
      expectStatus(detail, [200], "read the run");
      return JSON.stringify(detail.json);
    };
    const expectDenied = async (workflowId: string, label: string) => {
      const runId = await runOf(workflowId);
      const detail = await expectRunStatus(ctx, runId, "failed");
      const text = await dump(runId);
      expect(
        text.includes(key) && text.includes(allowedName),
        `${label}: expected allowlist denial`,
      );
      expect(detail.steps.length === 0, `${label}: the denied run started a node`);
    };
    const reloadConfigs = async () => {
      const reloaded = await ctx.api("POST", "/api/config/reload");
      expectStatus(reloaded, [200], "reload the effective global config");
    };
    const expectEnvPresence = async (present: boolean, label: string) => {
      const response = await ctx.api("GET", `/api/config/env-presence?keys=${key},${emptyControl}`);
      expectStatus(response, [200], label);
      const presence = asRecord(asRecord(response.json).presence);
      expect(presence[key] === present, `${label}: expected allowlist presence to be ${present}`);
      expect(presence[emptyControl] === false, `${label}: unrelated empty keys stay absent`);
    };

    try {
      // ── Allowlist set: one name listed ──────────────────────────────────────────────────
      await ctx.restartSut({
        env: { ...vars, WORKFLOW_INPUT_ENV_ALLOWLIST: ` ${allowedName} , ` },
      });
      const allowedFlow = await makeWorkflow("allowed", allowedName);
      const deniedFlow = await makeWorkflow("denied", deniedName);

      const okRun = await runOf(allowedFlow);
      const okDetail = await expectRunStatus(ctx, okRun, "completed");
      expect(
        JSON.stringify(okDetail.steps).includes(reverse(allowedValue)),
        "a listed env var did not reach the script node",
      );

      const logBefore = (await ctx.sutLog()).length;
      const badRun = await runOf(deniedFlow);
      const badDetail = await expectRunStatus(ctx, badRun, "failed");
      const badText = await dump(badRun);
      expect(
        badText.includes("WORKFLOW_INPUT_ENV_ALLOWLIST") && badText.includes(deniedName),
        `the failed run does not name the allowlist and the variable: ${badText.slice(0, 300)}`,
      );
      expect(
        !badText.includes(deniedValue) && !badText.includes(reverse(deniedValue)),
        "the value of an unlisted env var reached the run or its steps",
      );
      expect(badDetail.steps.length === 0, "the denied run started a node");
      const logAfter = await ctx.sutLog();
      expect(
        !logAfter.slice(logBefore).includes(deniedValue),
        "the value of an unlisted env var reached the API log",
      );

      // ── Webhook hmacSecret outside the list: 500, no run, no value ──────────────────────
      const hook = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `authz-env-hook-${ctx.nonce}`,
          definition: { nodes: [scriptNode] },
          triggers: [{ type: "webhook", hmacSecret: `\${${deniedName}}` }],
        },
      });
      expectStatus(hook, [201], "operator creates the webhook workflow");
      const hookId = asString(asRecord(hook.json).id, "webhook workflow id");
      workflowIds.push(hookId);
      const runsBefore = ctx.db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM workflow_runs WHERE "workflowId" = ${hookId}`,
      )?.n;
      const hookLogBefore = (await ctx.sutLog()).length;
      const hookBody = JSON.stringify({ event: "ping" });
      const delivery = await ctx.api("POST", `/api/webhooks/${hookId}`, {
        apiKey: null,
        rawBody: hookBody,
        headers: { "X-Hub-Signature-256": "sha256=deadbeef", "Content-Type": "application/json" },
      });
      expectStatus(delivery, [500], "webhook whose hmacSecret is outside the allowlist");
      const deliveryText = JSON.stringify(delivery.json);
      expect(
        deliveryText.includes("WORKFLOW_INPUT_ENV_ALLOWLIST") &&
          !deliveryText.includes(deniedValue),
        `the webhook error must name the allowlist and not leak the value: ${deliveryText.slice(0, 300)}`,
      );
      const runsAfter = ctx.db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM workflow_runs WHERE "workflowId" = ${hookId}`,
      )?.n;
      expect(
        runsBefore === 0 && runsAfter === 0,
        `the rejected delivery started a run (${runsAfter})`,
      );
      expect(
        !(await ctx.sutLog()).slice(hookLogBefore).includes(deniedValue),
        "the value of an unlisted env var reached the API log through the webhook",
      );

      // ── The key is human-only, and its value is validated ───────────────────────────────
      const operatorWrite = await ctx.api("PUT", "/api/config", {
        body: { scope: "global", key: "WORKFLOW_INPUT_ENV_ALLOWLIST", value: deniedName },
      });
      expectStatus(operatorWrite, [403], "shared key writes WORKFLOW_INPUT_ENV_ALLOWLIST");
      const userRequirement = "requires a user token or dashboard user session";
      expect(
        operatorWrite.text.includes(userRequirement) &&
          operatorWrite.text.includes("With RBAC enabled, the user must be an admin"),
        "the refusal must explain the user requirement and when admin access is required",
      );
      const lead = await registerLead(ctx, "wfenv");
      await withMcp(ctx, lead, (conn) =>
        expectToolError(
          conn,
          "set-config",
          { scope: "global", key: "WORKFLOW_INPUT_ENV_ALLOWLIST", value: deniedName },
          userRequirement,
        ),
      );
      const admin = await createUser(ctx, "wfenv-admin");
      const minted = await ctx.api("POST", `/api/users/${admin}/mcp-tokens`, {
        body: { label: `e2e ${ctx.nonce}` },
      });
      expectStatus(minted, [200], "mint an admin user token");
      const adminToken = String(asRecord(minted.json).plaintext);
      const invalid = await ctx.api("PUT", "/api/config", {
        apiKey: adminToken,
        body: { scope: "global", key: "WORKFLOW_INPUT_ENV_ALLOWLIST", value: "GOOD_NAME,bad-name" },
      });
      expectStatus(invalid, [400], "admin writes an invalid name list");
      expect(
        JSON.stringify(invalid.json).includes("bad-name"),
        `the validation error does not name the bad entry: ${JSON.stringify(invalid.json).slice(0, 300)}`,
      );
      const stored = await ctx.api("GET", `/api/config?scope=global&key=${key}`);
      expectStatus(stored, [200], "read globals after denied config writes");
      expect(
        asRecords(stored.json, "configs").length === 0,
        "a refused write left an allowlist config row",
      );

      // An empty config row overrides a deployment list that had allowed this reference.
      for (const value of ["", "  "]) {
        const updated = await ctx.api("PUT", "/api/config", {
          apiKey: adminToken,
          body: { scope: "global", key, value },
        });
        expectStatus(updated, [200], "store a list with no allowed names");
        const row = asRecord(updated.json);
        configOverride = { id: asString(row.id, "config id"), apiKey: adminToken };
        expect(row.value === value, "the config response did not preserve the explicit value");
        await reloadConfigs();
        await expectDenied(allowedFlow, "empty or whitespace-only stored list");
        await expectEnvPresence(true, "stored allowlist after reload");
      }
      const removed = await ctx.api("DELETE", `/api/config/${configOverride!.id}`, {
        apiKey: adminToken,
      });
      expectStatus(removed, [200], "remove the allowlist override");
      configOverride = undefined;
      await reloadConfigs();
      const restored = await expectRunStatus(ctx, await runOf(allowedFlow), "completed");
      expect(
        JSON.stringify(restored.steps).includes(reverse(allowedValue)),
        "removing the config override must restore the deployment list",
      );

      for (const value of ["", "  ", " , "]) {
        await ctx.restartSut({ env: { ...vars, [key]: value } });
        await expectEnvPresence(true, "explicit deployment list with no names");
        await expectDenied(allowedFlow, "explicit deployment list with no names");
      }

      // ── Unset: no restriction ───────────────────────────────────────────────────────────
      await ctx.restartSut({ env: vars });
      await expectEnvPresence(false, "unset allowlist");
      const unsetDetail = await expectRunStatus(ctx, await runOf(deniedFlow), "completed");
      expect(
        JSON.stringify(unsetDetail.steps).includes(reverse(deniedValue)),
        "an unset allowlist must not restrict env refs",
      );
    } finally {
      if (configOverride) {
        await ctx.api("DELETE", `/api/config/${configOverride.id}`, {
          apiKey: configOverride.apiKey,
        });
      }
      for (const id of workflowIds) await ctx.api("DELETE", `/api/workflows/${id}`);
      // The next restart drops the variables above.
      await ctx.restartSut();
    }
  },
};
