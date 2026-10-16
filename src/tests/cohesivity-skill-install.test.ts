import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { INTEGRATIONS } from "../../apps/ui/src/lib/integrations-catalog";
import { closeDb, createAgent, getAgentSkills, initDb } from "../be/db";
import { handleSkills } from "../http/skills";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = `./test-cohesivity-skill-install-${process.pid}.sqlite`;
const LEAD_ID = "aaaa2180-0000-4000-8000-000000000001";
const WORKER_ID = "bbbb2180-0000-4000-8000-000000000002";
const RAW_PREFIX = "https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST";
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

  await handleSkills(req, res, getPathSegments(path), parseQueryParams(path), undefined);
  return { status, text };
}

const realFetch = globalThis.fetch;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  // Serve the checked-in template for the raw GitHub URL the endpoint builds.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.startsWith(RAW_PREFIX)) throw new Error(`unexpected fetch: ${url}`);
    return new Response(readFileSync(url.slice(RAW_PREFIX.length), "utf8"));
  }) as typeof fetch;
  await createAgent({ id: LEAD_ID, name: "Cohesivity Lead", isLead: true, status: "idle" });
  await createAgent({ id: WORKER_ID, name: "Cohesivity Worker", isLead: false, status: "idle" });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

test("the Cohesivity integration's install request delivers the skill to lead and worker", async () => {
  const skill = INTEGRATIONS.find((i) => i.id === "cohesivity")?.recommendedSkills?.[0];
  if (!skill?.templateRepo) throw new Error("cohesivity template skill missing from the catalog");

  const { status } = await post("/api/skills/install-remote", {
    sourceRepo: skill.templateRepo,
    sourcePath: skill.templatePath,
    scope: skill.installScope,
  });

  expect(status).toBe(201);
  for (const agentId of [LEAD_ID, WORKER_ID]) {
    expect((await getAgentSkills(agentId)).map((s) => s.name)).toContain("cohesivity");
  }
});
