import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  closeDb,
  createAgent,
  getAgentById,
  getDbClient,
  initDb,
  updateAgentProfile,
} from "../be/db";
import { handleAgentsRest } from "../http/agents";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { HeartbeatExpiryError, validateHeartbeatExpiry } from "../utils/heartbeat-expiry";
import { listenOnFreePort } from "./test-net";

const section = (...lines: string[]) => `## Tracked Items\n${lines.join("\n")}\n`;

describe("heartbeat expiry validation", () => {
  test.each(["DELETE 09-30", "delete on 09-30", "DeLeTe ON 09-30"])("accepts %s", (expiry) => {
    expect(() => validateHeartbeatExpiry("", section(`- New item. ${expiry}`))).not.toThrow();
  });
  test("rejects a new undated item and names it", () => {
    expect(() => validateHeartbeatExpiry("", section("- Check the queue"))).toThrow(
      "new tracked item requires DELETE <MM-DD> (or DELETE on <MM-DD>): Check the queue",
    );
  });
  test.each([
    "📌 Permanent rule",
    "- 📌 Permanent rule",
    "- [ ] 📌 Permanent rule",
  ])("exempts pin durables: %s", (line) => {
    expect(() => validateHeartbeatExpiry("", section(line))).not.toThrow();
  });
  test("does not exempt a pin in the middle of an item", () => {
    expect(() => validateHeartbeatExpiry("", section("- Check 📌 status"))).toThrow(
      HeartbeatExpiryError,
    );
  });
  test("allows unchanged, shortened, and edited legacy items", () => {
    const old = section(
      "- **Queue:** Check the queue every morning and evening",
      "- Keep this item",
    );
    for (const line of [
      "- **Queue:** Check the queue every morning and evening",
      "- **Queue:** Check the queue",
      "- **Queue:** Inspect pending work weekly",
    ]) {
      expect(() => validateHeartbeatExpiry(old, section(line, "- Keep this item"))).not.toThrow();
    }
    expect(() =>
      validateHeartbeatExpiry(section("- Check the queue daily"), section("- Check the queue")),
    ).not.toThrow();
  });
  test("allows pure deletion, including the entire section", () => {
    expect(() => validateHeartbeatExpiry(section("- Old undated item"), section())).not.toThrow();
    expect(() => validateHeartbeatExpiry(section("- Old undated item"), "")).not.toThrow();
  });
  test("uses the last marker and excludes the marker line and later sections", () => {
    const next =
      "## Tracked Items\n- Earlier example\n## Tracked Items (current)\n- New. DELETE 09-30\n## Notes\nUndated notes";
    expect(() => validateHeartbeatExpiry("", next)).not.toThrow();
    expect(() => validateHeartbeatExpiry("", "Mention ## Tracked Items here\n- Undated")).toThrow();
    expect(() => validateHeartbeatExpiry("", "## Tracked Items")).not.toThrow();
    expect(() => validateHeartbeatExpiry("", "## Other\n- Undated")).not.toThrow();
  });
  test("does not use a token on the marker or another line", () => {
    expect(() => validateHeartbeatExpiry("", "## Tracked Items DELETE 09-30\n- Undated")).toThrow();
    expect(() =>
      validateHeartbeatExpiry("", section("- Dated DELETE 09-30", "- Undated")),
    ).toThrow();
  });
  test("legacy matches are one-to-one, even for reordered lines", () => {
    const old = section("- **Old:** Keep", "- **Other:** Keep");
    expect(() =>
      validateHeartbeatExpiry(old, section("- **Other:** Keep", "- **Old:** Updated")),
    ).not.toThrow();
    expect(() =>
      validateHeartbeatExpiry(old, section("- **Old:** Keep", "- **Old:** New")),
    ).toThrow();
    expect(() => validateHeartbeatExpiry(old, section("- **Unrelated:** New"))).toThrow();
  });
  test("condensing the middle of a legacy line passes", () => {
    expect(() =>
      validateHeartbeatExpiry(
        section("- Check the large queue daily"),
        section("- Check the queue"),
      ),
    ).not.toThrow();
  });
  test("dating a legacy item cannot authorize a second undated copy", () => {
    for (const lines of [
      ["- **Old:** New", "- **Old:** Updated DELETE 09-30"],
      ["- **Old:** Updated DELETE 09-30", "- **Old:** New"],
      ["- Legacy text DELETE 09-30", "- Legacy"],
    ]) {
      expect(() =>
        validateHeartbeatExpiry(section("- **Old:** Original", "- Legacy text"), section(...lines)),
      ).toThrow();
    }
  });
  test("does not grandfather removal of a date or pin", () => {
    expect(() =>
      validateHeartbeatExpiry(section("- **Old:** DELETE 09-30"), section("- **Old:** Undated")),
    ).toThrow();
    expect(() => validateHeartbeatExpiry(section("📌 Permanent"), section("Permanent"))).toThrow();
  });
});

const dbPath = "./test-heartbeat-expiry.sqlite";
describe("profile persistence heartbeat gate", () => {
  const agentId = crypto.randomUUID();
  beforeAll(async () => {
    initDb(dbPath);
    await createAgent({ id: agentId, name: "Expiry test", isLead: false, status: "idle" });
    // Seed pre-gate legacy state directly in this isolated test database.
    await getDbClient().run("UPDATE agents SET heartbeatMd = ? WHERE id = ?", [
      section("- **Legacy:** Old text"),
      agentId,
    ]);
  });
  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"])
      await Bun.file(dbPath + suffix)
        .delete()
        .catch(() => {});
  });
  test("rejects atomically before profile or version writes", async () => {
    const before = await getAgentById(agentId);
    const versionsBefore = await getDbClient().query(
      "SELECT * FROM context_versions WHERE agentId = ?",
      [agentId],
    );
    await expect(
      updateAgentProfile(agentId, {
        description: "Must not land",
        heartbeatMd: section("- **Legacy:** Old text", "- New undated item"),
      }),
    ).rejects.toThrow(HeartbeatExpiryError);
    expect(await getAgentById(agentId)).toEqual(before);
    expect(
      await getDbClient().query("SELECT * FROM context_versions WHERE agentId = ?", [agentId]),
    ).toEqual(versionsBefore);
  });
  test("HTTP returns 400 with the offending line", async () => {
    const server = createServer(async (req, res) => {
      try {
        await handleAgentsRest(
          req,
          res,
          getPathSegments(req.url ?? "/"),
          parseQueryParams(req.url ?? "/"),
          agentId,
        );
      } catch {
        res.writeHead(500).end();
      }
    });
    const port = await listenOnFreePort(server);
    try {
      const response = await fetch(`http://localhost:${port}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heartbeatMd: section("- New undated HTTP item") }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("New undated HTTP item");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("persists edits, dated additions, pin durables, and deletions", async () => {
    const next = section("- **Legacy:** Revised", "- Dated DELETE on 09-30", "📌 Durable");
    expect((await updateAgentProfile(agentId, { heartbeatMd: next }))?.heartbeatMd).toBe(next);
    expect((await updateAgentProfile(agentId, { heartbeatMd: "" }))?.heartbeatMd).toBe("");
  });
  test("drops a stale heartbeat before validating, preserving other updates", async () => {
    const result = await updateAgentProfile(
      agentId,
      { heartbeatMd: section("- Invalid stale item"), description: "Fresh metadata" },
      undefined,
      { expectedHashes: { heartbeatMd: "stale" } },
    );
    expect(result?.heartbeatMd).toBe("");
    expect(result?.description).toBe("Fresh metadata");
  });
});
