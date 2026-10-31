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

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const ACTIVATION_DENIED = "requires operator/user authentication, or a lead";

async function extensionRow(ctx: ScenarioContext, id: string): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", `/api/extensions/${id}`);
  expectStatus(response, [200], `read extension ${id}`);
  return asRecord(asRecord(response.json).extension);
}

/**
 * The extension routes and tools the `extensions` scenario leaves out: authoring type definitions,
 * the version list, the run log, and the lead-gated enable, disable, activate-version and delete
 * tools (worker refusals included). Installs only catalog templates and removes what it installs.
 */
export const platformbExtensions: Scenario = {
  name: "platformb-extensions",
  order: 665,
  async run(ctx) {
    const cleanup = new Cleanup();
    const extensionIds: string[] = [];
    const taskIds: string[] = [];
    let leadId: string | undefined;
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
    cleanup.add("uninstall extensions", async () => {
      for (const id of extensionIds) {
        const current = await ctx.api("GET", `/api/extensions/${id}`);
        if (current.status !== 200) continue;
        await ctx.api("POST", `/api/extensions/${id}/disable`);
        await ctx.api("DELETE", `/api/extensions/${id}`);
      }
    });

    await cleanup.around(async () => {
      const workerId = await registerWorker(ctx, `e2e-platformb-ext-worker-${ctx.nonce}`);
      leadId = await registerLead(ctx, `e2e-platformb-ext-lead-${ctx.nonce}`);
      workerConn = await ctx.connectMcp(workerId);
      leadConn = await ctx.connectMcp(leadId);

      // --- type definitions: plain TypeScript text, key protected.
      let response = await ctx.api("GET", "/api/extensions/type-defs");
      expectStatus(response, [200], "read extension type definitions");
      expect(
        (response.headers.get("content-type") ?? "").startsWith("text/plain"),
        `type-defs content type is ${response.headers.get("content-type")}`,
      );
      expect(
        response.text.includes('declare module "swarm-extension"') &&
          response.text.includes("CreateTaskOptions"),
        "type-defs does not declare the swarm-extension module",
      );
      expectStatus(
        await ctx.api("GET", "/api/extensions/type-defs", { apiKey: null }),
        [401],
        "type-defs without a key",
      );

      // --- an installed draft has one version and an empty run log.
      response = await ctx.api("POST", "/api/extensions/install", {
        body: { template: "require-ticket-ref", config: { origins: ["rest"] } },
      });
      expectStatus(response, [200], "install require-ticket-ref");
      const installed = asRecord(response.json);
      const extension = asRecord(installed.extension);
      const extensionId = asString(extension.id, "extension id");
      extensionIds.push(extensionId);
      expect(
        extension.enabled === false && extension.version === 1 && extension.status === "disabled",
        "A fresh install is not a disabled version 1",
      );

      response = await ctx.api("GET", `/api/extensions/${extensionId}/versions`);
      expectStatus(response, [200], "list extension versions");
      const versions = asRecords(response.json, "versions");
      expect(versions.length === 1, `A fresh install has ${versions.length} versions`);
      const [first] = versions;
      expect(
        first?.extensionId === extensionId &&
          first.version === 1 &&
          first.contentHash === extension.contentHash &&
          typeof first.changedAt === "string",
        `Version 1 is ${JSON.stringify(first)}`,
      );
      expect(
        JSON.parse(String(first?.manifestJson)).name === "require-ticket-ref" &&
          typeof JSON.parse(String(first?.filesJson))["hooks.ts"] === "string",
        "Version 1 does not carry the template manifest and hooks.ts",
      );
      expect(
        ctx.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM extension_versions WHERE extensionId = ?",
          [extensionId],
        )?.n === 1,
        "extension_versions does not hold exactly one version",
      );
      response = await ctx.api("GET", `/api/extensions/${extensionId}/runs`);
      expectStatus(response, [200], "list runs of a fresh extension");
      expect(asRecords(response.json, "runs").length === 0, "A fresh extension has run entries");
      for (const suffix of ["versions", "runs"]) {
        expectStatus(
          await ctx.api("GET", `/api/extensions/${MISSING_ID}/${suffix}`),
          [404],
          `${suffix} of a missing extension`,
        );
      }
      expectStatus(
        await ctx.api("GET", `/api/extensions/${extensionId}/runs?limit=0`),
        [400],
        "runs with limit 0",
      );
      expectStatus(
        await ctx.api("GET", `/api/extensions/${extensionId}/runs?limit=501`),
        [400],
        "runs with limit 501",
      );

      // --- a worker can read but not activate, deactivate or remove someone else's extension.
      expectToolError(
        await callTool(workerConn, "extension-enable", { id: extensionId }),
        ACTIVATION_DENIED,
        "worker extension-enable",
      );
      expectToolError(
        await callTool(workerConn, "extension-disable", { id: extensionId }),
        ACTIVATION_DENIED,
        "worker extension-disable",
      );
      expectToolError(
        await callTool(workerConn, "extension-activate-version", { id: extensionId, version: 1 }),
        ACTIVATION_DENIED,
        "worker extension-activate-version",
      );
      expectToolError(
        await callTool(workerConn, "extension-delete", { id: extensionId }),
        "requires extension owner, lead agent, operator, or user",
        "worker extension-delete of an extension it does not own",
      );
      expect((await extensionRow(ctx, extensionId)).enabled === false, "A refused call enabled it");

      // --- the lead enables it, and the hook blocks a task with no ticket reference.
      let outcome = expectToolOk(
        await callTool(leadConn, "extension-enable", { id: extensionId }),
        "lead extension-enable",
      );
      expect(
        outcome.data.id === extensionId &&
          outcome.data.enabled === true &&
          outcome.data.status === "enabled" &&
          outcome.data.name === "require-ticket-ref",
        `extension-enable returned ${JSON.stringify(outcome.data)}`,
      );
      expect(
        ctx.db.get<{ enabled: number }>("SELECT enabled FROM extensions WHERE id = ?", [
          extensionId,
        ])?.enabled === 1,
        "extension-enable did not set extensions.enabled",
      );
      response = await ctx.api("POST", "/api/tasks", {
        body: { task: `no ticket here ${ctx.nonce}` },
      });
      expectStatus(response, [422], "the enabled extension blocks a task with no ticket");
      expect(
        asRecord(asRecord(response.json).extension).id === extensionId,
        "The block response does not name the extension",
      );
      response = await ctx.api("GET", `/api/extensions/${extensionId}/runs`);
      expectStatus(response, [200], "list runs after a block");
      const runs = asRecords(response.json, "runs");
      const block = runs.find((run) => run.action === "block");
      expect(block, "The run log has no block entry");
      expect(
        block.extensionId === extensionId &&
          block.event === "pre.task.create" &&
          block.version === 1 &&
          typeof block.durationMs === "number" &&
          String(block.message).includes("Task must reference a ticket") &&
          String(block.subject).includes("no ticket here"),
        `Block run is ${JSON.stringify(block)}`,
      );
      response = await ctx.api("GET", `/api/extensions/${extensionId}/runs?limit=1`);
      expectStatus(response, [200], "list runs with a limit");
      expect(asRecords(response.json, "runs").length === 1, "limit=1 did not cap the run log");

      // --- activate-version: a stored version, a missing one, and the enabled flag stays on.
      outcome = expectToolOk(
        await callTool(leadConn, "extension-activate-version", { id: extensionId, version: 1 }),
        "lead extension-activate-version",
      );
      expect(
        outcome.data.activeVersion === 1 && outcome.data.enabled === true,
        `extension-activate-version returned ${JSON.stringify(outcome.data)}`,
      );
      expectToolError(
        await callTool(leadConn, "extension-activate-version", { id: extensionId, version: 9 }),
        "version 9 was not found",
        "activate a version that does not exist",
      );
      expect(
        (await callTool(leadConn, "extension-activate-version", { id: extensionId, version: 0 }))
          .isError,
        "extension-activate-version accepted version 0",
      );

      // --- delete needs a disabled extension; disable unloads the hook.
      expectToolError(
        await callTool(leadConn, "extension-delete", { id: extensionId }),
        "Disable the extension before uninstalling it",
        "delete an enabled extension",
      );
      outcome = expectToolOk(
        await callTool(leadConn, "extension-disable", { id: extensionId }),
        "lead extension-disable",
      );
      expect(
        outcome.data.enabled === false && outcome.data.status === "disabled",
        `extension-disable returned ${JSON.stringify(outcome.data)}`,
      );
      response = await ctx.api("POST", "/api/tasks", {
        body: { task: `no ticket after disable ${ctx.nonce}`, source: "api" },
      });
      expectStatus(response, [201], "a disabled extension no longer blocks the task");
      taskIds.push(asString(asRecord(response.json).id, "unblocked task id"));

      outcome = expectToolOk(
        await callTool(leadConn, "extension-delete", { id: extensionId }),
        "lead extension-delete",
      );
      expect(
        outcome.data.id === extensionId && outcome.data.deleted === true,
        `extension-delete returned ${JSON.stringify(outcome.data)}`,
      );
      expectStatus(
        await ctx.api("GET", `/api/extensions/${extensionId}`),
        [404],
        "read the deleted extension",
      );
      for (const table of ["extensions", "extension_versions", "extension_runs"]) {
        const column = table === "extensions" ? "id" : "extensionId";
        expect(
          Number(
            ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [
              extensionId,
            ])?.n,
          ) === 0,
          `Deleting the extension left rows in ${table}`,
        );
      }

      // --- a missing extension is the same error for every tool; a bad id never reaches the API.
      for (const [tool, args] of [
        ["extension-enable", { id: MISSING_ID }],
        ["extension-disable", { id: MISSING_ID }],
        ["extension-activate-version", { id: MISSING_ID, version: 1 }],
        ["extension-delete", { id: MISSING_ID }],
      ] as const) {
        expectToolError(
          await callTool(leadConn, tool, args),
          "Extension not found",
          `${tool} of a missing extension`,
        );
        expect(
          (await callTool(leadConn, tool, { ...args, id: "not-a-uuid" })).isError,
          `${tool} accepted an id that is not a UUID`,
        );
      }

      // --- a worker owns the drafts it installs: it can remove its own, not activate it.
      outcome = expectToolOk(
        await callTool(workerConn, "extension-install", { template: "task-digest" }),
        "worker extension-install",
      );
      const ownId = asString(outcome.data.id, "worker extension id");
      extensionIds.push(ownId);
      expect(outcome.data.createdByAgentId === workerId, "The draft is not owned by the worker");
      expectToolError(
        await callTool(workerConn, "extension-enable", { id: ownId }),
        ACTIVATION_DENIED,
        "worker enables its own draft",
      );
      outcome = expectToolOk(
        await callTool(workerConn, "extension-delete", { id: ownId }),
        "worker deletes its own draft",
      );
      expect(outcome.data.deleted === true, "Own-draft delete did not report deleted");
      expectStatus(
        await ctx.api("GET", `/api/extensions/${ownId}`),
        [404],
        "read the deleted worker draft",
      );
    });
  },
};
