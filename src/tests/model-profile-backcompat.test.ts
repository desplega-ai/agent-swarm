// Migration 220 must not change what an agent runs. For each config shape the
// test resolves the task the way production does (the real `/api/poll` claim,
// then the worker's real `fetchRepoConfig` + `fetchResolvedEnv` against this
// DB) and compares the final model and effort with and without the migrated
// default profile.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  closeDb,
  createAgent,
  createSwarmRepo,
  createTaskExtended,
  getDb,
  getDbClient,
  getResolvedConfig,
  getSwarmRepos,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { getAgentDefaultProfileName } from "../be/db/model-profiles";
import { fetchRepoConfig, fetchResolvedEnv } from "../commands/runner";
import { handlePoll } from "../http/poll";

const TEST_DB_PATH = "./test-model-profile-backcompat.sqlite";
const REPO = "desplega-ai/backcompat-repo";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** The part of migration 220 that turns agent overrides into profiles. */
function agentOverrideMigrationSql(): string {
  const sql = readFileSync(
    join(import.meta.dir, "../be/migrations/220_model_profiles.sql"),
    "utf8",
  );
  return sql.slice(sql.indexOf("CREATE TEMP TABLE _model_profile_overrides"));
}

let server: ReturnType<typeof Bun.serve>;
let apiUrl = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  // The two endpoints the worker reads its model config from, backed by this DB.
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/config/resolved") {
        const configs = await getResolvedConfig(
          url.searchParams.get("agentId") ?? undefined,
          url.searchParams.get("repoId") ?? undefined,
        );
        return Response.json({ configs });
      }
      if (url.pathname === "/api/repos") {
        return Response.json({
          repos: await getSwarmRepos({ name: url.searchParams.get("name") ?? undefined }),
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  apiUrl = server.url.toString().replace(/\/$/, "");
});

afterAll(async () => {
  server.stop(true);
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  const client = getDbClient();
  // References first: migration 220's triggers refuse deleting a named profile.
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM swarm_config");
  await client.run("DELETE FROM swarm_repos");
  await client.run("DELETE FROM agents");
  await client.run("DELETE FROM model_profiles");
});

type Trigger = { task: { resolvedModel?: string; effort?: string } };

async function claim(agentId: string): Promise<Trigger["task"]> {
  let body = "";
  const req = {
    method: "GET",
    url: "/api/poll",
    headers: { "x-agent-id": agentId },
  } as unknown as Parameters<typeof handlePoll>[0];
  const res = {
    setHeader() {},
    writeHead() {},
    end(chunk?: string) {
      body = chunk ?? "";
    },
  } as unknown as Parameters<typeof handlePoll>[1];
  await handlePoll(req, res, ["api", "poll"], new URLSearchParams(), agentId);
  const trigger = (JSON.parse(body) as { trigger: Trigger | null }).trigger;
  if (!trigger) throw new Error("nothing claimed");
  return trigger.task;
}

/**
 * Claim one task and return what the worker would start: runner.ts
 * spawnProviderProcess takes the claim's `resolvedModel`, else the env's
 * MODEL_OVERRIDE, and the trigger's `effort`, else REASONING_EFFORT_OVERRIDE.
 * The env is the real `fetchResolvedEnv` (repo > agent > global, a withheld
 * row removes its key).
 */
async function workerSelection(
  agentId: string,
  vcsRepo?: string,
  profile?: string,
): Promise<{ model: string | null; effort: string | null }> {
  await createTaskExtended("work", { agentId, vcsRepo, profile });
  const trigger = await claim(agentId);
  const repo = vcsRepo ? await fetchRepoConfig(apiUrl, "key", vcsRepo, true) : null;
  const { env } = await fetchResolvedEnv(apiUrl, "key", agentId, {}, trigger.resolvedModel, {
    repoId: repo?.id,
    provider: "codex",
  });
  await getDbClient().run("UPDATE agent_tasks SET status = 'completed'");
  return {
    model: trigger.resolvedModel || env.MODEL_OVERRIDE || null,
    effort: trigger.effort || env.REASONING_EFFORT_OVERRIDE || null,
  };
}

async function setRow(
  scope: "global" | "agent" | "repo",
  scopeId: string | null,
  key: string,
  value: string,
  exportToEnv = true,
): Promise<void> {
  await upsertSwarmConfig({ scope, scopeId, key, value, exportToEnv });
}

async function codexAgent(name: string): Promise<string> {
  const agent = await createAgent({
    name,
    isLead: false,
    status: "idle",
    harnessProvider: "codex",
  });
  return agent.id;
}

/** What the agent runs before migration 220 and after it. */
async function beforeAndAfterMigration(agentId: string, vcsRepo?: string) {
  const before = await workerSelection(agentId, vcsRepo);
  getDb().exec(agentOverrideMigrationSql());
  const after = await workerSelection(agentId, vcsRepo);
  return { before, after };
}

describe("migration 220 keeps exportToEnv = 0 overrides off", () => {
  test("a withheld effort stays absent while the model stays enabled", async () => {
    const id = await codexAgent("bc-effort-withheld");
    await setRow("global", null, "REASONING_EFFORT_OVERRIDE", "medium");
    await setRow("agent", id, "MODEL_OVERRIDE", "gpt-6.1-sol");
    await setRow("agent", id, "REASONING_EFFORT_OVERRIDE", "xhigh", false);

    const { before, after } = await beforeAndAfterMigration(id);
    expect(before).toEqual({ model: "gpt-6.1-sol", effort: null });
    expect(after).toEqual(before);
    expect(await getAgentDefaultProfileName(id)).toBe("codex-gpt-6.1-sol");
  });

  test("a withheld model makes no default", async () => {
    const id = await codexAgent("bc-model-withheld");
    await setRow("agent", id, "MODEL_OVERRIDE", "gpt-6.1-sol", false);
    await setRow("agent", id, "REASONING_EFFORT_OVERRIDE", "xhigh");

    const { before, after } = await beforeAndAfterMigration(id);
    expect(before).toEqual({ model: null, effort: "xhigh" });
    expect(after).toEqual(before);
    expect(await getAgentDefaultProfileName(id)).toBeNull();
  });

  test("both withheld: no default, nothing applied", async () => {
    const id = await codexAgent("bc-both-withheld");
    await setRow("agent", id, "MODEL_OVERRIDE", "gpt-6.1-sol", false);
    await setRow("agent", id, "REASONING_EFFORT_OVERRIDE", "xhigh", false);

    const { before, after } = await beforeAndAfterMigration(id);
    expect(before).toEqual({ model: null, effort: null });
    expect(after).toEqual(before);
  });

  test("control: both exported still become the default", async () => {
    const id = await codexAgent("bc-both-exported");
    await setRow("agent", id, "MODEL_OVERRIDE", "gpt-6.1-sol");
    await setRow("agent", id, "REASONING_EFFORT_OVERRIDE", "xhigh");

    const { before, after } = await beforeAndAfterMigration(id);
    expect(before).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
    expect(after).toEqual(before);
    expect(await getAgentDefaultProfileName(id)).toBe("codex-gpt-6.1-sol-xhigh");
  });
});

describe("withholding an override later drops the default", () => {
  for (const key of ["MODEL_OVERRIDE", "REASONING_EFFORT_OVERRIDE"] as const) {
    test(`same-value ${key} with exportToEnv false clears it, and the worker runs as without it`, async () => {
      const id = await codexAgent(`bc-toggle-${key}`);
      await setRow("agent", id, "MODEL_OVERRIDE", "gpt-6.1-sol");
      await setRow("agent", id, "REASONING_EFFORT_OVERRIDE", "xhigh");
      getDb().exec(agentOverrideMigrationSql());
      expect(await getAgentDefaultProfileName(id)).toBe("codex-gpt-6.1-sol-xhigh");

      // Control: re-saving the same value with the same flag is not a change.
      await setRow("agent", id, key, key === "MODEL_OVERRIDE" ? "gpt-6.1-sol" : "xhigh");
      expect(await getAgentDefaultProfileName(id)).toBe("codex-gpt-6.1-sol-xhigh");

      await upsertSwarmConfig({
        scope: "agent",
        scopeId: id,
        key,
        value: key === "MODEL_OVERRIDE" ? "gpt-6.1-sol" : "xhigh",
        exportToEnv: false,
      });
      expect(await getAgentDefaultProfileName(id)).toBeNull();
      expect(await workerSelection(id)).toEqual(
        key === "MODEL_OVERRIDE"
          ? { model: null, effort: "xhigh" }
          : { model: "gpt-6.1-sol", effort: null },
      );
    });
  }

  test("exporting a withheld override again also clears a default set since", async () => {
    const id = await codexAgent("bc-reexport");
    await setRow("agent", id, "MODEL_OVERRIDE", "gpt-6.1-sol");
    await setRow("agent", id, "REASONING_EFFORT_OVERRIDE", "xhigh", false);
    getDb().exec(agentOverrideMigrationSql());
    expect(await getAgentDefaultProfileName(id)).toBe("codex-gpt-6.1-sol");

    await setRow("agent", id, "REASONING_EFFORT_OVERRIDE", "xhigh", true);
    expect(await getAgentDefaultProfileName(id)).toBeNull();
    expect(await workerSelection(id)).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
  });
});

describe("repo-scoped overrides still beat a migrated agent default", () => {
  async function agentAndRepo(name: string): Promise<{ id: string; repoId: string }> {
    const id = await codexAgent(name);
    await setRow("agent", id, "MODEL_OVERRIDE", "gpt-6.1-sol");
    await setRow("agent", id, "REASONING_EFFORT_OVERRIDE", "xhigh");
    const repo = await createSwarmRepo({
      url: `https://github.com/${REPO}`,
      name: "backcompat-repo",
    });
    return { id, repoId: repo.id };
  }

  test("repo model and effort: the task runs the repo's, as before", async () => {
    const { id, repoId } = await agentAndRepo("bc-repo-both");
    await setRow("repo", repoId, "MODEL_OVERRIDE", "gpt-5.6-luna");
    await setRow("repo", repoId, "REASONING_EFFORT_OVERRIDE", "low");

    const { before, after } = await beforeAndAfterMigration(id, REPO);
    expect(before).toEqual({ model: "gpt-5.6-luna", effort: "low" });
    expect(after).toEqual(before);
  });

  test("repo effort only: the agent's model with the repo's effort", async () => {
    const { id, repoId } = await agentAndRepo("bc-repo-effort");
    await setRow("repo", repoId, "REASONING_EFFORT_OVERRIDE", "low");

    const { before, after } = await beforeAndAfterMigration(id, REPO);
    expect(before).toEqual({ model: "gpt-6.1-sol", effort: "low" });
    expect(after).toEqual(before);
  });

  test("repo model only: the repo's model with the agent's effort", async () => {
    const { id, repoId } = await agentAndRepo("bc-repo-model");
    await setRow("repo", repoId, "MODEL_OVERRIDE", "gpt-5.6-luna");

    const { before, after } = await beforeAndAfterMigration(id, REPO);
    expect(before).toEqual({ model: "gpt-5.6-luna", effort: "xhigh" });
    expect(after).toEqual(before);
  });

  test("withheld repo rows remove the agent's values, as before", async () => {
    const { id, repoId } = await agentAndRepo("bc-repo-withheld");
    await setRow("repo", repoId, "MODEL_OVERRIDE", "gpt-5.6-luna", false);
    await setRow("repo", repoId, "REASONING_EFFORT_OVERRIDE", "low", false);

    const { before, after } = await beforeAndAfterMigration(id, REPO);
    expect(before).toEqual({ model: null, effort: null });
    expect(after).toEqual(before);
  });

  test("control: a task outside the repo, or a repo with no override, runs the default", async () => {
    const { id } = await agentAndRepo("bc-repo-none");
    const { before, after } = await beforeAndAfterMigration(id, REPO);
    expect(before).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
    expect(after).toEqual(before);
    expect(await workerSelection(id)).toEqual(before);
  });

  test("a task's own profile still beats repo config", async () => {
    const { id, repoId } = await agentAndRepo("bc-repo-task-profile");
    await setRow("repo", repoId, "MODEL_OVERRIDE", "gpt-5.6-luna");
    await setRow("repo", repoId, "REASONING_EFFORT_OVERRIDE", "low");
    getDb().exec(agentOverrideMigrationSql());

    expect(await workerSelection(id, REPO, "codex-gpt-6.1-sol-xhigh")).toEqual({
      model: "gpt-6.1-sol",
      effort: "xhigh",
    });
  });
});
