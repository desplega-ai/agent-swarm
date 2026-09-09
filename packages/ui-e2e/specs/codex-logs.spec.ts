import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";

type SessionLogsResponse = { success: true; count: number };

interface CodexLogSeed {
  firstMessage: string;
  liveItemId: string;
  liveMessage: string;
  livePartial: string;
  mcpResult: string;
  secondMessage: string;
  sessionId: string;
  wrappedUserMessage: string;
}

function codexLogSeed(suffix: string): CodexLogSeed {
  const prefix = `e2e Codex ${suffix}`;
  return {
    firstMessage: `${prefix} distinct response alpha`,
    liveItemId: `e2e-codex-live-${suffix}`,
    liveMessage: `${prefix} live response`,
    livePartial: `${prefix} live`,
    mcpResult: `${prefix} MCP result`,
    secondMessage: `${prefix} distinct response beta`,
    sessionId: `e2e-codex-logs-${suffix}`,
    wrappedUserMessage: `${prefix} wrapped user message`,
  };
}

async function seedCodexLogs(
  api: { post<T>(path: string, body: unknown): Promise<T> },
  taskId: string,
  suffix: string,
): Promise<CodexLogSeed> {
  const seed = codexLogSeed(suffix);
  const wrappedUserMessage = {
    id: `e2e-codex-user-${suffix}`,
    type: "unknown",
    originalType: "userMessage",
    value: {
      type: "userMessage",
      id: `e2e-codex-user-${suffix}`,
      content: [{ type: "text", text: seed.wrappedUserMessage }],
    },
  };

  await api.post<SessionLogsResponse>("/api/session-logs", {
    sessionId: seed.sessionId,
    iteration: 1,
    taskId,
    cli: "codex",
    lines: [
      JSON.stringify({ type: "item.started", item: wrappedUserMessage }),
      JSON.stringify({ type: "item.completed", item: wrappedUserMessage }),
      JSON.stringify({
        type: "message.delta",
        item_id: seed.liveItemId,
        delta: `${prefix(seed)} `,
      }),
      JSON.stringify({ type: "message.delta", item_id: seed.liveItemId, delta: "live" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: `e2e-codex-first-${suffix}`, type: "agent_message", text: seed.firstMessage },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: `e2e-codex-second-${suffix}`,
          type: "agent_message",
          text: seed.secondMessage,
        },
      }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: `e2e-codex-mcp-${suffix}`,
          type: "mcp_tool_call",
          server: "e2e-mcp",
          tool: "inspect",
          arguments: { target: "logs" },
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: `e2e-codex-mcp-${suffix}`,
          type: "mcp_tool_call",
          server: "e2e-mcp",
          tool: "inspect",
          arguments: { target: "logs" },
          result: { content: [{ type: "text", text: seed.mcpResult }] },
        },
      }),
    ],
  });
  return seed;
}

function prefix(seed: CodexLogSeed): string {
  return seed.livePartial.slice(0, -" live".length);
}

async function completeLiveMessage(
  api: { post<T>(path: string, body: unknown): Promise<T> },
  taskId: string,
  seed: CodexLogSeed,
) {
  await api.post<SessionLogsResponse>("/api/session-logs", {
    sessionId: seed.sessionId,
    iteration: 1,
    taskId,
    cli: "codex",
    lines: [
      JSON.stringify({
        type: "item.completed",
        item: { id: seed.liveItemId, type: "agent_message", text: seed.liveMessage },
      }),
    ],
  });
}

async function openSessionLogs(page: Page, taskId: string, mobile = false) {
  await page.goto(`/tasks/${taskId}`);
  if (mobile) await page.getByRole("tab", { name: "Session Logs" }).click();
}

async function seedContextSnapshots(
  swarm: { apiKey: string; apiUrl: string },
  taskId: string,
  agentId: string,
  suffix: string,
) {
  const postSnapshot = async (body: Record<string, unknown>) => {
    const response = await fetch(`${swarm.apiUrl}/api/tasks/${taskId}/context`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${swarm.apiKey}`,
        "Content-Type": "application/json",
        "X-Agent-ID": agentId,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Context snapshot failed: ${response.status}`);
  };

  await postSnapshot({
    eventType: "progress",
    sessionId: `e2e-codex-context-${suffix}`,
    contextUsedTokens: 191_533,
    contextTotalTokens: 1_050_000,
    contextPercent: 18.241238095238096,
  });
  await postSnapshot({
    eventType: "completion",
    sessionId: `e2e-codex-context-${suffix}`,
    contextTotalTokens: 200_000,
  });
}

test("Codex app-server logs render messages, deltas, and MCP results", async ({
  page,
  api,
  seed,
  clean,
}, testInfo) => {
  test.skip(!seed, "remote run without seed");
  const logs = await seedCodexLogs(api, seed!.tasks.inProgress, testInfo.testId);
  await openSessionLogs(page, seed!.tasks.inProgress);

  await expect(
    page.getByText(logs.wrappedUserMessage, { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText(logs.livePartial, { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText(logs.firstMessage, { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText(logs.secondMessage, { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  await expect(page.getByText("Unknown · message.delta", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /e2e-mcp\.inspect/ }).click();
  await page
    .getByRole("button", { name: /e2e-mcp\.inspect/ })
    .last()
    .click();
  await expect(
    page.getByText(logs.mcpResult, { exact: true }).filter({ visible: true }),
  ).toBeVisible();

  await completeLiveMessage(api, seed!.tasks.inProgress, logs);
  await expect(
    page.getByText(logs.liveMessage, { exact: true }).filter({ visible: true }),
  ).toHaveCount(1, {
    timeout: 15_000,
  });

  await clean.assertClean();
});

test("context usage keeps the latest complete measurement", async ({
  page,
  seed,
  swarm,
  clean,
}, testInfo) => {
  test.skip(!seed, "remote run without seed");
  await seedContextSnapshots(swarm, seed!.tasks.inProgress, seed!.agents.workerA, testInfo.testId);
  await page.goto(`/tasks/${seed!.tasks.inProgress}`);

  await expect(
    page.getByText("191.5K / 1.1M", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByText("18%", { exact: true }).filter({ visible: true })).toHaveCount(2);
  await expect(page.getByText("200K", { exact: true })).toHaveCount(0);

  await clean.assertClean();
});

test.describe("below the lg breakpoint", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test("Codex app-server messages render in the Session Logs tab", async ({
    page,
    api,
    seed,
    clean,
  }, testInfo) => {
    test.skip(!seed, "remote run without seed");
    const logs = await seedCodexLogs(api, seed!.tasks.inProgress, testInfo.testId);
    await openSessionLogs(page, seed!.tasks.inProgress, true);

    await expect(
      page.getByText(logs.wrappedUserMessage, { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
    await expect(
      page.getByText(logs.livePartial, { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
    await expect(page.getByText("Unknown · message.delta", { exact: true })).toHaveCount(0);

    await clean.assertClean();
  });
});
