import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createPage,
  deletePage,
  getPage,
  getPageBySlug,
  getPageVersion,
  getPageVersions,
  initDb,
  listAllPages,
  listPagesByAgent,
  updatePage,
} from "../be/db";
import { snapshotPage } from "../pages/version";

const TEST_DB_PATH = "./test-pages-storage.sqlite";

function makeAgentId() {
  return `agent-${crypto.randomUUID().slice(0, 8)}`;
}

beforeAll(() => {
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("pages storage CRUD", () => {
  test("create → get → list → delete cascades to versions", () => {
    const agentId = makeAgentId();
    const created = createPage({
      agentId,
      slug: "hello",
      title: "Hello",
      contentType: "text/html",
      authMode: "public",
      body: "<h1>hi</h1>",
    });

    expect(created.id).toMatch(/^[0-9a-f]{32}$/); // 32-char random hex from migration default
    expect(created.agentId).toBe(agentId);
    expect(created.slug).toBe("hello");
    expect(created.contentType).toBe("text/html");
    expect(created.authMode).toBe("public");

    const fetched = getPage(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe("Hello");

    const bySlug = getPageBySlug(agentId, "hello");
    expect(bySlug?.id).toBe(created.id);

    const byAgent = listPagesByAgent(agentId);
    expect(byAgent.map((p) => p.id)).toContain(created.id);

    const all = listAllPages();
    expect(all.map((p) => p.id)).toContain(created.id);

    // Create a version so we can verify cascade
    const snap = snapshotPage(created.id, agentId);
    expect(snap.version).toBe(1);
    expect(getPageVersions(created.id)).toHaveLength(1);

    const deleted = deletePage(created.id);
    expect(deleted).toBe(true);
    expect(getPage(created.id)).toBeNull();
    // Cascade: version rows gone
    expect(getPageVersions(created.id)).toHaveLength(0);
  });

  test("snapshotPage captures PRE-update content; post-update lives on parent", () => {
    const agentId = makeAgentId();
    const page = createPage({
      agentId,
      slug: "pre-update",
      title: "Original Title",
      contentType: "text/html",
      authMode: "public",
      body: "<h1>v1 body</h1>",
    });

    // 1. Snapshot first — captures v1 (pre-update) content
    snapshotPage(page.id, agentId);
    // 2. Then update — new content goes on parent
    const updated = updatePage(page.id, {
      title: "Updated Title",
      body: "<h1>v2 body</h1>",
    });
    expect(updated?.title).toBe("Updated Title");
    expect(updated?.body).toBe("<h1>v2 body</h1>");

    const v1 = getPageVersion(page.id, 1);
    expect(v1).not.toBeNull();
    expect(v1?.snapshot.title).toBe("Original Title");
    expect(v1?.snapshot.body).toBe("<h1>v1 body</h1>");

    // Repeat — snapshot then update should produce v2 with the latest
    // pre-update state (i.e. "Updated Title").
    snapshotPage(page.id, agentId);
    updatePage(page.id, { title: "Third Title", body: "<h1>v3 body</h1>" });

    const v2 = getPageVersion(page.id, 2);
    expect(v2?.snapshot.title).toBe("Updated Title");
    expect(v2?.snapshot.body).toBe("<h1>v2 body</h1>");

    // Versions list ordered DESC
    const all = getPageVersions(page.id);
    expect(all.map((v) => v.version)).toEqual([2, 1]);
  });

  test("UNIQUE(agentId, slug) is enforced", () => {
    const agentId = makeAgentId();
    createPage({
      agentId,
      slug: "dup",
      title: "First",
      contentType: "text/html",
      authMode: "public",
      body: "<h1>1</h1>",
    });

    expect(() =>
      createPage({
        agentId,
        slug: "dup",
        title: "Second",
        contentType: "text/html",
        authMode: "public",
        body: "<h1>2</h1>",
      }),
    ).toThrow(/UNIQUE/);

    // Different agent — same slug is fine
    const otherAgent = makeAgentId();
    const ok = createPage({
      agentId: otherAgent,
      slug: "dup",
      title: "Other agent",
      contentType: "text/html",
      authMode: "public",
      body: "<h1>x</h1>",
    });
    expect(ok.id).toBeTruthy();
  });

  test("password hash is not equal to plaintext", async () => {
    const plaintext = "hunter2-secret";
    const hash = await Bun.password.hash(plaintext, "bcrypt");
    expect(hash).not.toBe(plaintext);
    expect(hash.length).toBeGreaterThan(20);

    const page = createPage({
      agentId: makeAgentId(),
      slug: "secret",
      title: "Secret",
      contentType: "text/html",
      authMode: "password",
      passwordHash: hash,
      body: "<h1>secret</h1>",
    });
    expect(page.passwordHash).toBe(hash);
    expect(page.passwordHash).not.toBe(plaintext);
    expect(await Bun.password.verify(plaintext, page.passwordHash!)).toBe(true);
  });

  test("needsCredentials roundtrips as JSON array", () => {
    const page = createPage({
      agentId: makeAgentId(),
      slug: "needs-creds",
      title: "Needs",
      contentType: "application/json",
      authMode: "public",
      body: "{}",
      needsCredentials: ["GITHUB_TOKEN", "OPENAI_API_KEY"],
    });
    const fetched = getPage(page.id);
    expect(fetched?.needsCredentials).toEqual(["GITHUB_TOKEN", "OPENAI_API_KEY"]);
  });

  test("snapshotPage throws on missing parent", () => {
    expect(() => snapshotPage("0".repeat(32), "agent-x")).toThrow(/not found/);
  });
});
