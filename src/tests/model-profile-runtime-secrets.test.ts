// An agent's default profile yields to a repo-scoped MODEL_OVERRIDE /
// REASONING_EFFORT_OVERRIDE only when that row reaches the claiming worker's
// env. A runtime-token worker without `config.read.secrets` never receives
// secret repo rows from `/api/config/resolved`, so for it they must not
// suppress the profile. Runs the real auth, `/api/poll` claim,
// `/api/config/resolved` and `fetchResolvedEnv` over HTTP.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  closeDb,
  createAgent,
  createSwarmRepo,
  createTaskExtended,
  getDbClient,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { createModelProfile } from "../be/db/model-profiles";
import { upsertRuntimeInstance } from "../be/multi-runtime";
import { mintRuntimeToken } from "../be/users";
import { fetchResolvedEnv } from "../commands/runner";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { handlePoll } from "../http/poll";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const key = "model-profile-runtime-secrets-key";
const REPO = "desplega-ai/runtime-secret-repo";
const oldKey = process.env.AGENT_SWARM_API_KEY;
const oldEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
let server: Server;
let baseUrl = "";

async function dispatch(req: IncomingMessage, res: ServerResponse) {
  if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, key)) return;
  const segments = getPathSegments(req.url ?? "");
  const query = parseQueryParams(req.url ?? "");
  const id = req.headers["x-agent-id"] as string | undefined;
  if (await handlePoll(req, res, segments, query, id)) return;
  if (await handleConfig(req, res, segments, query)) return;
  res.writeHead(404).end();
}

beforeAll(async () => {
  process.env.AGENT_SWARM_API_KEY = key;
  process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  initDb(":memory:");
  server = createServer((req, res) => {
    dispatch(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  if (oldKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
  else process.env.AGENT_SWARM_API_KEY = oldKey;
  if (oldEncryptionKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = oldEncryptionKey;
});

beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM swarm_config");
  await client.run("DELETE FROM swarm_repos");
  await client.run("DELETE FROM model_profiles");
});

type Credential = "runtime-token" | "operator-key";

/**
 * An agent whose default profile (`gpt-5.6-sol`, high) differs from its
 * retained MODEL_OVERRIDE / REASONING_EFFORT_OVERRIDE (`gpt-6.1-sol`, xhigh),
 * plus the task's repo.
 */
async function setup(name: string, isLead = false) {
  const agent = await createAgent({ name, isLead, status: "idle", harnessProvider: "codex" });
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agent.id,
    key: "MODEL_OVERRIDE",
    value: "gpt-6.1-sol",
  });
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agent.id,
    key: "REASONING_EFFORT_OVERRIDE",
    value: "xhigh",
  });
  await createModelProfile({
    name: `${name}-profile`,
    harness: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agent.id,
    key: "MODEL_PROFILE",
    value: `${name}-profile`,
    exportToEnv: false,
  });
  const repo = await createSwarmRepo({
    name: "runtime-secret-repo",
    url: `https://github.com/${REPO}`,
  });
  return { agentId: agent.id, repoId: repo.id };
}

async function repoRow(repoId: string, key: string, value: string, isSecret: boolean) {
  await upsertSwarmConfig({ scope: "repo", scopeId: repoId, key, value, isSecret });
}

/**
 * Claim one task as the worker and return what it starts: the claim's
 * `resolvedModel`, else the env's MODEL_OVERRIDE, and the trigger's `effort`,
 * else REASONING_EFFORT_OVERRIDE (runner.ts spawnProviderProcess).
 */
async function workerSelection(
  agentId: string,
  repoId: string,
  credential: Credential,
): Promise<{ model: string | null; effort: string | null }> {
  await createTaskExtended("work", { agentId, vcsRepo: REPO });
  const runtimeId = crypto.randomUUID();
  let bearer = key;
  const headers: Record<string, string> = { "X-Agent-ID": agentId };
  if (credential === "runtime-token") {
    await upsertRuntimeInstance({ id: runtimeId, agentId, reportedSlots: 1 });
    bearer = (await mintRuntimeToken(agentId, runtimeId, 60_000)).plaintext;
    headers["X-Runtime-Instance-ID"] = runtimeId;
  }
  const response = await fetch(`${baseUrl}/api/poll`, {
    headers: { ...headers, Authorization: `Bearer ${bearer}` },
  });
  expect(response.status).toBe(200);
  const polled = (await response.json()) as {
    trigger: { task: { id: string; resolvedModel?: string; effort?: string } } | null;
  };
  const task = polled.trigger?.task;
  if (!task) throw new Error("nothing claimed");
  const { env } = await fetchResolvedEnv(baseUrl, bearer, agentId, {}, task.resolvedModel, {
    repoId,
    taskId: task.id,
    provider: "codex",
  });
  await getDbClient().run("UPDATE agent_tasks SET status = 'completed'");
  return {
    model: task.resolvedModel || env.MODEL_OVERRIDE || null,
    effort: task.effort || env.REASONING_EFFORT_OVERRIDE || null,
  };
}

describe("repo overrides a runtime-token worker cannot read do not beat its default profile", () => {
  test("secret repo model and effort: the worker runs its profile, not its retained overrides", async () => {
    const { agentId, repoId } = await setup("secret-both");
    await repoRow(repoId, "MODEL_OVERRIDE", "gpt-5.6-luna", true);
    await repoRow(repoId, "REASONING_EFFORT_OVERRIDE", "low", true);

    expect(await workerSelection(agentId, repoId, "runtime-token")).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
    });
  });

  test("secret repo model only: profile model and effort", async () => {
    const { agentId, repoId } = await setup("secret-model");
    await repoRow(repoId, "MODEL_OVERRIDE", "gpt-5.6-luna", true);

    expect(await workerSelection(agentId, repoId, "runtime-token")).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
    });
  });

  test("secret repo effort only: profile model and effort", async () => {
    const { agentId, repoId } = await setup("secret-effort");
    await repoRow(repoId, "REASONING_EFFORT_OVERRIDE", "low", true);

    expect(await workerSelection(agentId, repoId, "runtime-token")).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
    });
  });

  test("control: a public repo row still beats the profile for a runtime-token worker", async () => {
    const { agentId, repoId } = await setup("public-both");
    await repoRow(repoId, "MODEL_OVERRIDE", "gpt-5.6-luna", false);
    await repoRow(repoId, "REASONING_EFFORT_OVERRIDE", "low", false);

    expect(await workerSelection(agentId, repoId, "runtime-token")).toEqual({
      model: "gpt-5.6-luna",
      effort: "low",
    });
  });

  test("a worker that reads secrets gets the secret repo row, so it still wins", async () => {
    const operator = await setup("operator-secret");
    await repoRow(operator.repoId, "MODEL_OVERRIDE", "gpt-5.6-luna", true);
    await repoRow(operator.repoId, "REASONING_EFFORT_OVERRIDE", "low", true);
    expect(await workerSelection(operator.agentId, operator.repoId, "operator-key")).toEqual({
      model: "gpt-5.6-luna",
      effort: "low",
    });

    await getDbClient().run("DELETE FROM swarm_repos");
    const lead = await setup("lead-secret", true);
    await repoRow(lead.repoId, "MODEL_OVERRIDE", "gpt-5.6-luna", true);
    await repoRow(lead.repoId, "REASONING_EFFORT_OVERRIDE", "low", true);
    expect(await workerSelection(lead.agentId, lead.repoId, "runtime-token")).toEqual({
      model: "gpt-5.6-luna",
      effort: "low",
    });
  });
});
