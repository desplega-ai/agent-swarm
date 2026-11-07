// Model groups (migration 301): REST CRUD and its RBAC gate, the shared name
// space with profiles, reference triggers and delete guards, the atomic member
// rewrite, and the four seeded tier groups.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  getDbClient,
  initDb,
} from "../be/db";
import { createModelGroup, getModelGroupByName, listModelGroups } from "../be/db/model-groups";
import { createModelProfile } from "../be/db/model-profiles";
import { seedModelGroups } from "../be/seed-model-groups";
import { seedModelProfiles } from "../be/seed-model-profiles";
import { handleModelGroups } from "../http/model-groups";
import { handleModelProfiles } from "../http/model-profiles";
import { DEFAULT_MODEL_TIER_MAP, type ModelGroup, type User } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-model-groups-api.sqlite";
const LEAD_ID = "51111111-1111-4111-8111-111111111111";
const WORKER_ID = "52222222-2222-4222-8222-222222222222";
const USER_ID = "53333333-3333-4333-8333-333333333333";

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

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  await getDbClient().run(
    "INSERT INTO users (id, name, createdAt, lastUpdatedAt) VALUES (?, 'Group User', '2026-01-01', '2026-01-01')",
    [USER_ID],
  );
  await createAgent({ id: LEAD_ID, name: "mg-lead", isLead: true, status: "idle" });
  await createAgent({
    id: WORKER_ID,
    name: "mg-worker",
    isLead: false,
    status: "idle",
    harnessProvider: "claude",
  });

  server = createServer((req, res) => {
    const kind = req.headers["x-test-auth"];
    if (kind === "operator") setRequestAuth(req, { kind: "operator", fingerprint: "test" });
    if (kind === "user") {
      setRequestAuth(req, { kind: "user", userId: USER_ID, user: { id: USER_ID } as User });
    }
    const header = req.headers["x-agent-id"];
    const agentId = Array.isArray(header) ? header[0] : header;
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    void (async () => {
      for (const handle of [handleModelGroups, handleModelProfiles]) {
        if (await handle(req, res, segments, url.searchParams, agentId)) return;
      }
      res.statusCode = 404;
      res.end("{}");
    })();
  });
  baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  server.close();
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  // References first: migration 301's triggers and foreign keys refuse the rest.
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM scheduled_tasks");
  await getDbClient().run("DELETE FROM model_groups");
  await getDbClient().run("DELETE FROM model_profiles");
  for (const [name, harness, model] of [
    ["claude-fast", "claude", "haiku"],
    ["claude-deep", "claude", "opus"],
    ["codex-fast", "codex", "gpt-5"],
  ] as const) {
    await createModelProfile({ name, harness, model, allowCustomModel: true });
  }
});

function call(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = { "x-test-auth": "operator" },
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe("group CRUD", () => {
  test("operator creates, reads, lists, describes, reorders and deletes a group", async () => {
    const created = await call("POST", "/api/model-groups", {
      name: "fast",
      description: "Fast first",
      members: ["claude-fast", "codex-fast"],
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: "fast",
      description: "Fast first",
      seededFrom: null,
      members: ["claude-fast", "codex-fast"],
    });

    const listed = (await (await call("GET", "/api/model-groups", undefined)).json()) as {
      groups: ModelGroup[];
    };
    expect(listed.groups.map((g) => [g.name, g.members])).toEqual([
      ["fast", ["claude-fast", "codex-fast"]],
    ]);

    const patched = await call("PATCH", "/api/model-groups/fast", { description: null });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ description: null });

    const reordered = await call("PUT", "/api/model-groups/fast/members", {
      members: ["codex-fast", "claude-deep", "claude-fast"],
    });
    expect(reordered.status).toBe(200);
    expect(((await reordered.json()) as ModelGroup).members).toEqual([
      "codex-fast",
      "claude-deep",
      "claude-fast",
    ]);
    const positions = await getDbClient().query<{ position: number; profileName: string }>(
      `SELECT m.position, m.profileName FROM model_group_members m
         JOIN model_groups g ON g.id = m.groupId WHERE g.name = 'fast' ORDER BY m.position`,
    );
    expect(positions).toEqual([
      { position: 0, profileName: "codex-fast" },
      { position: 1, profileName: "claude-deep" },
      { position: 2, profileName: "claude-fast" },
    ]);

    const deleted = await call("DELETE", "/api/model-groups/fast", undefined);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect((await call("GET", "/api/model-groups/fast", undefined)).status).toBe(404);
    expect((await call("DELETE", "/api/model-groups/fast", undefined)).status).toBe(404);
    // Members cascade with the group.
    const left = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM model_group_members",
    );
    expect(left?.n).toBe(0);
  });

  test("the lead, the operator and dashboard users write; workers only read", async () => {
    const body = (name: string) => ({ name, members: ["claude-fast"] });
    expect((await call("POST", "/api/model-groups", body("by-op"))).status).toBe(201);
    expect(
      (await call("POST", "/api/model-groups", body("by-lead"), { "x-agent-id": LEAD_ID })).status,
    ).toBe(201);
    expect(
      (await call("POST", "/api/model-groups", body("by-user"), { "x-test-auth": "user" })).status,
    ).toBe(201);
    const audit = await getDbClient().get<{ created_by: string | null }>(
      "SELECT created_by FROM model_groups WHERE name = 'by-user'",
    );
    expect(audit?.created_by).toBe(USER_ID);

    const worker = { "x-agent-id": WORKER_ID };
    const denied = await call("POST", "/api/model-groups", body("by-worker"), worker);
    expect(denied.status).toBe(403);
    expect(await errorOf(denied)).toContain("requires the lead");
    for (const [method, path, payload] of [
      ["PATCH", "/api/model-groups/by-op", { description: "x" }],
      ["PUT", "/api/model-groups/by-op/members", { members: ["codex-fast"] }],
      ["DELETE", "/api/model-groups/by-op", undefined],
    ] as const) {
      expect((await call(method, path, payload, worker)).status).toBe(403);
    }
    expect((await call("GET", "/api/model-groups", undefined, worker)).status).toBe(200);
    expect((await call("GET", "/api/model-groups/by-op", undefined, worker)).status).toBe(200);
    expect((await getModelGroupByName("by-op"))?.members).toEqual(["claude-fast"]);
  });

  test("bad member lists are 400 and leave the group unchanged", async () => {
    expect(
      (await call("POST", "/api/model-groups", { name: "g", members: ["claude-fast"] })).status,
    ).toBe(201);
    for (const [members, needle] of [
      [["claude-fast", "no-such"], "Unknown model profile: no-such"],
      [["claude-fast", "claude-fast"], 'Member "claude-fast" is listed twice'],
    ] as const) {
      const put = await call("PUT", "/api/model-groups/g/members", { members });
      expect(put.status).toBe(400);
      expect(await errorOf(put)).toContain(needle);
    }
    expect((await call("PUT", "/api/model-groups/g/members", { members: [] })).status).toBe(400);
    expect(
      (await call("POST", "/api/model-groups", { name: "h", members: ["ghost"] })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/model-groups", { name: "Bad Name", members: ["claude-fast"] }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/model-groups", { name: "g", members: ["codex-fast"] })).status,
    ).toBe(409);
    expect(
      (await call("PUT", "/api/model-groups/none/members", { members: ["codex-fast"] })).status,
    ).toBe(404);
    expect((await getModelGroupByName("g"))?.members).toEqual(["claude-fast"]);
    expect(await getModelGroupByName("h")).toBeNull();
  });
});

describe("one name space for groups and profiles", () => {
  test("a group may not take a profile's name", async () => {
    const response = await call("POST", "/api/model-groups", {
      name: "claude-fast",
      members: ["codex-fast"],
    });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toContain("is a model profile");
  });

  test("a profile may not take a group's name", async () => {
    await createModelGroup({ name: "smart-ish", members: ["claude-deep"] });
    const response = await call("POST", "/api/model-profiles", {
      name: "smart-ish",
      harness: "claude",
      model: "opus",
    });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toContain("is a model group");
  });

  test("the database refuses either order without the API", async () => {
    await createModelGroup({ name: "g1", members: ["claude-deep"] });
    await expect(
      createModelProfile({ name: "g1", harness: "claude", model: "opus" }),
    ).rejects.toThrow("model-name-taken:");
    await expect(
      getDbClient().run(
        "INSERT INTO model_groups (name, createdAt, lastUpdatedAt) VALUES ('codex-fast', 'x', 'x')",
      ),
    ).rejects.toThrow("model-name-taken:");
  });
});

describe("references and delete guards", () => {
  test("tasks and schedules may only name a group that exists", async () => {
    const task = await createTaskExtended("holder", { agentId: WORKER_ID });
    await expect(
      getDbClient().run("UPDATE agent_tasks SET modelGroup = 'ghost' WHERE id = ?", [task.id]),
    ).rejects.toThrow("model-group-missing:");
    const schedule = await createScheduledTask({
      name: "mg-sched",
      cronExpression: "0 * * * *",
      taskTemplate: "x",
    });
    await expect(
      getDbClient().run("UPDATE scheduled_tasks SET modelGroup = 'ghost' WHERE id = ?", [
        schedule.id,
      ]),
    ).rejects.toThrow("model-group-missing:");
  });

  test("a group a task holds or a schedule names is not deleted", async () => {
    await createModelGroup({ name: "busy", members: ["claude-fast"] });
    const task = await createTaskExtended("holder", { agentId: WORKER_ID });
    await getDbClient().run("UPDATE agent_tasks SET modelGroup = 'busy' WHERE id = ?", [task.id]);
    let response = await call("DELETE", "/api/model-groups/busy", undefined);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toContain("held by 1 unfinished");

    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?",
      [new Date().toISOString(), task.id],
    );
    const schedule = await createScheduledTask({
      name: "busy-sched",
      cronExpression: "0 * * * *",
      taskTemplate: "x",
    });
    await getDbClient().run("UPDATE scheduled_tasks SET modelGroup = 'busy' WHERE id = ?", [
      schedule.id,
    ]);
    response = await call("DELETE", "/api/model-groups/busy", undefined);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toContain(schedule.id);

    await getDbClient().run("UPDATE scheduled_tasks SET modelGroup = NULL WHERE id = ?", [
      schedule.id,
    ]);
    expect((await call("DELETE", "/api/model-groups/busy", undefined)).status).toBe(200);
  });

  test("a profile that is a group member is not deleted", async () => {
    await createModelGroup({ name: "pair", members: ["claude-fast", "codex-fast"] });
    const response = await call("DELETE", "/api/model-profiles/codex-fast", undefined);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toContain("a member of 1 model group(s) (pair)");
    // The foreign key backs the API guard.
    await expect(
      getDbClient().run("DELETE FROM model_profiles WHERE name = 'codex-fast'"),
    ).rejects.toThrow("FOREIGN KEY");
    await call("PUT", "/api/model-groups/pair/members", { members: ["claude-fast"] });
    expect((await call("DELETE", "/api/model-profiles/codex-fast", undefined)).status).toBe(200);
  });
});

describe("member rewrite atomicity", () => {
  test("concurrent reorders each land whole; the last one wins", async () => {
    const orders = [
      ["claude-fast", "claude-deep", "codex-fast"],
      ["codex-fast", "claude-fast", "claude-deep"],
      ["claude-deep", "codex-fast"],
      ["codex-fast"],
      ["claude-deep", "claude-fast", "codex-fast"],
    ];
    await createModelGroup({ name: "race", members: ["claude-fast"] });
    const responses = await Promise.all(
      [...orders, ...orders].map((members) =>
        call("PUT", "/api/model-groups/race/members", { members }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(orders.length * 2).fill(200));
    const rows = await getDbClient().query<{ position: number; profileName: string }>(
      `SELECT m.position, m.profileName FROM model_group_members m
         JOIN model_groups g ON g.id = m.groupId WHERE g.name = 'race' ORDER BY m.position`,
    );
    expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i));
    expect(orders).toContainEqual(rows.map((r) => r.profileName));
  });
});

describe("seeded tier groups", () => {
  async function reseedProfiles(): Promise<void> {
    await getDbClient().run("DELETE FROM model_groups");
    await getDbClient().run("DELETE FROM model_profiles");
    await seedModelProfiles();
  }

  test("boot seeds smol, regular, smart and ultra from the tier profiles, once", async () => {
    await reseedProfiles();
    expect(await seedModelGroups()).toBe(4);
    const groups = await listModelGroups();
    expect(groups.map((g) => g.name)).toEqual(["regular", "smart", "smol", "ultra"]);
    const smol = groups.find((g) => g.name === "smol");
    expect(smol?.description).toBe("Cheap");
    expect(smol?.seededFrom).toBe("tier:smol");
    // One `<harness>-<tier>` member per harness that has a tier mapping, in
    // the seed order: claude first, so no task changes model on any harness.
    const harnesses = Object.entries(DEFAULT_MODEL_TIER_MAP)
      .filter(([, tiers]) => tiers?.smart)
      .map(([harness]) => harness);
    for (const group of groups) {
      expect(group.members[0]).toBe(`claude-${group.name}`);
      expect(group.members.slice(0, 3)).toEqual([
        `claude-${group.name}`,
        `claude-managed-${group.name}`,
        `codex-${group.name}`,
      ]);
      expect([...group.members].sort()).toEqual(
        harnesses.map((harness) => `${harness}-${group.name}`).sort(),
      );
    }
    expect(await seedModelGroups()).toBe(0);
  });

  test("an edited seed survives the next boot", async () => {
    await reseedProfiles();
    await seedModelGroups();
    await call("PUT", "/api/model-groups/ultra/members", {
      members: ["claude-ultra", "codex-ultra"],
    });
    await call("PATCH", "/api/model-groups/ultra", { description: "Best" });
    expect(await seedModelGroups()).toBe(0);
    expect(await getModelGroupByName("ultra")).toMatchObject({
      description: "Best",
      members: ["claude-ultra", "codex-ultra"],
    });
    const deleted = await call("DELETE", "/api/model-groups/ultra", undefined);
    expect(deleted.status).toBe(409);
    expect(await errorOf(deleted)).toContain("shipped tier group");
  });

  test("a tier name a profile already took is skipped, and the other tiers still seed", async () => {
    await reseedProfiles();
    await createModelProfile({ name: "smart", harness: "claude", model: "opus" });
    expect(await seedModelGroups()).toBe(3);
    expect(await getModelGroupByName("smart")).toBeNull();
  });
});
