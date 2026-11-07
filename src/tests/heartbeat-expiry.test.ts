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
import { handleAgentRegister, handleAgentsRest } from "../http/agents";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { HeartbeatExpiryError, validateHeartbeatExpiry } from "../utils/heartbeat-expiry";
import { listenOnFreePort } from "./test-net";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

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
  test.each(["saved", "HTTP 400", "network failure"] as const)(
    "first-boot runner handles profile %s and continues initializing",
    async (outcome) => {
      const leadId = crypto.randomUUID();
      const secret = "profile-save-test-credential-value";
      expect(await getAgentById(leadId)).toBeFalsy();
      const templateFile = (name: string) =>
        Bun.file(new URL(`../../templates/official/lead/${name}`, import.meta.url)).text();
      const template = {
        config: await Bun.file(
          new URL("../../templates/official/lead/config.json", import.meta.url),
        ).json(),
        files: {
          soulMd: await templateFile("SOUL.md"),
          identityMd: await templateFile("IDENTITY.md"),
          claudeMd: await templateFile("CLAUDE.md"),
          toolsMd: "",
          setupScript: "",
          heartbeatMd:
            outcome === "HTTP 400"
              ? section("- New undated HTTP item")
              : await templateFile("HEARTBEAT.md"),
        },
      };
      let profileBefore: Awaited<ReturnType<typeof getAgentById>>;
      const profileStatuses: number[] = [];
      const server = createServer(async (req, res) => {
        try {
          const path = new URL(req.url ?? "/", "http://localhost").pathname;
          const json = (data: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          };
          if (path === "/api/templates/official/lead") return json(template);
          if (path === "/api/config/resolved") return json({ configs: [] });
          if (path === "/api/fs/agent-credentials") return json({ enabled: false });
          if (path.startsWith("/api/active-sessions/")) return json({ recovered: 0 });
          if (path === "/me") {
            profileBefore = await getAgentById(leadId);
            return json(profileBefore);
          }
          if (path === `/api/agents/${leadId}/profile` && req.method === "PUT") {
            res.once("finish", () => profileStatuses.push(res.statusCode));
          }
          if (path === `/api/agents/${leadId}/mcp-servers`) return json({ servers: [] });
          if (await handleAgentRegister(req, res, getPathSegments(req.url ?? "/"), leadId)) return;
          if (
            await handleAgentsRest(
              req,
              res,
              getPathSegments(req.url ?? "/"),
              parseQueryParams(req.url ?? "/"),
              leadId,
            )
          )
            return;
          res.writeHead(404).end();
        } catch {
          res.writeHead(500).end();
        }
      });
      const port = await listenOnFreePort(server);
      const dir = `${process.env.TMPDIR ?? "/tmp"}/runner-profile-boot-${leadId}`;
      await Bun.$`mkdir -p ${dir}`.quiet();
      try {
        await Bun.write(
          `${dir}/boot.ts`,
          `
        import { mock } from "bun:test";
        const fs = { ...await import("node:fs/promises") };
        // A fresh template cache, without touching the host's /workspace.
        const isolated = (fn) => (...args) => {
          if (String(args[0]).startsWith("/workspace")) throw new Error("No fixture workspace");
          return fn(...args);
        };
        mock.module("node:fs/promises", () => ({
          ...fs, stat: isolated(fs.stat), mkdir: isolated(fs.mkdir),
        }));
        const request = globalThis.fetch;
        globalThis.fetch = Object.assign(async (...args) => {
          const path = new URL(args[0] instanceof Request ? args[0].url : args[0]).pathname;
          if (${JSON.stringify(outcome)} === "network failure" && path === "/api/agents/${leadId}/profile") {
            throw new TypeError("fetch failed: " + process.env.AGENT_SWARM_API_KEY);
          }
          const response = await request(...args);
          // This request follows profile initialization and precedes workspace writes.
          if (new URL(response.url).pathname === "/api/agents/${leadId}/mcp-servers") {
            console.log("Boot identity phase completed");
            process.exit(0);
          }
          return response;
        }, { preconnect: request.preconnect });
        const { runAgent } = await import(${JSON.stringify(new URL("../commands/runner.ts", import.meta.url).pathname)});
        await runAgent({ role: "lead", defaultPrompt: "/start-leader", metadataType: "lead_metadata" },
          { logsDir: ${JSON.stringify(`${dir}/logs`)} });
      `,
        );
        const child = expectChildOk(
          await runChild([process.execPath, `${dir}/boot.ts`], {
            cwd: dir,
            env: {
              ...process.env,
              AGENT_ID: leadId,
              AGENT_NAME: "Fresh lead",
              AGENT_SWARM_API_KEY: secret,
              MCP_BASE_URL: `http://localhost:${port}`,
              TEMPLATE_ID: "official/lead",
              TEMPLATE_REGISTRY_URL: `http://localhost:${port}`,
              HARNESS_PROVIDER: "claude",
              CRED_CHECK_DISABLE: "1",
              ANONYMIZED_TELEMETRY: "false",
              BUSINESS_USE_API_KEY: "",
              OTEL_SDK_DISABLED: "true",
              DESPLEGA_TELEMETRY_ENV: "test",
              HOME: dir,
              PATH: dir,
            },
          }),
          "first-boot lead runner",
        );
        expect(child.stdout).toContain("Boot identity phase completed");
        const saved = await getAgentById(leadId);
        expect(saved).toBeTruthy();
        expect(child.stdout + child.stderr).not.toContain(secret);
        if (outcome === "saved") {
          expect(profileStatuses).toEqual([200]);
          expect(saved?.soulMd).toContain("# SOUL.md — Fresh lead");
          expect(saved?.identityMd).toContain("# IDENTITY.md — Fresh lead");
          expect(saved?.claudeMd).toBeTruthy();
          expect(saved?.toolsMd).toBeTruthy();
          expect(saved?.heartbeatMd).toBe(template.files.heartbeatMd);
          expect(child.stdout).toContain("[lead] Generated and saved default identity templates");
        } else {
          expect(saved).toEqual(profileBefore);
          expect(child.stdout).not.toContain("Generated and saved default identity templates");
          expect(child.stderr).toContain("Could not save generated templates to server");
          if (outcome === "HTTP 400") {
            expect(profileStatuses).toEqual([400]);
            expect(child.stderr).toContain("HTTP 400");
            expect(child.stderr).toContain("New undated HTTP item");
          } else {
            expect(profileStatuses).toEqual([]);
            expect(child.stderr).toContain("fetch failed");
          }
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Bun.$`rm -rf ${dir}`.quiet();
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
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
