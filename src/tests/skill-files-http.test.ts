import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createSkill, getDb, initDb } from "../be/db";
import { handleSkills } from "../http/skills";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = `./test-skill-files-http-${process.pid}.sqlite`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

type TestResponse = {
  status: number;
  text: string;
  json: () => Promise<unknown>;
};

async function dispatch(path: string, init: RequestInit = {}): Promise<TestResponse> {
  const req = Readable.from(init.body ? [Buffer.from(String(init.body))] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = { "content-type": "application/json" };

  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");
  if (!(await handleSkills(req, res, pathSegments, queryParams, undefined))) {
    res.writeHead(404);
    res.end("Not Found");
  }

  return {
    status,
    text,
    json: async () => JSON.parse(text),
  };
}

describe("/api/skills/:id/files", () => {
  let skillId: string;

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });

  beforeEach(() => {
    getDb().run("DELETE FROM skill_files");
    getDb().run("DELETE FROM skills");
    const skill = createSkill({
      name: `http-file-skill-${crypto.randomUUID()}`,
      description: "HTTP file skill",
      content: "---\nname: http-file-skill\ndescription: HTTP file skill\n---\n\nBody.",
      type: "personal",
      scope: "agent",
      isComplex: true,
    });
    skillId = skill.id;
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("POST bulk upserts files and GET manifest omits content", async () => {
    const post = await dispatch(`/api/skills/${skillId}/files`, {
      method: "POST",
      body: JSON.stringify({
        files: [
          { path: "references/guide.md", content: "# Guide", mimeType: "text/markdown" },
          { path: "scripts/setup.sh", content: "echo ok", mimeType: "text/x-shellscript" },
        ],
      }),
    });
    expect(post.status).toBe(200);
    expect((await post.json()) as { total: number }).toMatchObject({ total: 2 });

    const list = await dispatch(`/api/skills/${skillId}/files`);
    const body = (await list.json()) as { files: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(2);
    expect(body.files[0]).not.toHaveProperty("content");
  });

  test("GET, PUT, and DELETE a nested file path", async () => {
    const put = await dispatch(`/api/skills/${skillId}/files/references/deep/guide.md`, {
      method: "PUT",
      body: JSON.stringify({ content: "deep guide", mimeType: "text/markdown" }),
    });
    expect(put.status).toBe(200);

    const get = await dispatch(`/api/skills/${skillId}/files/references/deep/guide.md`);
    const got = (await get.json()) as { file: { path: string; content: string } };
    expect(got.file).toMatchObject({
      path: "references/deep/guide.md",
      content: "deep guide",
    });

    const del = await dispatch(`/api/skills/${skillId}/files/references/deep/guide.md`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const missing = await dispatch(`/api/skills/${skillId}/files/references/deep/guide.md`);
    expect(missing.status).toBe(404);
  });

  test("rejects invalid paths and unknown skills", async () => {
    const traversal = await dispatch(`/api/skills/${skillId}/files/references/../secret.md`, {
      method: "PUT",
      body: JSON.stringify({ content: "nope" }),
    });
    expect(traversal.status).toBe(400);

    const missingSkill = await dispatch(`/api/skills/no-such-skill/files/references/a.md`);
    expect(missingSkill.status).toBe(404);
  });

  test("rejects file mutations for system-managed skills", async () => {
    const systemSkill = createSkill({
      name: `system-file-skill-${crypto.randomUUID()}`,
      description: "System file skill",
      content: "---\nname: system-file-skill\ndescription: System file skill\n---\n\nBody.",
      type: "remote",
      scope: "global",
      isComplex: true,
      systemDefault: true,
    });

    const post = await dispatch(`/api/skills/${systemSkill.id}/files`, {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "references/guide.md", content: "# Guide" }],
      }),
    });
    expect(post.status).toBe(403);

    const put = await dispatch(`/api/skills/${systemSkill.id}/files/references/guide.md`, {
      method: "PUT",
      body: JSON.stringify({ content: "# Guide" }),
    });
    expect(put.status).toBe(403);

    const del = await dispatch(`/api/skills/${systemSkill.id}/files/references/guide.md`, {
      method: "DELETE",
    });
    expect(del.status).toBe(403);
  });
});
