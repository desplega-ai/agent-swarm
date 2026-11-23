import { sql, sqlList } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
  cancelTask,
  expectToolOk,
  type McpSession,
  registerAgent,
} from "./knowledge-helpers";

// Locks in today's full-text search results on every API surface that runs a
// token index: task search (GET /api/tasks?search, MCP get-tasks), skill search
// (GET /api/skills?search, MCP skill-search) and the keyword arm of memory search
// (POST /api/memory/search, MCP memory-search). A later storage backend must
// return the same id sets and the same top hit for each query.

function sameSet(actual: string[], expected: string[], label: string): void {
  const a = [...new Set(actual)].sort();
  const e = [...new Set(expected)].sort();
  expect(
    a.length === actual.length && JSON.stringify(a) === JSON.stringify(e),
    `${label}: expected ids {${e.join(", ")}}, got [${actual.join(", ")}]`,
  );
}

function sameOrder(actual: string[], expected: string[], label: string): void {
  expect(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: expected order [${expected.join(", ")}], got [${actual.join(", ")}]`,
  );
}

/** Turn ids back into corpus labels so a failure message reads "t1, t2" and not UUIDs. */
function labelsOf(ids: string[], byLabel: Record<string, string>): string[] {
  const byId = new Map(Object.entries(byLabel).map(([label, id]) => [id, label]));
  return ids.map((id) => byId.get(id) ?? `other:${id}`);
}

async function taskSearch(ctx: ScenarioContext, agentId: string, search: string) {
  const query = new URLSearchParams({ agentId, search, limit: "100" });
  const response = await ctx.api("GET", `/api/tasks?${query}`);
  expectStatus(response, [200], `task search "${search}"`);
  return asRecords(response.json, "tasks").map((task) => asString(task.id, "task id"));
}

async function taskSearchMcp(session: McpSession, search: string) {
  const outcome = expectToolOk(
    await callTool(session, "get-tasks", { mineOnly: true, search, limit: 100 }),
    `get-tasks search "${search}"`,
  );
  const tasks = Array.isArray(outcome.data.tasks) ? outcome.data.tasks : [];
  return tasks.map((task) => asString(asRecord(task).id, "get-tasks task id"));
}

async function skillSearch(ctx: ScenarioContext, search: string) {
  const response = await ctx.api("GET", `/api/skills?${new URLSearchParams({ search })}`);
  expectStatus(response, [200], `skill search "${search}"`);
  return asRecords(response.json, "skills").map((skill) => asString(skill.id, "skill id"));
}

async function memorySearch(ctx: ScenarioContext, agentId: string, query: string, prefix: string) {
  const response = await ctx.api("POST", "/api/memory/search", {
    agentId,
    body: { query, limit: 20, scope: "agent", keyPrefix: prefix },
  });
  expectStatus(response, [200], `memory search "${query}"`);
  return asRecords(response.json, "results").map((row) => ({
    id: asString(row.id, "memory id"),
    source: String(row.retrievalSource),
  }));
}

/** Memory ids the keyword arm surfaced (alone or fused with the vector arm). */
function keywordHits(rows: { id: string; source: string }[]): string[] {
  return rows.filter((row) => row.source === "fts" || row.source === "hybrid").map((r) => r.id);
}

export const divergenceFulltextSearch: Scenario = {
  name: "divergence-fulltext-search",
  order: 9_110,
  async run(ctx) {
    const owner = await registerAgent(ctx, "div-fts");
    const session = await ctx.connectMcp(owner);
    const taskIds: string[] = [];
    const skillIds: string[] = [];
    try {
      // ── Tasks: phrase match with a prefix on the last token ─────────────────────────────
      // Every text stays under 48 characters, so no generated title joins the index.
      const taskCorpus: Record<string, string> = {
        t1: "amber falcon crosses the river",
        t2: "amber falcon nests near cliffs",
        t3: "falcon amber sleeps at noon",
        t4: "silver river flows past cliffs",
        t5: "the riverbank hosts amber reeds",
        t6: "Amberly visits silver cliffs",
        t7: "copper kettle boils water",
        t8: "falcons circle the copper tower",
      };
      const tasks: Record<string, string> = {};
      for (const [label, text] of Object.entries(taskCorpus)) {
        const response = await ctx.api("POST", "/api/tasks", {
          body: { task: text, agentId: owner, routingReason: "human_pinned", source: "api" },
        });
        expectStatus(response, [201], `create task ${label}`);
        tasks[label] = asString(asRecord(response.json).id, "task id");
        taskIds.push(tasks[label]);
      }
      const t = (...labels: string[]) => labels.map((label) => tasks[label]!);

      const taskQueries: [string, string[]][] = [
        // One word matches itself and every token it prefixes ("falcons").
        ["falcon", t("t1", "t2", "t3", "t8")],
        // A phrase keeps word order: "falcon amber" in t3 is not "amber falcon".
        ["amber falcon", t("t1", "t2")],
        // Prefix on the last token: "river" finds "riverbank".
        ["river", t("t1", "t4", "t5")],
        // Case-insensitive, and "amber" prefixes "Amberly".
        ["AMBER", t("t1", "t2", "t3", "t5", "t6")],
        ["falc", t("t1", "t2", "t3", "t8")],
        ["kettle boils", t("t7")],
        // Not a substring match: "alcon" sits inside "falcon" but starts no token.
        ["alcon", []],
        // Adjacent words in the wrong order.
        ["cliffs silver", []],
        // '%' and '_' are not wildcards.
        ["%", []],
        ["_", []],
        // A task id prefix finds that task.
        [tasks.t7!.slice(0, 8), t("t7")],
      ];
      for (const [search, expected] of taskQueries) {
        const http = await taskSearch(ctx, owner, search);
        sameSet(
          labelsOf(http, tasks),
          labelsOf(expected, tasks),
          `GET /api/tasks search "${search}"`,
        );
        const mcp = await taskSearchMcp(session, search);
        sameSet(labelsOf(mcp, tasks), labelsOf(expected, tasks), `get-tasks search "${search}"`);
      }

      // ── Skills: OR of terms ranked by BM25 (name 3, description 2, content 1) ───────────
      // Skill search is global, so its words carry the nonce; the nonce goes last so the
      // English stem stays at the front of each token.
      const w = (stem: string) => `${stem}x${ctx.nonce}`;
      const [A, B, C, D] = [w("zephyr"), w("quokka"), w("marlin"), w("tundra")];
      const filler =
        "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore";
      const skillCorpus: Record<string, { description: string; body: string }> = {
        s1: { description: `${A} ${B} handbook`, body: `Use ${A} carefully.` },
        s2: { description: `${B} reference`, body: `${filler} ${A} ${filler}` },
        s3: { description: `${C} notes`, body: `${A} ${C}` },
        s4: { description: `${D} ${B} guide`, body: "Nothing else here." },
        s5: { description: "plain words only", body: `${C} ${C} ${C}` },
      };
      const skills: Record<string, string> = {};
      const skillName = (label: string) => `div-fts-${ctx.nonce}-${label}`;
      for (const [label, spec] of Object.entries(skillCorpus)) {
        const response = await ctx.api("POST", "/api/skills", {
          body: {
            content: `---\nname: ${skillName(label)}\ndescription: ${spec.description}\n---\n\n${spec.body}\n`,
            scope: "agent",
            ownerAgentId: owner,
          },
        });
        expectStatus(response, [201], `create skill ${label}`);
        skills[label] = asString(asRecord(asRecord(response.json).skill).id, "skill id");
        skillIds.push(skills[label]);
      }
      const s = (...labels: string[]) => labels.map((label) => skills[label]!);

      const skillQueries: { query: string; set: string[]; top?: string; order?: string[] }[] = [
        // A in s1's description beats A only in a body.
        { query: A, set: s("s1", "s2", "s3"), top: skills.s1 },
        // s4 holds both terms in its description.
        { query: `${B} ${D}`, set: s("s1", "s2", "s4"), top: skills.s4 },
        // A query equal to a skill name (any case) ranks that skill first.
        { query: skillName("s5").toUpperCase(), set: s("s5"), top: skills.s5 },
        // A partial token matches no index term, so search falls back to a substring
        // match on name, description and content, ordered by name.
        { query: A.slice(0, -3), set: s("s1", "s2", "s3"), order: s("s1", "s2", "s3") },
      ];
      for (const { query, set, top, order } of skillQueries) {
        const http = await skillSearch(ctx, query);
        const mine = http.filter((id) => skillIds.includes(id));
        sameSet(labelsOf(http, skills), labelsOf(set, skills), `GET /api/skills search "${query}"`);
        if (top) expect(mine[0] === top, `skill search "${query}": top ${labelsOf(mine, skills)}`);
        if (order) sameOrder(labelsOf(mine, skills), labelsOf(order, skills), `skills "${query}"`);
        const mcp = expectToolOk(
          await callTool(session, "skill-search", { query }),
          `skill-search "${query}"`,
        );
        const mcpIds = (Array.isArray(mcp.data.skills) ? mcp.data.skills : []).map((row) =>
          asString(asRecord(row).id, "skill-search id"),
        );
        sameOrder(labelsOf(mcpIds, skills), labelsOf(http, skills), `skill-search "${query}"`);
      }

      // ── Memory: the keyword arm of hybrid search (porter stemming, OR of terms) ─────────
      const prefix = `/longterm/facts/e2e-div-fts-${ctx.nonce}/`;
      const memoryCorpus: Record<string, string> = {
        m1: "Harbor cranes lift steel containers at dawn.",
        m2: "Steel bridges rust slowly near the harbor.",
        m3: "Containers of tea arrive by ship every spring.",
        m4: "Orchard bees pollinate apple blossoms in spring.",
        m5: "Apple orchards need pruning before blossoms open.",
        m6: "Glacier meltwater feeds the alpine lake.",
        m7: "Alpine climbers carry steel crampons and rope.",
        m8: "Lighthouse keepers watch the harbor lights.",
      };
      const memories: Record<string, string> = {};
      for (const [label, content] of Object.entries(memoryCorpus)) {
        const stored = expectToolOk(
          await callTool(session, "memory-store", {
            content,
            name: `fact ${label}`,
            scope: "agent",
            key: `${prefix}${label}`,
          }),
          `memory-store ${label}`,
        );
        memories[label] = String((stored.data.memoryIds as unknown[])[0]);
      }
      const memoryIds = Object.values(memories);
      const embedded = await pollUntil(
        () =>
          ctx.db.get<{ n: number }>(
            sql`SELECT count(*) AS n FROM agent_memory WHERE id IN (${sqlList(memoryIds)}) AND "embeddingModel" IS NOT NULL`,
          )?.n === memoryIds.length,
        20_000,
        200,
      );
      expect(embedded, "the memory corpus never finished embedding");
      const m = (...labels: string[]) => labels.map((label) => memories[label]!);

      const memoryQueries: { query: string; set: string[]; top: string }[] = [
        { query: "harbor", set: m("m1", "m2", "m8"), top: memories.m8! },
        { query: "steel containers", set: m("m1", "m2", "m3", "m7"), top: memories.m1! },
        { query: "blossoms spring", set: m("m3", "m4", "m5"), top: memories.m4! },
        // Stemming: "pollinating" and "pollinate" share a stem.
        { query: "pollinating", set: m("m4"), top: memories.m4! },
      ];
      const firstOrder: Record<string, string[]> = {};
      for (const { query, set, top } of memoryQueries) {
        const rows = await memorySearch(ctx, owner, query, prefix);
        ctx.log(
          `memory "${query}": ${rows.map((r) => `${labelsOf([r.id], memories)[0]}/${r.source}`).join(" ")}`,
        );
        sameSet(
          labelsOf(keywordHits(rows), memories),
          labelsOf(set, memories),
          `memory "${query}"`,
        );
        expect(
          rows[0]?.id === top,
          `memory "${query}": top was ${labelsOf([rows[0]?.id ?? ""], memories)}`,
        );
        firstOrder[query] = rows.map((r) => r.id);
      }

      // MCP memory-search records an access on every hit, which boosts later rankings,
      // so it runs once, last, and must agree with the HTTP route.
      const mcp = expectToolOk(
        await callTool(session, "memory-search", {
          query: "steel containers",
          scope: "agent",
          limit: 20,
          keyPrefix: prefix,
        }),
        "memory-search steel containers",
      );
      const mcpRows = (Array.isArray(mcp.data.results) ? mcp.data.results : []).map((row) => ({
        id: asString(asRecord(row).id, "memory-search id"),
        source: String(asRecord(row).retrievalSource),
      }));
      sameSet(
        labelsOf(keywordHits(mcpRows), memories),
        labelsOf(m("m1", "m2", "m3", "m7"), memories),
        "memory-search steel containers",
      );
      sameOrder(
        labelsOf(
          mcpRows.map((r) => r.id),
          memories,
        ),
        labelsOf(firstOrder["steel containers"] ?? [], memories),
        "memory-search order vs POST /api/memory/search",
      );
    } finally {
      for (const id of skillIds) await ctx.api("DELETE", `/api/skills/${id}`);
      for (const id of taskIds) await cancelTask(ctx, id).catch(() => {});
      await session.close();
    }
  },
};
