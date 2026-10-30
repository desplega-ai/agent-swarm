/**
 * The auth-failure bench for a ChatGPT subscription pool slot (pi on
 * `openai-codex/<id>`). A refresh rejected while the session starts fails
 * `createSession`, before the completion-time report, so the runner reports it
 * there. A login rejected mid-run reaches the completion-time report as a
 * counted `[auth-error]`. Session starts go through `spawnProviderProcess`,
 * the boundary the new-task and resumed-task paths share, against the real
 * key-status routes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "../be/db";
import { reportKeyCompletionOutcome, spawnProviderProcess } from "../commands/runner";
import { handleApiKeys } from "../http/api-keys";
import { deriveCodexKeySuffix } from "../providers/codex-oauth/auth-json";
import { CodexOAuthRefreshError } from "../providers/codex-oauth/storage";
import {
  chatgptSubscriptionAuthFailure,
  loadChatgptSubscriptionCredential,
} from "../providers/codex-oauth/subscription";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types";
import type { ProviderSessionConfig } from "../providers/types";
import { listenOnFreePort } from "./test-net";

const TEST_DB = `./test-chatgpt-subscription-session-bench-${Date.now()}.sqlite`;
const TASK_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-0000000000aa";
const MODEL = "openai-codex/gpt-5.6-sol";

let server: Server;
let baseUrl = "";
let logDir = "";
/** The pool the config store serves: `codex_oauth_<slot>` entries. */
let pool: Array<{ slot: number; creds: CodexOAuthCredentials }> = [];

beforeAll(async () => {
  initDb(TEST_DB);
  logDir = await mkdtemp(join(tmpdir(), "chatgpt-sub-bench-"));
  server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/config/resolved") {
      const configs = pool.map(({ slot, creds }) => ({
        key: `codex_oauth_${slot}`,
        value: JSON.stringify(creds),
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ configs }));
      return;
    }
    const handled = await handleApiKeys(
      req,
      res,
      url.pathname.split("/").filter(Boolean),
      url.searchParams,
    );
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    }
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(`${TEST_DB}${suffix}`).catch(() => {});
  await rm(logDir, { recursive: true, force: true });
});

async function slotStatus(keySuffix: string) {
  const res = await fetch(`${baseUrl}/api/keys/status?keyType=CODEX_OAUTH`);
  const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
  return body.keys.find((k) => k.keySuffix === keySuffix);
}

/** Serve a one-slot pool; returns the slot's key suffix. */
function serveSlot(slot: number, accountId: string): string {
  const creds: CodexOAuthCredentials = {
    access: `at_synthetic_${accountId}`,
    refresh: `rt_synthetic_${accountId}`,
    expires: Date.now() - 1000,
    accountId,
  };
  pool = [{ slot, creds }];
  return deriveCodexKeySuffix(creds.access, accountId);
}

/** A pi adapter whose session start revalidates the slot with `getValid`. */
function piAdapter(getValid: () => Promise<never>) {
  const slots: Array<number | undefined> = [];
  const adapter = {
    name: "pi",
    traits: {},
    canResume: async () => false,
    formatCommand: (name: string) => name,
    createSession: async (config: ProviderSessionConfig) => {
      slots.push(config.codexSlot);
      await loadChatgptSubscriptionCredential(config, { getValid });
      throw new Error("unreachable");
    },
  } as unknown as Parameters<typeof spawnProviderProcess>[0];
  return { adapter, slots };
}

/**
 * Options as the poll loop passes them: a new task carries the claim's
 * resolved model, a resumed task only its own pin and never a native resume
 * id.
 */
function startOpts(kind: "new" | "resumed") {
  const base = {
    prompt: kind === "new" ? "do the task" : "resume the task",
    logFile: join(logDir, `${kind}.jsonl`),
    role: "worker",
    apiUrl: baseUrl,
    apiKey: "test-key",
    agentId: AGENT_ID,
    runnerSessionId: crypto.randomUUID(),
    iteration: 1,
    taskId: TASK_ID,
    model: MODEL,
    harnessProvider: "pi" as const,
    cwd: logDir,
  };
  return kind === "new"
    ? { ...base, resolvedModel: MODEL, modelSource: "task", triggerSurface: "api" }
    : { ...base, resumeSessionId: undefined };
}

function startSession(
  adapter: Parameters<typeof spawnProviderProcess>[0],
  kind: "new" | "resumed",
) {
  return spawnProviderProcess(adapter, startOpts(kind), logDir, true);
}

describe("ChatGPT subscription slot bench", () => {
  for (const [kind, slot] of [
    ["new", 1],
    ["resumed", 2],
  ] as const) {
    test(`a refresh rejected at ${kind}-task session start benches the slot on the second start`, async () => {
      const keySuffix = serveSlot(slot, `acct-${kind}`);
      const { adapter, slots } = piAdapter(async () => {
        throw new CodexOAuthRefreshError(slot, "refresh_rejected", keySuffix, 401, "invalid_grant");
      });

      for (let i = 0; i < 2; i++) {
        await expect(startSession(adapter, kind)).rejects.toThrow("refresh rejected (401");
      }

      expect(slots).toEqual([slot, slot]);
      expect(await slotStatus(keySuffix)).toMatchObject({
        status: "rate_limited",
        consecutiveAuthFailures: 2,
      });
    });
  }

  test("a lock timeout at session start is transient and never counts", async () => {
    const keySuffix = serveSlot(4, "acct-lock");
    const { adapter } = piAdapter(async () => {
      throw new CodexOAuthRefreshError(4, "lock_timeout", keySuffix);
    });

    for (let i = 0; i < 2; i++) {
      await expect(startSession(adapter, "new")).rejects.toThrow("refresh lock");
    }

    expect((await slotStatus(keySuffix))?.consecutiveAuthFailures ?? 0).toBe(0);
  });

  test("a login rejected mid-run benches the slot through the completion report", async () => {
    const reason = chatgptSubscriptionAuthFailure(
      "Your authentication token has been invalidated. Please try signing in again.",
      { codexSlot: 3, model: "openai-codex/gpt-5.6-sol" },
    );
    for (let i = 0; i < 2; i++) {
      await reportKeyCompletionOutcome({
        apiUrl: baseUrl,
        apiKey: "test-key",
        credential: { keyType: "CODEX_OAUTH", keySuffix: "subC3", keyIndex: 3 },
        taskId: TASK_ID,
        exitCode: 1,
        failureReason: reason,
      });
    }

    expect(await slotStatus("subC3")).toMatchObject({
      status: "rate_limited",
      consecutiveAuthFailures: 2,
    });
  });
});
