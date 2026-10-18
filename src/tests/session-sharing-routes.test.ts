import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  createAgent,
  createSessionLogs,
  createSteeringMessage,
  createTaskExtended,
  createUser,
  initDb,
  insertTaskAttachment,
} from "../be/db";
import { setSessionShares } from "../be/session-shares";
import { mintToken } from "../be/users";
import { getFileStorageProvider, resetFileStorageProvider } from "../fs/registry";
import { handleActiveSessions } from "../http/active-sessions";
import { handleAgentsRest } from "../http/agents";
import { handleCore } from "../http/core";
import { handleEvents } from "../http/events";
import { handleFs } from "../http/fs";
import { handleSessionData } from "../http/session-data";
import { handleStats } from "../http/stats";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { beginRequestAuthScope } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

// Every route here returns task content. A minted `aswt_` token for a user with
// no share must not read a private session through any of them, even when it
// names the assigned agent in X-Agent-ID. The owner, a shared user and the
// agent itself (operator key + X-Agent-ID) keep reading it.

const OPERATOR_KEY = "session-routes-operator-key";
const HANDLERS = [
  handleTasks,
  handleSessionData,
  handleEvents,
  handleFs,
  handleActiveSessions,
  handleStats,
  handleAgentsRest,
];

type Who = "owner" | "sharee" | "viewer" | "agent";

const server = createServer(async (req, res) => {
  try {
    beginRequestAuthScope();
    const agentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, agentId, OPERATOR_KEY)) return;
    const segments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    for (const handler of HANDLERS) {
      if (await handler(req, res, segments, query, agentId)) return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});

let port: number;
let agent: { id: string };
let owner: { id: string };
let sharee: { id: string };
const tokens = {} as Record<Exclude<Who, "agent">, string>;
let filesDir: string;

beforeAll(async () => {
  filesDir = await mkdtemp(join(tmpdir(), "session-routes-"));
  process.env.AGENT_FS_LOCAL_DIR = filesDir;
  delete process.env.AGENT_FS_API_URL;
  delete process.env.API_AGENT_FS_API_KEY;
  delete process.env.AGENT_FS_API_KEY;
  resetFileStorageProvider();
  initDb(":memory:");
  agent = await createAgent({ name: "Worker", isLead: false, status: "idle" });
  owner = await createUser({ name: "Owner" });
  sharee = await createUser({ name: "Sharee" });
  const viewer = await createUser({ name: "Viewer" });
  const system = { kind: "system", id: "test" } as const;
  tokens.owner = (await mintToken(owner.id, "test", system)).plaintext;
  tokens.sharee = (await mintToken(sharee.id, "test", system)).plaintext;
  tokens.viewer = (await mintToken(viewer.id, "test", system)).plaintext;
  port = await listenOnFreePort(server, "127.0.0.1");
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  resetFileStorageProvider();
  await rm(filesDir, { recursive: true, force: true });
});

/** An owned root and descendant on `agent`, shared read-only with `sharee` and nobody else. */
async function privateSession(label: string) {
  const root = await createTaskExtended(`${label} root`, {
    requestedByUserId: owner.id,
    agentId: agent.id,
    source: "ui",
  });
  const child = await createTaskExtended(`${label} child`, {
    requestedByUserId: owner.id,
    agentId: agent.id,
    parentTaskId: root.id,
    source: "ui",
  });
  await setSessionShares(
    { id: root.id, requestedByUserId: owner.id },
    { everyone: "none", users: [{ userId: sharee.id, access: "read" }] },
    owner.id,
  );
  return { root, child };
}

async function get(path: string, who: Who, withAgentHeader = false) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${who === "agent" ? OPERATOR_KEY : tokens[who]}`,
  };
  if (who === "agent" || withAgentHeader) headers["X-Agent-ID"] = agent.id;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.text() };
}

/**
 * The unshared viewer gets `deniedStatus` without `secret`; the owner, the
 * sharee and the agent read it. `withAgentHeader` makes every user token also
 * name the agent, as a worker-only feed requires.
 */
async function expectPrivate(
  path: string,
  secret: string,
  { deniedStatus, withAgentHeader = false }: { deniedStatus: 200 | 403; withAgentHeader?: boolean },
) {
  const denied = await get(path, "viewer", withAgentHeader);
  expect({ path, status: denied.status }).toEqual({ path, status: deniedStatus });
  expect(denied.body).not.toContain(secret);
  for (const who of ["owner", "sharee", "agent"] as const) {
    const allowed = await get(path, who, withAgentHeader);
    expect({ path, who, status: allowed.status }).toEqual({ path, who, status: 200 });
    expect(allowed.body).toContain(secret);
  }
}

describe("task-content routes respect session read access", () => {
  test("B6 steering: task history, the per-task worker feed and the agent feed", async () => {
    const { child } = await privateSession("steering");
    const secret = "PRIVATE STEERING BODY";
    await createSteeringMessage({
      taskId: child.id,
      body: secret,
      mode: "queue",
      source: "ui",
      createdByKind: "user",
      createdByUserId: owner.id,
    });

    await expectPrivate(`/api/tasks/${child.id}/steering-messages`, secret, { deniedStatus: 403 });
    await expectPrivate(`/api/steering-messages?taskId=${child.id}`, secret, {
      deniedStatus: 403,
      withAgentHeader: true,
    });
    await expectPrivate("/api/steering-messages", secret, {
      deniedStatus: 200,
      withAgentHeader: true,
    });
  });

  test("B7 session logs", async () => {
    const { child } = await privateSession("logs");
    const secret = "PRIVATE HARNESS LOG LINE";
    await createSessionLogs({
      taskId: child.id,
      sessionId: "logs-session",
      iteration: 1,
      cli: "codex",
      lines: [secret],
    });

    await expectPrivate(`/api/tasks/${child.id}/session-logs`, secret, { deniedStatus: 403 });
  });

  test("B8 attachments: list, metadata, raw bytes and signed URL", async () => {
    const { child } = await privateSession("files");
    const secret = "PRIVATE FILE BYTES";
    const provider = getFileStorageProvider();
    const file = await provider.upload(
      { taskId: child.id, name: "secret-notes.txt" },
      Buffer.from(secret),
      { contentType: "text/plain" },
    );
    const attachment = await insertTaskAttachment({
      taskId: child.id,
      agentId: agent.id,
      kind: "shared-fs",
      name: "secret-notes.txt",
      path: file.key,
      providerId: provider.id,
      providerKey: file.key,
    });
    const files = `/api/fs/tasks/${child.id}/files`;

    await expectPrivate(files, "secret-notes.txt", { deniedStatus: 403 });
    await expectPrivate(`${files}/${attachment.id}`, "secret-notes.txt", { deniedStatus: 403 });
    await expectPrivate(`${files}/${attachment.id}/raw`, secret, { deniedStatus: 403 });

    // The local provider cannot sign (501), so this only proves the viewer
    // stops before the provider while the owner reaches it.
    const signed = `${files}/${attachment.id}/signed-url`;
    expect((await get(signed, "viewer")).status).toBe(403);
    expect((await get(signed, "owner")).status).toBe(501);
  });
});
