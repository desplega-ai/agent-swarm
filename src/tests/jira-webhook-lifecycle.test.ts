import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";
import { upsertOAuthApp } from "../be/db-queries/oauth";
import { getJiraMetadata, updateJiraMetadata } from "../jira/metadata";

const TEST_DB_PATH = "./test-jira-webhook-lifecycle.sqlite";

// Mock the Jira fetch client. Each test installs its own per-call response.
const jiraFetchMock = mock(
  () =>
    Promise.resolve(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as Promise<Response>,
);
mock.module("../jira/client", () => ({
  jiraFetch: jiraFetchMock,
  getJiraAccessToken: () => Promise.resolve("access-1"),
  getJiraCloudId: () => "cloud-1",
}));

beforeAll(() => {
  initDb(TEST_DB_PATH);
  process.env.JIRA_WEBHOOK_TOKEN = "test-token-32-chars-deadbeef-cafe-99";
  process.env.MCP_BASE_URL = "https://test.example.com";

  upsertOAuthApp("jira", {
    clientId: "client-id",
    clientSecret: "client-secret",
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    redirectUri: "http://localhost:3013/api/trackers/jira/callback",
    scopes: "read:jira-work,manage:jira-webhook",
    metadata: JSON.stringify({ cloudId: "cloud-1", siteUrl: "https://example.atlassian.net" }),
  });
});

afterAll(async () => {
  delete process.env.JIRA_WEBHOOK_TOKEN;
  delete process.env.MCP_BASE_URL;
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

const { refreshJiraWebhooks, registerJiraWebhook } = await import("../jira/webhook-lifecycle");

beforeEach(() => {
  jiraFetchMock.mockClear();
  // Reset the webhookIds list each test (and clear metadata writebacks).
  getDb()
    .query("UPDATE oauth_apps SET metadata = ? WHERE provider = 'jira'")
    .run(JSON.stringify({ cloudId: "cloud-1", siteUrl: "https://example.atlassian.net" }));
});

describe("registerJiraWebhook", () => {
  test("posts the right body shape and persists webhookId into metadata", async () => {
    jiraFetchMock.mockImplementationOnce(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              webhookRegistrationResult: [{ createdWebhookId: 42 }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ) as Promise<Response>,
    );

    const result = await registerJiraWebhook("project = KAN");

    expect(result.webhookId).toBe(42);
    expect(result.jql).toBe("project = KAN");
    expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO

    expect(jiraFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = jiraFetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/rest/api/3/webhook");
    expect(init.method).toBe("POST");

    const parsed = JSON.parse(init.body as string) as {
      url: string;
      webhooks: { events: string[]; jqlFilter: string; fieldIdsFilter: string[] }[];
    };
    expect(parsed.url).toBe(
      "https://test.example.com/api/trackers/jira/webhook/test-token-32-chars-deadbeef-cafe-99",
    );
    expect(parsed.webhooks[0]?.jqlFilter).toBe("project = KAN");
    expect(parsed.webhooks[0]?.events).toEqual([
      "jira:issue_updated",
      "jira:issue_deleted",
      "comment_created",
      "comment_updated",
    ]);
    expect(parsed.webhooks[0]?.fieldIdsFilter).toEqual(["assignee"]);

    // Persisted in metadata
    const meta = getJiraMetadata();
    expect(meta.webhookIds?.length).toBe(1);
    expect(meta.webhookIds?.[0]?.id).toBe(42);
    expect(meta.webhookIds?.[0]?.jql).toBe("project = KAN");
  });

  test("throws when JIRA_WEBHOOK_TOKEN is unset", async () => {
    const saved = process.env.JIRA_WEBHOOK_TOKEN;
    delete process.env.JIRA_WEBHOOK_TOKEN;
    await expect(registerJiraWebhook("project = X")).rejects.toThrow(
      /JIRA_WEBHOOK_TOKEN is not set/,
    );
    process.env.JIRA_WEBHOOK_TOKEN = saved;
  });

  test("throws when Atlassian returns no results", async () => {
    jiraFetchMock.mockImplementationOnce(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ webhookRegistrationResult: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ) as Promise<Response>,
    );

    await expect(registerJiraWebhook("project = X")).rejects.toThrow(/returned no results/);
  });

  test("throws when entry is malformed (missing createdWebhookId)", async () => {
    jiraFetchMock.mockImplementationOnce(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              webhookRegistrationResult: [{ errors: ["bad jql"] }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ) as Promise<Response>,
    );

    await expect(registerJiraWebhook("project = X")).rejects.toThrow(/malformed/);
  });

  test("throws when Atlassian responds non-OK", async () => {
    jiraFetchMock.mockImplementationOnce(
      () => Promise.resolve(new Response("forbidden", { status: 403 })) as Promise<Response>,
    );
    await expect(registerJiraWebhook("project = X")).rejects.toThrow(/registration failed \(403\)/);
  });
});

describe("refreshJiraWebhooks", () => {
  test("no-op when no webhooks are registered", async () => {
    await refreshJiraWebhooks();
    expect(jiraFetchMock).not.toHaveBeenCalled();
  });

  test("handles 200 + expirationDate — applies new expiry to all webhooks", async () => {
    updateJiraMetadata({
      webhookIds: [
        { id: 1, expiresAt: "2026-04-01T00:00:00.000Z", jql: "p=A" },
        { id: 2, expiresAt: "2026-04-15T00:00:00.000Z", jql: "p=B" },
      ],
    });

    jiraFetchMock.mockImplementationOnce(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ expirationDate: "2026-12-31T00:00:00.000Z" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ) as Promise<Response>,
    );

    await refreshJiraWebhooks();

    expect(jiraFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = jiraFetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/rest/api/3/webhook/refresh");
    expect(init.method).toBe("PUT");
    const parsed = JSON.parse(init.body as string) as { webhookIds: number[] };
    expect(parsed.webhookIds.sort()).toEqual([1, 2]);

    const meta = getJiraMetadata();
    const sorted = [...(meta.webhookIds ?? [])].sort((a, b) => a.id - b.id);
    expect(sorted[0]?.expiresAt).toBe("2026-12-31T00:00:00.000Z");
    expect(sorted[1]?.expiresAt).toBe("2026-12-31T00:00:00.000Z");
  });

  test("handles 204 No Content — leaves local expiries unchanged", async () => {
    updateJiraMetadata({
      webhookIds: [{ id: 7, expiresAt: "2026-04-01T00:00:00.000Z", jql: "p=A" }],
    });

    jiraFetchMock.mockImplementationOnce(
      () => Promise.resolve(new Response(null, { status: 204 })) as Promise<Response>,
    );

    await refreshJiraWebhooks();

    const meta = getJiraMetadata();
    expect(meta.webhookIds?.[0]?.expiresAt).toBe("2026-04-01T00:00:00.000Z");
  });

  test("throws on Atlassian non-OK response", async () => {
    updateJiraMetadata({
      webhookIds: [{ id: 8, expiresAt: "2026-04-01T00:00:00.000Z", jql: "p=A" }],
    });

    jiraFetchMock.mockImplementationOnce(
      () => Promise.resolve(new Response("rate limited", { status: 429 })) as Promise<Response>,
    );

    await expect(refreshJiraWebhooks()).rejects.toThrow(/refresh failed \(429\)/);
  });

  test("malformed JSON response leaves expiries untouched (no crash)", async () => {
    updateJiraMetadata({
      webhookIds: [{ id: 9, expiresAt: "2026-04-01T00:00:00.000Z", jql: "p=A" }],
    });

    jiraFetchMock.mockImplementationOnce(
      () =>
        Promise.resolve(
          new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } }),
        ) as Promise<Response>,
    );

    await refreshJiraWebhooks();
    const meta = getJiraMetadata();
    expect(meta.webhookIds?.[0]?.expiresAt).toBe("2026-04-01T00:00:00.000Z");
  });
});
