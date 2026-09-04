import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { closeDb, createUser, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { handleFeedback } from "../http/feedback";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-feedback-proxy.sqlite";
const SUBMITTED_AT = "2026-09-04T12:00:00.000Z";

function jsonReq(body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = "POST";
  req.url = "/api/feedback";
  req.headers = { "content-type": "application/json" };
  return req;
}

function resRecorder() {
  let statusCode = 200;
  const chunks: string[] = [];
  const headers = new Map<string, string>();
  return {
    res: {
      setHeader: (name: string, value: string | number | readonly string[]) => {
        headers.set(name.toLowerCase(), String(value));
      },
      writeHead: (code: number) => {
        statusCode = code;
      },
      end: (chunk?: string) => {
        if (chunk) chunks.push(chunk);
      },
    },
    result: () => ({ statusCode, headers, body: chunks.join("") }),
  };
}

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function submit(
  fetchImpl: typeof fetch,
  auth:
    | { kind: "operator"; fingerprint: string }
    | { kind: "user"; userId: string; user: Awaited<ReturnType<typeof createUser>> },
  timeoutMs?: number,
) {
  const req = jsonReq({
    submission_id: "feedback-attempt-1",
    name: " Ada ",
    email: "ada@example.com",
    newsletter_consent: true,
    nps: 5,
    message: " Great tool ",
    submitted_at: SUBMITTED_AT,
  });
  setRequestAuth(req, auth);
  const recorder = resRecorder();
  await handleFeedback(
    req,
    recorder.res as never,
    getPathSegments(req.url),
    parseQueryParams(req.url),
    { fetchImpl, timeoutMs },
  );
  return recorder.result();
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

beforeEach(async () => {
  delete process.env.SWARM_ORG_NAME;
  delete process.env.FEEDBACK_ENDPOINT;
  await getDbClient().run("DELETE FROM swarm_config");
  await upsertSwarmConfig({
    scope: "global",
    key: "telemetry_installation_id",
    value: "install_existing123",
  });
  await upsertSwarmConfig({
    scope: "global",
    key: "telemetry_installed_at",
    value: "2026-08-25T12:00:00.000Z",
  });
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("feedback proxy route", () => {
  test("forwards the proxy contract with server-owned user and installation attribution", async () => {
    process.env.FEEDBACK_ENDPOINT = "https://feedback.example/v1/feedback";
    process.env.SWARM_ORG_NAME = "Acme";
    const user = await createUser({ name: "Authenticated Feedback User" });
    let target = "";
    let payload: Record<string, unknown> = {};

    const result = await submit(
      async (url, init) => {
        target = String(url);
        payload = JSON.parse(String(init?.body));
        return Response.json(
          { status: "accepted", submission_id: "feedback-attempt-1" },
          { status: 202 },
        );
      },
      { kind: "user", userId: user.id, user },
    );

    expect(result.statusCode).toBe(202);
    expect(target).toBe("https://feedback.example/v1/feedback");
    expect(payload).toMatchObject({
      submission_id: "feedback-attempt-1",
      name: "Ada",
      email: "ada@example.com",
      newsletter_consent: true,
      nps: 5,
      message: "Great tool",
      user_id: user.id,
      install_id: "install_existing123",
      org_name: "Acme",
      installed_at: "2026-08-25T12:00:00.000Z",
      submitted_at: SUBMITTED_AT,
    });
    expect(typeof payload.swarm_version).toBe("string");
  });

  test("uses the trusted operator fingerprint when the shared key submits", async () => {
    let payload: Record<string, unknown> = {};
    await submit(
      async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json(
          { status: "accepted", submission_id: "feedback-attempt-1" },
          { status: 202 },
        );
      },
      { kind: "operator", fingerprint: "op:trusted" },
    );
    expect(payload.user_id).toBe("op:trusted");
  });

  test("passes through proxy errors and Retry-After", async () => {
    const result = await submit(
      async () =>
        Response.json(
          { code: "rate_limited", message: "Try later" },
          { status: 429, headers: { "Retry-After": "3600" } },
        ),
      { kind: "operator", fingerprint: "op:trusted" },
    );
    expect(result.statusCode).toBe(429);
    expect(result.headers.get("retry-after")).toBe("3600");
    expect(JSON.parse(result.body)).toEqual({ code: "rate_limited", message: "Try later" });
  });

  test("preserves other proxy validation and availability statuses", async () => {
    for (const status of [400, 413, 503]) {
      const result = await submit(
        async () => Response.json({ code: `error_${status}`, message: "Proxy error" }, { status }),
        { kind: "operator", fingerprint: "op:trusted" },
      );
      expect(result.statusCode).toBe(status);
      expect(JSON.parse(result.body)).toEqual({ code: `error_${status}`, message: "Proxy error" });
    }
  });

  test("fails softly when the proxy request fails", async () => {
    const result = await submit(
      async () => {
        throw new Error("network unavailable");
      },
      { kind: "operator", fingerprint: "op:trusted" },
    );
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toMatchObject({ error: "Failed to submit feedback" });
  });

  test("times out a slow proxy request without blocking the caller", async () => {
    const result = await submit(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      { kind: "operator", fingerprint: "op:trusted" },
      1,
    );
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toMatchObject({ error: "Failed to submit feedback" });
  });

  test("does not create a feedback persistence table", async () => {
    const table = await getDbClient().get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback_submissions'",
    );
    expect(table).toBeNull();
  });
});
