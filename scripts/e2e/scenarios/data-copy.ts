import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCli } from "../cli";
import {
  type ApiClient,
  asRecord,
  asRecords,
  asString,
  expect,
  expectStatus,
  pollUntil,
} from "../http";
import type { Scenario } from "../run";

// Check 20 of the storage-engine brief (decision D11): fill a source API through the
// public API, run `agent-swarm db-copy`, boot an API on the copy, and compare the
// responses of a fixed list of GET routes. The copy runs the same way in every run of
// the suite, so the scenario list stays the same on each engine.

/** Memory ids that a keyword search for `query` returns, with the arm that found each. */
async function searchMemory(api: ApiClient, agentId: string, query: string) {
  const response = await api("POST", "/api/memory/search", {
    agentId,
    body: { query, limit: 20, scope: "agent" },
  });
  expectStatus(response, [200], `memory search "${query}"`);
  return new Map(
    asRecords(response.json, "results").map((row) => [
      asString(row.id, "memory id"),
      String(row.retrievalSource),
    ]),
  );
}

/**
 * Parsed JSON, compared with a strict deep-equal (jsonb key order, approved by Daniel).
 * Each API writes its own origin into links (a page's api_url); the two APIs listen on
 * different ports, so the origin becomes a placeholder. Stored values are not touched.
 */
async function snapshot(api: ApiClient, path: string) {
  const response = await api("GET", path);
  expectStatus(response, [200], `GET ${path}`);
  return JSON.parse(response.text.replace(/http:\/\/(localhost|127\.0\.0\.1):\d+/g, "<origin>"));
}

export const dataCopy: Scenario = {
  name: "data-copy",
  order: 9_010,
  async run(ctx) {
    const pair = await ctx.startDataCopy();
    try {
      const api = pair.source;
      const agentId = randomUUID();
      const registered = await api("POST", "/api/agents", {
        agentId,
        body: { name: `copy-worker-${ctx.nonce}`, role: "worker", status: "online" },
      });
      expectStatus(registered, [200, 201], "register agent");

      const taskIds: string[] = [];
      for (const text of [
        `copy task ascii ${ctx.nonce}`,
        `copy task ünïcødé 日本語 🚀 ${ctx.nonce}`,
        `copy task with "quotes" and \\ backslash ${ctx.nonce}`,
      ]) {
        const created = await api("POST", "/api/tasks", {
          body: { task: text, agentId, routingReason: "human_pinned", source: "api" },
        });
        expectStatus(created, [201], "create task");
        taskIds.push(String(asRecord(created.json).id));
      }
      const tagged = await api("PATCH", `/api/tasks/${taskIds[0]}/tags`, {
        body: { add: ["ui:zeta", "ui:alpha"] },
      });
      expectStatus(tagged, [200], "tag task");

      const schedule = await api("POST", "/api/schedules", {
        body: {
          name: `copy-schedule-${ctx.nonce}`,
          cronExpression: "0 0 1 1 *",
          taskTemplate: "copy schedule task",
          targetAgentId: agentId,
        },
      });
      expectStatus(schedule, [200, 201], "create schedule");
      const scheduleRecord = asRecord(schedule.json);
      const scheduleId = String(asRecord(scheduleRecord.schedule ?? scheduleRecord).id);

      const secretKey = `COPY_SECRET_${ctx.nonce}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      const plainKey = `COPY_PLAIN_${ctx.nonce}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      for (const [key, value, isSecret] of [
        [secretKey, "copy-secret-value", true],
        [plainKey, "copy plain value", false],
      ] as const) {
        const put = await api("PUT", "/api/config", {
          body: { scope: "global", key, value, isSecret },
        });
        expectStatus(put, [200, 201], `config ${key}`);
      }

      const kvKey = `copy-kv-${ctx.nonce}`;
      const kv = await api("PUT", `/api/kv/${kvKey}`, {
        agentId,
        body: { value: { nested: { b: 2, a: [1, "x", null, true] }, flag: false } },
      });
      expectStatus(kv, [200], "kv put");

      const memory = await api("POST", "/api/memory/index", {
        agentId,
        body: {
          content: `copy memory about a violet heron ${ctx.nonce}`,
          name: `copy memory ${ctx.nonce}`,
          scope: "agent",
          source: "manual",
          agentId,
        },
      });
      expectStatus(memory, [202], "index memory");
      const memoryIds = asRecord(memory.json).memoryIds;
      const memoryId = asString(Array.isArray(memoryIds) ? memoryIds[0] : undefined, "memory id");
      // Indexing is asynchronous: copy only once the source finds the memory.
      expect(
        await pollUntil(
          async () => (await searchMemory(api, agentId, "violet heron")).has(memoryId),
          20_000,
          200,
        ),
        "the source never found its memory by keyword",
      );

      const page = await api("POST", "/api/pages", {
        agentId,
        body: {
          title: `copy page ${ctx.nonce}`,
          slug: `copy-page-${ctx.nonce}`,
          contentType: "text/html",
          body: "<p>copy</p>",
        },
      });
      expectStatus(page, [200, 201], "create page");
      const pageId = String(asRecord(page.json).id);

      const routes = [
        `/api/agents/${agentId}`,
        ...taskIds.map((id) => `/api/tasks/${id}`),
        `/api/tasks?agentId=${agentId}`,
        `/api/schedules/${scheduleId}`,
        `/api/config?scope=global&key=${secretKey}&includeSecrets=true`,
        `/api/config?scope=global&key=${plainKey}`,
        `/api/pages/${pageId}`,
      ];
      const before = new Map<string, unknown>();
      for (const route of routes) before.set(route, await snapshot(api, route));
      const kvBefore = await api("GET", `/api/kv/${kvKey}`, { agentId });
      expectStatus(kvBefore, [200], "kv get on the source");

      const { cli, target, recopy, sourcePath, targetUrl } = await pair.copy();
      expect(
        cli.exitCode === 0,
        `db-copy exited ${cli.exitCode}: ${cli.stderr.slice(-2000)}${cli.stdout.slice(-1000)}`,
      );
      expect(
        cli.stdout.includes("every count and checksum equal"),
        `db-copy did not report equal checksums: ${cli.stdout.slice(-1000)}`,
      );

      for (const route of routes) {
        const after = await snapshot(target, route);
        expect(
          Bun.deepEquals(after, before.get(route), true),
          `GET ${route} differs after the copy:\nsource ${JSON.stringify(before.get(route)).slice(0, 1500)}\ntarget ${JSON.stringify(after).slice(0, 1500)}`,
        );
      }
      const secret = asRecord(before.get(routes[routes.length - 3] as string));
      expect(
        JSON.stringify(secret).includes("copy-secret-value"),
        `the source did not return the secret in clear: ${JSON.stringify(secret).slice(0, 400)}`,
      );
      // Full text on Postgres reads stored documents (memory_fts): the copy builds
      // one for each copied memory, so a keyword search on the copy finds it.
      const rebuiltFts = /\[db-copy\] rebuilt memory_fts: (\d+) rows/.exec(cli.stdout);
      expect(
        rebuiltFts !== null && Number(rebuiltFts[1]) >= 1,
        `db-copy did not build the full-text documents: ${cli.stdout.slice(-1500)}`,
      );
      const keywordHits = await searchMemory(target, agentId, "violet heron");
      expect(
        keywordHits.has(memoryId),
        `a keyword search on the copy did not find memory ${memoryId}: ${JSON.stringify([...keywordHits])}`,
      );
      const kvAfter = await target("GET", `/api/kv/${kvKey}`, { agentId });
      expect(
        kvAfter.status === 200 && kvAfter.text === kvBefore.text,
        `kv value differs after the copy: ${kvBefore.text} vs ${kvAfter.text}`,
      );

      // The API on the copy applies no migration: the chain is already recorded. The
      // starter dashboard still runs, because the copy rewrites each stock SQLite query
      // it copied (COLLATE NOCASE, datetime, ? placeholders) to its Postgres form.
      const definitions = await target("GET", "/api/metrics/definitions?agentId=system");
      expectStatus(definitions, [200], "list the system metrics on the copy");
      const starter = asRecords(definitions.json, "metrics").find(
        (metric) => metric.slug === "swarm-operations-overview",
      );
      expect(starter !== undefined, "The starter dashboard is missing on the copy");
      const starterRun = await target(
        "POST",
        `/api/metrics/definitions/${asString(starter!.id, "starter id")}/run`,
        { body: { variables: { agentFilter: agentId } } },
      );
      expectStatus(starterRun, [200], "run the starter dashboard on the copy");
      for (const widget of asRecords(starterRun.json, "widgets")) {
        expect(
          Array.isArray(asRecord(widget.result).rows),
          `starter widget ${asRecord(widget.widget).id} failed on the copy: ${JSON.stringify(widget).slice(0, 600)}`,
        );
      }

      // The copy keeps working on the target: a new write after it lands.
      const created = await target("POST", "/api/tasks", {
        body: {
          task: `after copy ${ctx.nonce}`,
          agentId,
          routingReason: "human_pinned",
          source: "api",
        },
      });
      expectStatus(created, [201], "new task on the copy");

      // A second copy into the same database is refused while its API runs on it.
      const again = await recopy();
      expect(again.exitCode === 1, `a second copy exited ${again.exitCode}, expected 1`);
      expect(
        again.stderr.includes("an API process holds the target database"),
        `a second copy did not name the running API: ${again.stderr.slice(-800)}`,
      );

      // --json never names the source: the report would replace the rollback file.
      const sourceHash = () => createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
      const hashBefore = sourceHash();
      const links = mkdtempSync(join(tmpdir(), "db-copy-json-"));
      try {
        const symlink = join(links, "report-symlink.json");
        const hardlink = join(links, "report-hardlink.json");
        symlinkSync(sourcePath, symlink);
        linkSync(sourcePath, hardlink);
        for (const report of [
          sourcePath,
          relative(process.cwd(), sourcePath),
          `${sourcePath}-wal`,
          symlink,
          hardlink,
        ]) {
          const refused = await runCli(
            ["db-copy", "--from", sourcePath, "--to", targetUrl, "--json", report],
            { cwd: process.cwd(), env: { DESPLEGA_TELEMETRY_ENV: "test" }, timeoutMs: 120_000 },
          );
          expect(
            refused.exitCode === 2 && refused.stderr.includes("is the SQLite source"),
            `db-copy --json ${report} exited ${refused.exitCode}, expected 2: ${refused.stderr.slice(-600)}`,
          );
          expect(sourceHash() === hashBefore, `db-copy --json ${report} changed the source file`);
        }
        // A symlink as --from: SQLite's WAL sits beside the real file, not the link.
        const fromLink = join(links, "source-link.sqlite");
        symlinkSync(sourcePath, fromLink);
        const viaLink = await runCli(
          ["db-copy", "--from", fromLink, "--to", targetUrl, "--json", `${sourcePath}-wal`],
          { cwd: process.cwd(), env: { DESPLEGA_TELEMETRY_ENV: "test" }, timeoutMs: 120_000 },
        );
        expect(
          viaLink.exitCode === 2 && viaLink.stderr.includes("is the SQLite source"),
          `db-copy --from <symlink> --json <real>-wal exited ${viaLink.exitCode}, expected 2: ${viaLink.stderr.slice(-600)}`,
        );
        // A report path that cannot be written is refused before the copy starts.
        const dirReport = await runCli(
          ["db-copy", "--from", sourcePath, "--to", targetUrl, "--json", links],
          { cwd: process.cwd(), env: { DESPLEGA_TELEMETRY_ENV: "test" }, timeoutMs: 120_000 },
        );
        expect(
          dirReport.exitCode === 2 && dirReport.stderr.includes("is a directory"),
          `db-copy --json <directory> exited ${dirReport.exitCode}, expected 2: ${dirReport.stderr.slice(-600)}`,
        );
        expect(sourceHash() === hashBefore, "a refused report path changed the source file");
      } finally {
        rmSync(links, { recursive: true, force: true });
      }
    } finally {
      await pair.stop();
    }
  },
};
