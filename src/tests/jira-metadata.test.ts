import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";
import { upsertOAuthApp } from "../be/db-queries/oauth";
import { getJiraMetadata, updateJiraMetadata } from "../jira/metadata";

const TEST_DB_PATH = "./test-jira-metadata.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

beforeEach(() => {
  // Reset the oauth_apps row before each test so prior writes can't leak.
  getDb().query("DELETE FROM oauth_apps WHERE provider = 'jira'").run();
  upsertOAuthApp("jira", {
    clientId: "client-id",
    clientSecret: "client-secret",
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    redirectUri: "http://localhost:3013/api/trackers/jira/callback",
    scopes: "read:jira-work,write:jira-work,manage:jira-webhook,offline_access,read:me",
  });
});

describe("getJiraMetadata", () => {
  test("returns empty object when oauth_apps row is missing", () => {
    getDb().query("DELETE FROM oauth_apps WHERE provider = 'jira'").run();
    expect(getJiraMetadata()).toEqual({});
  });

  test("returns empty object when metadata is malformed JSON", () => {
    getDb()
      .query("UPDATE oauth_apps SET metadata = ? WHERE provider = 'jira'")
      .run("{not valid json");
    expect(getJiraMetadata()).toEqual({});
  });

  test("returns empty object when metadata is empty string", () => {
    getDb().query("UPDATE oauth_apps SET metadata = ? WHERE provider = 'jira'").run("");
    expect(getJiraMetadata()).toEqual({});
  });

  test("returns parsed cloudId/siteUrl/webhookIds when present", () => {
    const meta = {
      cloudId: "cloud-1",
      siteUrl: "https://example.atlassian.net",
      webhookIds: [{ id: 42, expiresAt: "2026-12-01T00:00:00.000Z", jql: "project = KAN" }],
    };
    getDb()
      .query("UPDATE oauth_apps SET metadata = ? WHERE provider = 'jira'")
      .run(JSON.stringify(meta));

    const result = getJiraMetadata();
    expect(result.cloudId).toBe("cloud-1");
    expect(result.siteUrl).toBe("https://example.atlassian.net");
    expect(result.webhookIds).toEqual([
      { id: 42, expiresAt: "2026-12-01T00:00:00.000Z", jql: "project = KAN" },
    ]);
  });

  test("filters malformed webhookIds entries", () => {
    const meta = {
      webhookIds: [
        { id: 1, expiresAt: "2026-12-01T00:00:00.000Z", jql: "project = A" },
        { id: "not-a-number", expiresAt: "2026-12-01T00:00:00.000Z", jql: "project = B" },
        { id: 2, expiresAt: 12345, jql: "project = C" }, // expiresAt wrong type
        null,
      ],
    };
    getDb()
      .query("UPDATE oauth_apps SET metadata = ? WHERE provider = 'jira'")
      .run(JSON.stringify(meta));

    const result = getJiraMetadata();
    expect(result.webhookIds).toEqual([
      { id: 1, expiresAt: "2026-12-01T00:00:00.000Z", jql: "project = A" },
    ]);
  });
});

describe("updateJiraMetadata", () => {
  test("scalar keys: shallow merge preserves untouched keys", () => {
    updateJiraMetadata({ cloudId: "cloud-1", siteUrl: "https://example.atlassian.net" });
    updateJiraMetadata({ cloudId: "cloud-2" });
    const meta = getJiraMetadata();
    expect(meta.cloudId).toBe("cloud-2");
    expect(meta.siteUrl).toBe("https://example.atlassian.net");
  });

  test("webhookIds: id-keyed merge preserves untouched entries and replaces matching ids", () => {
    updateJiraMetadata({
      webhookIds: [
        { id: 1, expiresAt: "2026-12-01T00:00:00.000Z", jql: "project = A" },
        { id: 2, expiresAt: "2026-12-01T00:00:00.000Z", jql: "project = B" },
      ],
    });

    // Update id=2 only — id=1 should be untouched.
    updateJiraMetadata({
      webhookIds: [{ id: 2, expiresAt: "2026-12-31T00:00:00.000Z", jql: "project = B-updated" }],
    });

    const meta = getJiraMetadata();
    const sorted = [...(meta.webhookIds ?? [])].sort((a, b) => a.id - b.id);
    expect(sorted).toEqual([
      { id: 1, expiresAt: "2026-12-01T00:00:00.000Z", jql: "project = A" },
      { id: 2, expiresAt: "2026-12-31T00:00:00.000Z", jql: "project = B-updated" },
    ]);
  });

  test("concurrent-style updates preserve both writers' keys", () => {
    // Phase 2 OAuth callback writes cloudId+siteUrl, Phase 5 webhook-register
    // writes webhookIds. Both should coexist after both have run.
    updateJiraMetadata({ cloudId: "cloud-x", siteUrl: "https://x.atlassian.net" });
    updateJiraMetadata({
      webhookIds: [{ id: 99, expiresAt: "2026-11-01T00:00:00.000Z", jql: "project = X" }],
    });

    const meta = getJiraMetadata();
    expect(meta.cloudId).toBe("cloud-x");
    expect(meta.siteUrl).toBe("https://x.atlassian.net");
    expect(meta.webhookIds).toEqual([
      { id: 99, expiresAt: "2026-11-01T00:00:00.000Z", jql: "project = X" },
    ]);
  });

  test("throws when oauth_apps row for jira is missing", () => {
    getDb().query("DELETE FROM oauth_apps WHERE provider = 'jira'").run();
    expect(() => updateJiraMetadata({ cloudId: "x" })).toThrow(/oauth_apps row missing/);
  });

  test("undefined partial keys do not clobber existing values", () => {
    updateJiraMetadata({ cloudId: "cloud-keep", siteUrl: "https://keep.atlassian.net" });
    updateJiraMetadata({}); // No keys passed
    const meta = getJiraMetadata();
    expect(meta.cloudId).toBe("cloud-keep");
    expect(meta.siteUrl).toBe("https://keep.atlassian.net");
  });
});
