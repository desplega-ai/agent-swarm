import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import { ask, registerLead, registerWorker } from "./slack-helpers";

type Bundle = {
  manifest: Record<string, unknown> & {
    name: string;
    assets: { hooks: string };
  };
  files: Record<string, string>;
};

async function loadBundle(name: string): Promise<Bundle> {
  const directory = new URL(`../../../src/tests/fixtures/extensions/${name}/`, import.meta.url);
  const manifest = (await Bun.file(
    new URL("manifest.json", directory),
  ).json()) as Bundle["manifest"];
  const hooks = await Bun.file(new URL(manifest.assets.hooks, directory)).text();
  return { manifest, files: { [manifest.assets.hooks]: hooks } };
}

async function install(
  ctx: ScenarioContext,
  bundle: Bundle,
  config?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await ctx.api("POST", "/api/extensions/install", {
    body: { ...bundle, ...(config ? { config } : {}) },
  });
  expectStatus(response, [200], `install ${bundle.manifest.name}`);
  return asRecord(asRecord(response.json).extension);
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
    expectStatus(
      await ctx.api("DELETE", `/api/extensions/${id}`),
      [200],
      `uninstall extension ${id}`,
    );
  }
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

      const minimal = await loadBundle("minimal");
      const drafted = asRecord(await leadConnection.callTool("extension-install", minimal));
      expect(drafted.isError !== true, "extension-install returned isError");
      const extensionList = await ctx.api("GET", "/api/extensions");
      expectStatus(extensionList, [200], "list extensions after MCP install");
      const extensionRows = asRecord(extensionList.json).extensions;
      expect(Array.isArray(extensionRows), "Extension list has no extensions array");
      const minimalRow = extensionRows
        .map(asRecord)
        .find((extension) => extension.name === minimal.manifest.name);
      expect(minimalRow, "MCP install did not store the minimal extension");
      expect(
        minimalRow.enabled === false && minimalRow.status === "disabled",
        "MCP install did not store a disabled draft",
      );
      installedIds.add(extensionId(minimalRow, "MCP-installed extension"));

      const blockerBundle = await loadBundle("block-tasks-from-source");
      const blocker = await install(ctx, blockerBundle, { source: "rest" });
      const blockerId = extensionId(blocker, "block-tasks-from-source");
      installedIds.add(blockerId);
      await enable(ctx, blockerId);
      const blockedTask = await ctx.api("POST", "/api/tasks", {
        body: { task: `blocked extension task ${ctx.nonce}` },
      });
      expectStatus(blockedTask, [422], "block REST task through extension");
      await disable(ctx, blockerId);

      // The fixture hooks pin the manifest as a const literal, so a manifest-only version bump
      // fails the install typecheck. A changed hooks file is what produces a new stored version.
      const hooksPath = blockerBundle.manifest.assets.hooks;
      const blockerVersionTwo: Bundle = {
        ...blockerBundle,
        files: {
          ...blockerBundle.files,
          [hooksPath]: `${blockerBundle.files[hooksPath]}\n// version 2\n`,
        },
      };
      const versionTwo = await install(ctx, blockerVersionTwo, { source: "rest" });
      expect(versionTwo.version === 2, "Second blocker install did not create version 2");
      expectStatus(
        await ctx.api("POST", `/api/extensions/${blockerId}/activate-version`, {
          body: { version: 2 },
        }),
        [200],
        "activate blocker version 2",
      );
      const rollback = await ctx.api("POST", `/api/extensions/${blockerId}/activate-version`, {
        body: { version: 1 },
      });
      expectStatus(rollback, [200], "activate blocker version 1");
      expect(
        asRecord(asRecord(rollback.json).extension).activeVersion === 1,
        "Activated blocker version is not 1",
      );

      const routedWorkerId = await registerWorker(ctx, `e2e-extension-route-${ctx.nonce}`);
      const routeBundle = await loadBundle("route-channel-to-agent");
      const route = await install(ctx, routeBundle, {
        channelId: "C0GENERAL0",
        agentId: routedWorkerId,
      });
      const routeId = extensionId(route, "route-channel-to-agent");
      installedIds.add(routeId);
      await enable(ctx, routeId);
      const message = await ask(ctx, `route extension task ${ctx.nonce}`);
      const routed = await pollUntil(() => {
        const task = ctx.db.get<{ agentId: string | null }>(
          "SELECT agentId FROM agent_tasks WHERE slackTriggerMessageTs = ? ORDER BY createdAt DESC LIMIT 1",
          [message.ts],
        );
        return task?.agentId === routedWorkerId;
      }, 30_000);
      expect(routed, "Slack extension did not route the task to its configured agent");
      await disable(ctx, routeId);

      const toolWorkerId = await registerWorker(ctx, `e2e-extension-tool-${ctx.nonce}`);
      const toolTask = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `extension tool task ${ctx.nonce}`,
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

      const punctuationBundle = await loadBundle("no-exclamation-marks");
      const punctuation = await install(ctx, punctuationBundle);
      const punctuationId = extensionId(punctuation, "no-exclamation-marks");
      installedIds.add(punctuationId);
      await enable(ctx, punctuationId);
      workerConnection = await ctx.connectMcp(toolWorkerId);
      const blockedProgress = asRecord(
        await workerConnection.callTool("store-progress", {
          taskId: toolTaskId,
          progress: "done!",
        }),
      );
      expect(blockedProgress.isError === true, "no-exclamation-marks did not reject progress");
      await disable(ctx, punctuationId);

      const throwsBundle = await loadBundle("throws");
      const throwing = await install(ctx, throwsBundle);
      const throwingId = extensionId(throwing, "throws");
      installedIds.add(throwingId);
      await enable(ctx, throwingId);
      for (let index = 0; index < 5; index++) {
        expectStatus(
          await ctx.api("POST", "/api/tasks", {
            body: { task: `throwing extension task ${ctx.nonce} ${index}` },
          }),
          [201],
          `create task for throwing extension failure ${index + 1}`,
        );
      }
      const autoDisabled = await pollUntil(async () => {
        const response = await ctx.api("GET", `/api/extensions/${throwingId}`);
        expectStatus(response, [200], "read throwing extension status");
        return asRecord(asRecord(response.json).extension).status === "auto-disabled";
      }, 10_000);
      expect(autoDisabled, "Throwing extension did not auto-disable after five failures");
    } finally {
      await workerConnection?.close();
      await leadConnection?.close();
      await cleanupExtensions(ctx, installedIds);
    }
  },
};
