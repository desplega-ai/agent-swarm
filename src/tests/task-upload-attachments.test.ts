import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { closeDb, createAgent, createUser, getTaskAttachments, initDb } from "../be/db";
import { handleSessions } from "../http/sessions";
import { handleTasks, taskUploadTestHooks } from "../http/tasks";
import { getPathSegments, jsonError, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-task-upload-attachments.sqlite";
const TEST_PORT = 13142;

function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    const pathSegments = getPathSegments(req.url ?? "/");
    const queryParams = parseQueryParams(req.url ?? "/");
    if (await handleTasks(req, res, pathSegments, queryParams, "upload-test-agent")) return;
    if (await handleSessions(req, res, pathSegments, queryParams)) return;
    jsonError(res, "Not found", 404);
  });
}

async function* oversizedMultipartChunks(
  boundary: string,
  fileBytes: number,
): AsyncGenerator<Buffer> {
  yield Buffer.from(
    `${[
      `--${boundary}`,
      'Content-Disposition: form-data; name="payload"',
      "",
      JSON.stringify({ task: "Please inspect this large file", source: "ui" }),
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="large.bin"',
      "Content-Type: application/octet-stream",
      "",
    ].join("\r\n")}\r\n`,
  );
  const chunk = Buffer.alloc(1024 * 1024);
  chunk.fill(97);

  let remaining = fileBytes;
  while (remaining > 0) {
    const size = Math.min(chunk.byteLength, remaining);
    yield size === chunk.byteLength ? chunk : chunk.subarray(0, size);
    remaining -= size;
  }

  yield Buffer.from(`\r\n--${boundary}--\r\n`);
}

function oversizedMultipartRequest(boundary: string, fileBytes: number): IncomingMessage {
  const req = Readable.from(oversizedMultipartChunks(boundary, fileBytes)) as IncomingMessage;
  Object.assign(req, {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  return req;
}

describe("task uploads from sessions composer", () => {
  let server: Server;
  let fakeBinDir: string;
  let oldPath: string | undefined;
  let oldAgentFsBinary: string | undefined;
  let oldSharedOrgId: string | undefined;
  let oldDefaultDriveId: string | undefined;
  const baseUrl = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({
      id: "upload-test-agent",
      name: "Upload Test Agent",
      isLead: true,
      status: "idle",
    });

    fakeBinDir = await mkdtemp(join(tmpdir(), "fake-agent-fs-"));
    const fakeAgentFs = join(fakeBinDir, "agent-fs");
    await writeFile(
      fakeAgentFs,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *" drive list"* ]]; then
  printf '[{"orgId":"shared-org","drives":[{"id":"shared-drive","isDefault":true}]}]\\n'
  exit 0
fi
if [[ "$*" == *" write "* ]]; then
  path=""
  prev=""
  for arg in "$@"; do
    if [[ "$prev" == "write" ]]; then
      path="$arg"
      break
    fi
    prev="$arg"
  done
  printf '{"version":1,"path":"%s","size":12}\\n' "$path"
  exit 0
fi
printf '{}\\n'
`,
      "utf8",
    );
    await chmod(fakeAgentFs, 0o755);

    oldPath = process.env.PATH;
    oldAgentFsBinary = process.env.AGENT_FS_BINARY;
    oldSharedOrgId = process.env.AGENT_FS_SHARED_ORG_ID;
    oldDefaultDriveId = process.env.AGENT_FS_DEFAULT_DRIVE_ID;
    process.env.PATH = `${fakeBinDir}:${oldPath ?? ""}`;
    process.env.AGENT_FS_BINARY = fakeAgentFs;
    process.env.AGENT_FS_SHARED_ORG_ID = "shared-org";
    // A real worker env sets AGENT_FS_DEFAULT_DRIVE_ID, which makes
    // resolveAgentFsTarget() short-circuit to the real default drive and skip the
    // fake `agent-fs drive list`. Clear it so the fake drive is resolved here.
    delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;

    server = createTestServer();
    await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
  });

  afterAll(async () => {
    server.close();
    closeDb();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldAgentFsBinary === undefined) delete process.env.AGENT_FS_BINARY;
    else process.env.AGENT_FS_BINARY = oldAgentFsBinary;
    if (oldSharedOrgId === undefined) delete process.env.AGENT_FS_SHARED_ORG_ID;
    else process.env.AGENT_FS_SHARED_ORG_ID = oldSharedOrgId;
    if (oldDefaultDriveId === undefined) delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
    else process.env.AGENT_FS_DEFAULT_DRIVE_ID = oldDefaultDriveId;
    await rm(fakeBinDir, { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("POST /api/tasks accepts multipart files and stores agent-fs attachments", async () => {
    const user = createUser({ name: "Upload User" });
    const form = new FormData();
    form.set(
      "payload",
      JSON.stringify({
        task: "Please inspect this screenshot",
        source: "ui",
        requestedByUserId: user.id,
      }),
    );
    form.append("files", new File(["fake image bytes"], "screen shot.png", { type: "image/png" }));

    const response = await fetch(`${baseUrl}/api/tasks`, { method: "POST", body: form });

    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      id: string;
      task: string;
      attachments?: Array<{ kind: string; path?: string; orgId?: string; driveId?: string }>;
    };
    expect(created.task).toContain("User-uploaded attachments:");
    expect(created.task).toContain("agent-fs:misc/user-uploads/");
    expect(created.task).toContain("agent-fs download <path>");
    expect(created.attachments).toHaveLength(1);
    expect(created.attachments?.[0]).toMatchObject({
      kind: "agent-fs",
      orgId: "shared-org",
      driveId: "shared-drive",
    });
    expect(created.attachments?.[0]?.path).toContain("screen-shot.png");

    const stored = getTaskAttachments(created.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      name: "screen-shot.png",
      kind: "agent-fs",
      mimeType: "image/png",
      intent: "user-upload",
    });

    const sessionResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as {
      root: { attachments?: unknown[] };
      chain: Array<{ attachments?: unknown[] }>;
    };
    expect(session.root.attachments).toHaveLength(1);
    expect(session.chain[0]?.attachments).toHaveLength(1);
  });

  test("multipart task parsing rejects streamed bodies over the request cap", async () => {
    const boundary = "----swarm-upload-over-limit";
    const request = oversizedMultipartRequest(
      boundary,
      taskUploadTestHooks.maxMultipartCreateTaskBytes + 1,
    );

    await expect(taskUploadTestHooks.parseMultipartCreateTask(request)).rejects.toThrow(
      "Multipart task creation request is too large",
    );
  });
});
