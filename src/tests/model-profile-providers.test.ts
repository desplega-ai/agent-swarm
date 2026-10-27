// Model profiles on the OpenAI-compatible providers pi and opencode run
// (NaN `nan/*`, Helmcode `helmcode/*`, Vercel AI Gateway `vercel/<vendor>/*`):
// validation over HTTP, the harness filter, claim, the credential the worker
// then picks for the claimed model, and migration 220's MODEL_OVERRIDE
// conversion.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getDbClient,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { getAgentDefaultProfileName } from "../be/db/model-profiles";
import { fetchResolvedEnv } from "../commands/runner";
import { handleModelProfiles } from "../http/model-profiles";
import { handlePoll } from "../http/poll";
import { ModelProfileNameSchema } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-model-profile-providers.sqlite";

/** One catalog model per provider, the key the worker must pick for it, and a level it supports. */
const PROVIDERS = [
  { provider: "nan", model: "nan/glm5.3", keyType: "NAN_API_KEY", effort: "high" },
  {
    provider: "helmcode",
    model: "helmcode/deepseek-v4-flash",
    keyType: "HELMCODE_API_KEY",
    effort: "off",
  },
  {
    provider: "vercel",
    model: "vercel/anthropic/claude-sonnet-4.6",
    keyType: "AI_GATEWAY_API_KEY",
    effort: "medium",
  },
] as const;

const HARNESSES = ["pi", "opencode"] as const;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let server: Server;
let baseUrl = "";
let configServer: ReturnType<typeof Bun.serve>;
let configUrl = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createServer((req, res) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "test" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    void (async () => {
      if (await handleModelProfiles(req, res, segments, url.searchParams, undefined)) return;
      res.statusCode = 404;
      res.end("{}");
    })();
  });
  baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
  // Every provider key is configured, so the pick shows which one the model routes to.
  configServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/api/config/resolved") {
        return Response.json({
          configs: [
            { key: "OPENROUTER_API_KEY", value: "fixture-openrouter" },
            { key: "NAN_API_KEY", value: "fixture-nan" },
            { key: "HELMCODE_API_KEY", value: "fixture-helmcode" },
            { key: "AI_GATEWAY_API_KEY", value: "fixture-gateway" },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  configUrl = configServer.url.toString().replace(/\/$/, "");
});

afterAll(async () => {
  server.close();
  configServer.stop(true);
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM swarm_config");
  await client.run("DELETE FROM agents");
  await client.run("DELETE FROM model_profiles");
});

function post(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/model-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

type ClaimedTask = { resolvedModel?: string; modelSource?: string; effort?: string };

async function claim(agentId: string): Promise<ClaimedTask> {
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
  const trigger = (JSON.parse(body) as { trigger: { task: ClaimedTask } | null }).trigger;
  if (!trigger) throw new Error("nothing claimed");
  return trigger.task;
}

describe("a profile accepts every provider pi and opencode run", () => {
  for (const harness of HARNESSES) {
    for (const { provider, model, effort } of PROVIDERS) {
      test(`${harness} + ${provider}: created with a supported effort and listed under its harness`, async () => {
        const name = `${harness}-${provider}`;
        const created = await post({ name, harness, model, effort });
        expect(created.status).toBe(201);
        expect(await created.json()).toMatchObject({ name, harness, model, effort });

        const listed = await fetch(`${baseUrl}/api/model-profiles?harness=${harness}`);
        const { profiles } = (await listed.json()) as { profiles: { name: string }[] };
        expect(profiles.map((p) => p.name)).toEqual([name]);
      });
    }
  }

  test("an id the provider's catalog lacks is 400 unless allowCustomModel", async () => {
    for (const model of ["nan/no-such-model", "helmcode/no-such-model", "vercel/acme/no-such"]) {
      const refused = await post({ name: "pi-unknown", harness: "pi", model });
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toContain("not in the model catalog");
    }
    const custom = await post({
      name: "pi-gateway-custom",
      harness: "pi",
      model: "vercel/acme/fresh-launch",
      allowCustomModel: true,
    });
    expect(custom.status).toBe(201);
  });

  test("a provider model on a harness that cannot run it is 400", async () => {
    for (const harness of ["claude", "codex"]) {
      for (const { model } of PROVIDERS) {
        const refused = await post({ name: `${harness}-x`, harness, model });
        expect(refused.status).toBe(400);
        expect(await errorOf(refused)).toContain(`does not run on the ${harness} harness`);
      }
    }
  });

  test("an effort the model does not list is 400", async () => {
    const refused = await post({
      name: "pi-nan-off",
      harness: "pi",
      model: "nan/glm5.3",
      // glm5.3 lists minimal through max, but no none or toggle, so off is unsupported.
      effort: "off",
    });
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toContain("not supported");
  });
});

describe("claim hands the provider model to the worker, which picks that provider's key", () => {
  for (const harness of HARNESSES) {
    for (const { provider, model, keyType, effort } of PROVIDERS) {
      test(`${harness} + ${provider}`, async () => {
        const name = `${harness}-${provider}`;
        expect((await post({ name, harness, model, effort })).status).toBe(201);
        const agent = await createAgent({
          name: `w-${name}`,
          isLead: false,
          status: "idle",
          harnessProvider: harness,
        });
        await createTaskExtended("work", { agentId: agent.id, profile: name });

        const task = await claim(agent.id);
        expect(task).toMatchObject({ resolvedModel: model, modelSource: "profile:task", effort });

        const { credentialSelections } = await fetchResolvedEnv(
          configUrl,
          "key",
          agent.id,
          {},
          task.resolvedModel,
          { provider: harness },
        );
        expect(credentialSelections.map((s) => s.keyType)).toEqual([keyType]);
      });
    }
  }
});

describe("migration 220 converts provider MODEL_OVERRIDEs", () => {
  function agentOverrideMigrationSql(): string {
    const sql = readFileSync(
      join(import.meta.dir, "../be/migrations/220_model_profiles.sql"),
      "utf8",
    );
    return sql.slice(sql.indexOf("CREATE TEMP TABLE _model_profile_overrides"));
  }

  test("each becomes a valid, harness-scoped default the next claim runs", async () => {
    const cases = [
      { harness: "pi", model: "nan/glm5.3", effort: "high", name: "pi-nan-glm5.3-high" },
      {
        harness: "opencode",
        model: "helmcode/deepseek-v4-flash",
        effort: null,
        name: "opencode-helmcode-deepseek-v4-flash",
      },
      {
        harness: "pi",
        model: "vercel/anthropic/claude-sonnet-4.6",
        effort: "medium",
        name: "pi-vercel-anthropic-claude-sonnet-4.6-medium",
      },
    ] as const;
    const agents: string[] = [];
    for (const c of cases) {
      const agent = await createAgent({
        name: `m-${c.name}`,
        isLead: false,
        status: "idle",
        harnessProvider: c.harness,
      });
      agents.push(agent.id);
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: agent.id,
        key: "MODEL_OVERRIDE",
        value: c.model,
      });
      if (c.effort) {
        await upsertSwarmConfig({
          scope: "agent",
          scopeId: agent.id,
          key: "REASONING_EFFORT_OVERRIDE",
          value: c.effort,
        });
      }
    }

    getDb().exec(agentOverrideMigrationSql());

    for (const [i, c] of cases.entries()) {
      const agentId = agents[i] as string;
      expect(await getAgentDefaultProfileName(agentId)).toBe(c.name);
      // The generated name passes the API's name rule, so the profile stays addressable.
      expect(ModelProfileNameSchema.safeParse(c.name).success).toBe(true);
      const fetched = await fetch(`${baseUrl}/api/model-profiles/${c.name}`);
      expect(await fetched.json()).toMatchObject({
        name: c.name,
        harness: c.harness,
        model: c.model,
        effort: c.effort,
      });
      await createTaskExtended("work", { agentId });
      const task = await claim(agentId);
      expect(task).toMatchObject({ resolvedModel: c.model, modelSource: "profile:agent-default" });
      if (c.effort) expect(task.effort).toBe(c.effort);
    }
  });
});
