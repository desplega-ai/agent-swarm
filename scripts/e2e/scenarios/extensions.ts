import { asRecord, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import { ask, registerLead, registerWorker } from "./slack-helpers";

/**
 * Install accepts only names from the predefined catalog. The SUT serves the bundled
 * catalog (templates/extensions/), so this scenario installs real templates by name.
 */
async function install(
  ctx: ScenarioContext,
  template: string,
  config?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await ctx.api("POST", "/api/extensions/install", {
    body: { template, ...(config ? { config } : {}) },
  });
  expectStatus(response, [200], `install ${template}`);
  return asRecord(response.json);
}

async function enable(ctx: ScenarioContext, id: string): Promise<Record<string, unknown>> {
  const response = await ctx.api("POST", `/api/extensions/${id}/enable`);
  expectStatus(response, [200], `enable extension ${id}`);
  return asRecord(asRecord(response.json).extension);
}

async function disable(ctx: ScenarioContext, id: string): Promise<void> {
  expectStatus(
    await ctx.api("POST", `/api/extensions/${id}/disable`),
    [200],
    `disable extension ${id}`,
  );
}

async function cleanupExtensions(ctx: ScenarioContext, ids: Set<string>): Promise<void> {
  for (const id of [...ids].reverse()) {
    const current = await ctx.api("GET", `/api/extensions/${id}`);
    if (current.status === 404) continue;
    expectStatus(current, [200], `read extension ${id} during cleanup`);
    if (asRecord(asRecord(current.json).extension).enabled === true) await disable(ctx, id);
    const deleted = await ctx.api("DELETE", `/api/extensions/${id}`);
    expectStatus(deleted, [200], `uninstall extension ${id}`);
    const assets = asRecord(asRecord(deleted.json).assets);
    expect(
      Array.isArray(assets.deleted) && Array.isArray(assets.detached),
      `uninstall of extension ${id} did not report its assets`,
    );
  }
}

function catalogItems(value: unknown): Record<string, unknown>[] {
  const items = asRecord(value).extensions;
  expect(Array.isArray(items), "Extension catalog has no extensions array");
  return items.map(asRecord);
}

function extensionId(extension: Record<string, unknown>, label: string): string {
  const id = extension.id;
  expect(typeof id === "string", `${label} has no extension id`);
  return id;
}

export const extensions: Scenario = {
  name: "extensions",
  order: 170,
  async run(ctx) {
    const installedIds = new Set<string>();
    let leadConnection: McpConnection | undefined;
    let workerConnection: McpConnection | undefined;

    try {
      const leadId = await registerLead(ctx, `e2e-extension-lead-${ctx.nonce}`);
      leadConnection = await ctx.connectMcp(leadId);
      await leadConnection.listTools();

      const listed = asRecord(await leadConnection.callTool("extension-list", {}));
      expect(listed.isError !== true, "extension-list returned isError");

      const catalogTool = asRecord(await leadConnection.callTool("extension-catalog", {}));
      expect(catalogTool.isError !== true, "extension-catalog returned isError");
      const catalogNames = catalogItems(catalogTool.structuredContent).map((item) => item.name);
      for (const template of [
        "require-ticket-ref",
        "require-verification-note",
        "notify-on-complete",
      ]) {
        expect(catalogNames.includes(template), `extension-catalog does not list ${template}`);
      }

      // Inline bundles and names outside the catalog are refused before anything is stored.
      const inline = await ctx.api("POST", "/api/extensions/install", {
        body: {
          manifest: {
            name: "e2e-inline",
            description: "Inline bundle",
            version: "1.0.0",
            runtime: "api",
            assets: { hooks: "hooks.ts" },
          },
          files: { "hooks.ts": "export default () => {};" },
        },
      });
      expectStatus(inline, [400], "reject inline extension bundle");
      expect(
        asRecord(inline.json).error === "inline_install_disabled",
        "Inline install was not rejected as inline_install_disabled",
      );
      const unknown = await ctx.api("POST", "/api/extensions/install", {
        body: { template: `e2e-missing-${ctx.nonce}` },
      });
      expectStatus(unknown, [404], "reject unknown extension template");

      const drafted = asRecord(
        await leadConnection.callTool("extension-install", {
          template: "require-verification-note",
        }),
      );
      expect(drafted.isError !== true, "extension-install returned isError");
      const catalog = await ctx.api("GET", "/api/extensions/catalog");
      expectStatus(catalog, [200], "read extension catalog after MCP install");
      const verificationEntry = catalogItems(catalog.json).find(
        (item) => item.name === "require-verification-note",
      );
      expect(verificationEntry, "Catalog does not list require-verification-note");
      const verificationInstalled = asRecord(verificationEntry.installed);
      expect(
        verificationInstalled.version === 1 && verificationInstalled.enabled === false,
        "Catalog does not show the MCP install as a disabled version 1",
      );
      const verificationId = extensionId(verificationInstalled, "require-verification-note");
      installedIds.add(verificationId);
      const extensionList = await ctx.api("GET", "/api/extensions");
      expectStatus(extensionList, [200], "list extensions after MCP install");
      const extensionRows = asRecord(extensionList.json).extensions;
      expect(Array.isArray(extensionRows), "Extension list has no extensions array");
      const verificationRow = extensionRows
        .map(asRecord)
        .find((extension) => extension.id === verificationId);
      expect(verificationRow, "MCP install did not store require-verification-note");
      expect(
        verificationRow.enabled === false && verificationRow.status === "disabled",
        "MCP install did not store a disabled draft",
      );

      const ticketInstall = await install(ctx, "require-ticket-ref", { origins: ["rest"] });
      const ticket = asRecord(ticketInstall.extension);
      const ticketId = extensionId(ticket, "require-ticket-ref");
      installedIds.add(ticketId);
      expect(ticket.version === 1, "First require-ticket-ref install is not version 1");
      await enable(ctx, ticketId);
      const blockedTask = await ctx.api("POST", "/api/tasks", {
        body: { task: `blocked extension task ${ctx.nonce}` },
      });
      expectStatus(blockedTask, [422], "block REST task without a ticket reference");
      expectStatus(
        await ctx.api("POST", "/api/tasks", {
          body: { task: `ENG-123 ticketed extension task ${ctx.nonce}` },
        }),
        [201],
        "allow REST task with a ticket reference",
      );

      // A blocked Slack-origin task must surface the extension's reason in the thread.
      expectStatus(
        await ctx.api("PATCH", `/api/extensions/${ticketId}`, {
          body: { config: { origins: ["slack"] } },
        }),
        [200],
        "point require-ticket-ref at the slack origin",
      );
      const blockedSlackMessage = await ask(ctx, `blocked slack task ${ctx.nonce}`);
      await ctx.slack.waitForMessage(
        (message) =>
          message.thread_ts === blockedSlackMessage.ts &&
          JSON.stringify(message).includes("Task must reference a ticket"),
        { timeoutMs: 30_000 },
      );
      await disable(ctx, ticketId);

      // Reinstalling an unchanged template dedupes instead of storing a new version.
      const reinstall = await install(ctx, "require-ticket-ref", { origins: ["slack"] });
      expect(reinstall.contentDeduped === true, "Unchanged template reinstall was not deduped");
      expect(
        asRecord(reinstall.extension).version === 1,
        "Unchanged template reinstall created a new version",
      );
      const activated = await ctx.api("POST", `/api/extensions/${ticketId}/activate-version`, {
        body: { version: 1 },
      });
      expectStatus(activated, [200], "activate require-ticket-ref version 1");
      expect(
        asRecord(asRecord(activated.json).extension).activeVersion === 1,
        "Activated require-ticket-ref version is not 1",
      );
      await disable(ctx, ticketId);

      const toolWorkerId = await registerWorker(ctx, `e2e-extension-tool-${ctx.nonce}`);
      const toolTask = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `extension tool task ${ctx.nonce}`,
          routingReason: "human_pinned",
          agentId: toolWorkerId,
          source: "api",
        },
      });
      expectStatus(toolTask, [201], "create extension tool task");
      const toolTaskId = asRecord(toolTask.json).id;
      expect(typeof toolTaskId === "string", "Extension tool task has no id");
      expectStatus(
        await ctx.api("GET", "/api/poll", { agentId: toolWorkerId }),
        [200],
        "claim extension tool task",
      );

      const notifyInstall = await install(ctx, "notify-on-complete", {
        channelId: "C0GENERAL0",
        includeFailed: false,
      });
      const notifyId = extensionId(asRecord(notifyInstall.extension), "notify-on-complete");
      installedIds.add(notifyId);
      await enable(ctx, notifyId);
      await enable(ctx, verificationId);
      workerConnection = await ctx.connectMcp(toolWorkerId);
      const unverified = asRecord(
        await workerConnection.callTool("store-progress", {
          taskId: toolTaskId,
          status: "completed",
          output: "done",
        }),
      );
      expect(
        unverified.isError === true,
        "require-verification-note did not reject an unverified completion",
      );
      const verified = asRecord(
        await workerConnection.callTool("store-progress", {
          taskId: toolTaskId,
          status: "completed",
          output: `Verified: e2e extension completion ${ctx.nonce}`,
        }),
      );
      expect(verified.isError !== true, "require-verification-note rejected a verified completion");
      // notify-on-complete posts through the extension's own SDK (ctx.swarm.slack_post).
      await ctx.slack.waitForMessage(
        (message) =>
          message.channel === "C0GENERAL0" &&
          JSON.stringify(message).includes(toolTaskId.slice(0, 8)) &&
          JSON.stringify(message).includes("completed"),
        { timeoutMs: 30_000 },
      );
      await disable(ctx, verificationId);
      await disable(ctx, notifyId);
    } finally {
      await workerConnection?.close();
      await leadConnection?.close();
      await cleanupExtensions(ctx, installedIds);
    }
  },
};
