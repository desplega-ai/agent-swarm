import { randomUUID } from "node:crypto";
import { type ApiClient, asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// Check 20 of the storage-engine brief (decision D11): fill a source API through the
// public API, run `agent-swarm db-copy`, boot an API on the copy, and compare the
// responses of a fixed list of GET routes. The copy runs the same way in every run of
// the suite, so the scenario list stays the same on each engine.

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

      const { cli, target, recopy } = await pair.copy();
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
      const kvAfter = await target("GET", `/api/kv/${kvKey}`, { agentId });
      expect(
        kvAfter.status === 200 && kvAfter.text === kvBefore.text,
        `kv value differs after the copy: ${kvBefore.text} vs ${kvAfter.text}`,
      );

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
    } finally {
      await pair.stop();
    }
  },
};
