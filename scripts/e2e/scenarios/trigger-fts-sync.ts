// Trigger group: full-text index sync.
// Covers:
//   agent_tasks_fts_insert, agent_tasks_fts_update (task search by text and title),
//   skills_fts_insert, skills_fts_update, skills_fts_delete,
//   skills_meta_fts_insert, skills_meta_fts_update, skills_meta_fts_delete (skill search).
// Unreachable: agent_tasks_fts_delete. No API deletes an agent_tasks row.
//
// Skill search falls back to a substring match when the index has no hit, and that fallback
// orders by name only. The skill assertions therefore check rank as well as membership: the
// index ranks a name or description hit above a body hit, the fallback would not.
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

async function taskSearch(ctx: ScenarioContext, term: string): Promise<string[]> {
  const response = await ctx.api("GET", `/api/tasks?search=${encodeURIComponent(term)}&limit=50`);
  expectStatus(response, [200], `search tasks for ${term}`);
  return asRecords(response.json, "tasks").map((task) => String(task.id));
}

async function skillSearch(ctx: ScenarioContext, term: string, ids: string[]): Promise<string[]> {
  const response = await ctx.api("GET", `/api/skills?search=${encodeURIComponent(term)}`);
  expectStatus(response, [200], `search skills for ${term}`);
  return asRecords(response.json, "skills")
    .map((skill) => String(skill.id))
    .filter((id) => ids.includes(id));
}

function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

export const triggerFtsSync: Scenario = {
  name: "trigger-fts-sync",
  order: 9_340,
  async run(ctx) {
    // ── tasks ────────────────────────────────────────────────────────────────
    const registered = await ctx.api("POST", "/api/agents", {
      body: { name: `trg-fts-worker-${ctx.nonce}`, role: "worker", status: "online" },
    });
    expectStatus(registered, [201], "register a worker");
    const workerId = asString(asRecord(registered.json).id, "worker id");
    const textWord = `ftstext${ctx.nonce}`;
    const titleOld = `ftstitleold${ctx.nonce}`;
    const titleNew = `ftstitlenew${ctx.nonce}`;
    const created = await ctx.api("POST", "/api/tasks", {
      body: {
        task: `index me ${textWord}`,
        agentId: workerId,
        routingReason: "human_pinned",
        source: "api",
      },
    });
    expectStatus(created, [201], "create a task");
    const taskId = asString(asRecord(created.json).id, "task id");
    const skillIds: string[] = [];
    try {
      const indexed = await pollUntil(
        async () => (await taskSearch(ctx, textWord)).includes(taskId),
        15_000,
      );
      expect(indexed, "a new task is findable by a word of its text");

      let response = await ctx.api("PATCH", `/api/tasks/${taskId}/title`, {
        body: { title: `Title ${titleOld}` },
      });
      expectStatus(response, [200], "set a title");
      expect((await taskSearch(ctx, titleOld)).includes(taskId), "findable by its title");
      response = await ctx.api("PATCH", `/api/tasks/${taskId}/title`, {
        body: { title: `Title ${titleNew}` },
      });
      expectStatus(response, [200], "rename the task");
      expect((await taskSearch(ctx, titleNew)).includes(taskId), "findable by the new title");
      expect(
        !(await taskSearch(ctx, titleOld)).includes(taskId),
        "no longer findable by the old title",
      );
      expect((await taskSearch(ctx, textWord)).includes(taskId), "still findable by its text");
      response = await ctx.api("PATCH", `/api/tasks/${taskId}/title`, { body: { title: null } });
      expectStatus(response, [200], "clear the title");
      expect(
        !(await taskSearch(ctx, titleNew)).includes(taskId),
        "a cleared title is no longer findable",
      );

      // ── skills ─────────────────────────────────────────────────────────────
      // `head` matches in its name/description, `tail` only in its body. `tail` sorts first by
      // name, so an index-ranked result lists `head` first and the fallback would not.
      const oldWord = `ftsskillold${ctx.nonce}`;
      const newWord = `ftsskillnew${ctx.nonce}`;
      const headName = `trg-fts-z-head-${ctx.nonce}`;
      const tailName = `trg-fts-a-tail-${ctx.nonce}`;
      const create = async (content: string, label: string) => {
        const res = await ctx.api("POST", "/api/skills", { body: { content } });
        expectStatus(res, [201], `create skill ${label}`);
        const id = asString(asRecord(asRecord(res.json).skill).id, `${label} id`);
        skillIds.push(id);
        return id;
      };
      const head = await create(
        skillMarkdown(headName, `Handles ${oldWord} requests`, "Plain steps only."),
        "head",
      );
      const tail = await create(
        skillMarkdown(
          tailName,
          "A long unrelated skill",
          `Some body text that mentions ${oldWord} and ${newWord} once each, among other words.`,
        ),
        "tail",
      );
      let hits = await skillSearch(ctx, oldWord, skillIds);
      expect(
        hits.join() === [head, tail].join(),
        `the index ranks the description hit first: ${JSON.stringify(hits)}`,
      );

      response = await ctx.api("PUT", `/api/skills/${head}`, {
        body: { content: skillMarkdown(headName, `Handles ${newWord} requests`, "Plain steps.") },
      });
      expectStatus(response, [200], "rewrite the head skill");
      hits = await skillSearch(ctx, oldWord, skillIds);
      expect(
        hits.join() === tail,
        `the old description word no longer finds the head skill: ${JSON.stringify(hits)}`,
      );
      hits = await skillSearch(ctx, newWord, skillIds);
      expect(
        hits.join() === [head, tail].join(),
        `the new description word ranks the head skill first: ${JSON.stringify(hits)}`,
      );

      response = await ctx.api("DELETE", `/api/skills/${head}`);
      expectStatus(response, [200, 204], "delete the head skill");
      skillIds.splice(skillIds.indexOf(head), 1);
      hits = await skillSearch(ctx, newWord, [head, tail]);
      expect(hits.join() === tail, `a deleted skill is not found: ${JSON.stringify(hits)}`);
    } finally {
      for (const id of skillIds) await ctx.api("DELETE", `/api/skills/${id}`);
      await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: { reason: "trigger cleanup" } });
      await ctx.api("POST", "/close", { agentId: workerId, body: {} });
    }
  },
};
