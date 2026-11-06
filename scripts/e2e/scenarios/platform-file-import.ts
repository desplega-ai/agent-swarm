import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";

// Boots the API with a `dir` import source (set as global config, injected into the
// env at boot), then restarts with a changed workflow file and a second, broken source.

const workflowYaml = (name: string, template: string) => `name: ${name}
definition:
  nodes:
    - id: review
      type: agent-task
      config:
        template: ${template}
`;

async function setSources(ctx: ScenarioContext, sources: unknown[]): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: {
      scope: "global",
      scopeId: null,
      key: "SWARM_IMPORT_SOURCES",
      value: JSON.stringify(sources),
      isSecret: false,
    },
  });
  expectStatus(response, [200], "set SWARM_IMPORT_SOURCES");
  const id = asRecord(response.json).id;
  expect(typeof id === "string", "config upsert returned no id");
  return id;
}

export const platformFileImport: Scenario = {
  name: "platform-file-import",
  order: 690,
  async run(ctx) {
    const dir = await mkdtemp(join(tmpdir(), "e2e-import-"));
    const workflowName = `e2e-import-${ctx.nonce}`;
    const agentName = `e2e-import-agent-${ctx.nonce}`;
    const sourceId = `e2e-${ctx.nonce}`.toLowerCase();
    let configId: string | undefined;
    try {
      await Bun.write(
        join(dir, "swarm-import.yaml"),
        `workflows:
  - id: review
    file: workflows/review.yaml
skills:
  - id: guide
    dir: skills/guide
agents:
  - name: ${agentName}
    instructions: agents/reviewer.md
    skills: [guide]
`,
      );
      await Bun.write(join(dir, "workflows/review.yaml"), workflowYaml(workflowName, "v1"));
      await Bun.write(
        join(dir, "skills/guide/SKILL.md"),
        `---\nname: e2e-import-guide-${ctx.nonce}\ndescription: Guide\n---\n\n# Guide\n`,
      );
      await Bun.write(join(dir, "agents/reviewer.md"), "# Imported reviewer\n");

      const source = { id: sourceId, type: "dir", path: dir };
      configId = await setSources(ctx, [source]);
      await ctx.restartSut();

      const workflow = ctx.db.get<{ id: string; enabled: number; definition: string }>(
        "SELECT id, enabled, definition FROM workflows WHERE name = ?",
        [workflowName],
      );
      expect(workflow, "imported workflow is missing after boot");
      expect(workflow.enabled === 0, "imported workflow must be created disabled");
      const pending = ctx.db.get<{ agentKey: string }>(
        "SELECT agentKey FROM import_pending_assignments WHERE sourceId = ?",
        [sourceId],
      );
      expect(pending?.agentKey === `name:${agentName}`, "unregistered agent has no pending row");

      // The agent registers after boot; its pending instructions and skill apply.
      const registered = await ctx.api("POST", "/api/agents", {
        body: { name: agentName, role: "worker", status: "online" },
      });
      expectStatus(registered, [201], "register the imported agent");
      const agentId = asRecord(registered.json).id;
      expect(typeof agentId === "string", "registered agent has no id");
      const agent = ctx.db.get<{ identityMd: string | null }>(
        "SELECT identityMd FROM agents WHERE id = ?",
        [agentId],
      );
      expect(agent?.identityMd === "# Imported reviewer\n", "pending instructions not applied");
      const installs = ctx.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM agent_skills a JOIN skills s ON s.id = a.skillId
          WHERE a.agentId = ? AND s.name = ?`,
        [agentId, `e2e-import-guide-${ctx.nonce}`],
      );
      expect(installs?.n === 1, "pending skill install not applied");

      // A changed file updates the same row; a broken second source does not stop boot.
      await Bun.write(join(dir, "workflows/review.yaml"), workflowYaml(workflowName, "v2"));
      await setSources(ctx, [source, { id: `${sourceId}-broken`, type: "dir", path: `${dir}-gone` }]);
      await ctx.restartSut();

      const health = await ctx.api("GET", "/health");
      expectStatus(health, [200], "health after boot with a broken source");
      const rows = ctx.db.query<{ id: string; enabled: number; definition: string }>(
        "SELECT id, enabled, definition FROM workflows WHERE name = ?",
        [workflowName],
      );
      expect(rows.length === 1, "re-import duplicated the workflow");
      expect(rows[0]?.id === workflow.id, "re-import did not update the same row");
      expect(rows[0]?.definition.includes("v2"), "re-import did not apply the changed file");
      expect(rows[0]?.enabled === 0, "re-import changed enabled");
      const versions = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM workflow_versions WHERE workflowId = ?",
        [workflow.id],
      );
      expect(versions?.n === 1, "an update must add exactly one workflow version");
    } finally {
      if (configId) await ctx.api("DELETE", `/api/config/${configId}`);
      await rm(dir, { recursive: true, force: true });
    }
  },
};
