// POST /api/tasks takes an optional `vcsRepo`, resolved against swarm_repos the way the
// worker's fetchRepoConfig resolves it, and stored as the repo path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { closeDb, createAgent, createSwarmRepo, getTaskById, initDb } from "../be/db";
import { vcsRepoId } from "../be/model-profile-check";
import { handleTasks } from "../http/tasks";
import { setRequestAuth } from "../utils/request-auth-context";
import { vcsRepoPath } from "../utils/vcs-repo-match";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-create-task-vcs-repo.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => undefined);
  }
}

let server: Server;
let baseUrl = "";
let leadId = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  leadId = (await createAgent({ name: "vcs-repo-lead", isLead: true, status: "idle" })).id;
  await createSwarmRepo({ url: "https://github.com/acme/widgets.git", name: "widgets" });
  await createSwarmRepo({ url: "git@gitlab.com:team/sub/tools.git", name: "tools" });

  server = createServer((req, res) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "create-task-vcs-repo-test" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    void (async () => {
      res.setHeader("Content-Type", "application/json");
      if (await handleTasks(req, res, segments, url.searchParams, undefined)) return;
      res.writeHead(404);
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

async function createTask(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: "repo task",
      agentId: leadId,
      routingReason: "human_pinned",
      ...body,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("vcsRepoPath", () => {
  test("strips scheme, host and scp prefix", () => {
    expect(vcsRepoPath("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(vcsRepoPath("ssh://git@github.com/acme/widgets")).toBe("acme/widgets");
    expect(vcsRepoPath("git@gitlab.com:team/sub/tools.git")).toBe("team/sub/tools");
    expect(vcsRepoPath("acme/widgets/")).toBe("acme/widgets");
    expect(vcsRepoPath("/srv/checkout")).toBe("/srv/checkout");
  });
});

describe("POST /api/tasks vcsRepo", () => {
  test("a registered repo by shorthand or URL is stored as its repo path", async () => {
    for (const [input, stored] of [
      ["acme/widgets", "acme/widgets"],
      ["https://github.com/acme/widgets.git", "acme/widgets"],
      ["git@gitlab.com:team/sub/tools.git", "team/sub/tools"],
    ]) {
      const { status, body } = await createTask({ vcsRepo: input });
      expect(status).toBe(201);
      expect(body.vcsRepo).toBe(stored);
      expect((await getTaskById(body.id))?.vcsRepo).toBe(stored);
      // The stored form resolves back to a registered repo, as the worker's lookup does.
      expect(await vcsRepoId(stored)).not.toBeNull();
    }
  });

  test("an unregistered repo is a 400", async () => {
    for (const input of ["acme/unknown", "other/widgets", "https://example.com/acme/widgets"]) {
      const { status, body } = await createTask({ vcsRepo: input });
      expect(status).toBe(400);
      expect(body.error).toContain("Unknown repo");
    }
  });

  test("no vcsRepo keeps today's behavior", async () => {
    const { status, body } = await createTask({});
    expect(status).toBe(201);
    expect(body.vcsRepo ?? null).toBeNull();
  });
});
