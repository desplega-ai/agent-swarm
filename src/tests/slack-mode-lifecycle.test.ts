import { expect, test } from "bun:test";
import { createApiClient, pollUntil } from "../../scripts/e2e/http";
import { startSlackMock, stopSlackMock } from "../../scripts/e2e/slack";
import { type Sut, startSut, stopSut } from "../../scripts/e2e/sut";

test("config reload disconnects a live socket for HTTP and can return to Socket Mode", async () => {
  const slack = await startSlackMock(false);
  let sut: Sut | undefined;
  try {
    sut = await startSut(false, slack.mock.env, {
      SLACK_SIGNING_SECRET: "synthetic-signing-secret",
      HEARTBEAT_DISABLE: "true",
    });
    await slack.mock.waitForConnection(10_000);
    expect(slack.mock.connectionCount).toBe(1);
    const opened = slack.mock.apiCalls("apps.connections.open").length;
    const api = createApiClient(sut.baseUrl, sut.apiKey);
    const http = await api("PUT", "/api/config", {
      body: { scope: "global", key: "SLACK_MODE", value: "http" },
    });
    expect(http.status).toBe(200);
    expect(await pollUntil(() => slack.mock.connectionCount === 0, 10_000, 50)).toBe(true);
    const reload = await api("POST", "/api/config/reload");
    expect(reload.status).toBe(200);
    expect(reload.json).toMatchObject({ success: true });
    expect(
      (reload.json as { integrationsReinitialized: string[] }).integrationsReinitialized,
    ).not.toContain("slack");
    expect(slack.mock.apiCalls("apps.connections.open").length).toBe(opened);
    const socket = await api("PUT", "/api/config", {
      body: { scope: "global", key: "SLACK_MODE", value: "socket" },
    });
    expect(socket.status).toBe(200);
    expect(await pollUntil(() => slack.mock.connectionCount === 1, 10_000, 50)).toBe(true);
    expect(slack.mock.apiCalls("apps.connections.open").length).toBe(opened + 1);
  } finally {
    if (sut) await stopSut(sut, false);
    await stopSlackMock(slack, false);
  }
}, 30_000);
