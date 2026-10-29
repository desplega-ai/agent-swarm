/**
 * The auth-failure bench for a ChatGPT subscription pool slot (pi on
 * `openai-codex/<id>`). A refresh rejected while the session starts fails
 * `createSession`, before the completion-time report, so the runner reports it
 * there. A login rejected mid-run reaches the completion-time report as a
 * counted `[auth-error]`. Runs the real auth-failure route.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { closeDb, initDb } from "../be/db";
import { createSessionReportingAuthFailure, reportKeyCompletionOutcome } from "../commands/runner";
import { handleApiKeys } from "../http/api-keys";
import { CodexOAuthRefreshError } from "../providers/codex-oauth/storage";
import {
  chatgptSubscriptionAuthFailure,
  loadChatgptSubscriptionCredential,
} from "../providers/codex-oauth/subscription";
import type { ProviderSessionConfig } from "../providers/types";
import { listenOnFreePort } from "./test-net";

const TEST_DB = `./test-chatgpt-subscription-session-bench-${Date.now()}.sqlite`;
const TASK_ID = "00000000-0000-4000-8000-000000000001";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  initDb(TEST_DB);
  server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const handled = await handleApiKeys(
      req,
      res,
      url.pathname.split("/").filter(Boolean),
      url.searchParams,
    );
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(`${TEST_DB}${suffix}`).catch(() => {});
});

async function slotStatus(keySuffix: string) {
  const res = await fetch(`${baseUrl}/api/keys/status?keyType=CODEX_OAUTH`);
  const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
  return body.keys.find((k) => k.keySuffix === keySuffix);
}

/** A pi adapter whose session start revalidates the slot with `getValid`. */
function piAdapter(getValid: () => Promise<never>) {
  return {
    createSession: async (config: ProviderSessionConfig) => {
      await loadChatgptSubscriptionCredential(config, { getValid });
      throw new Error("unreachable");
    },
  };
}

function sessionStart(keySuffix: string, keyIndex: number) {
  const config = {
    apiUrl: baseUrl,
    apiKey: "test-key",
    codexSlot: keyIndex,
    model: "openai-codex/gpt-5.6-sol",
  } as ProviderSessionConfig;
  const report = {
    apiUrl: baseUrl,
    apiKey: "test-key",
    credential: { keyType: "CODEX_OAUTH", keySuffix, keyIndex },
    taskId: TASK_ID,
  };
  return { config, report };
}

describe("ChatGPT subscription slot bench", () => {
  test("a refresh rejected at session start benches the slot on the second task", async () => {
    const { config, report } = sessionStart("subA1", 1);
    const rejected = piAdapter(async () => {
      throw new CodexOAuthRefreshError(1, "refresh_rejected", "subA1", 401, "invalid_grant");
    });

    for (let i = 0; i < 2; i++) {
      await expect(createSessionReportingAuthFailure(rejected, config, report)).rejects.toThrow(
        "refresh rejected (401",
      );
    }

    expect(await slotStatus("subA1")).toMatchObject({
      status: "rate_limited",
      consecutiveAuthFailures: 2,
    });
  });

  test("a lock timeout at session start is transient and never counts", async () => {
    const { config, report } = sessionStart("subB2", 2);
    const timedOut = piAdapter(async () => {
      throw new CodexOAuthRefreshError(2, "lock_timeout", "subB2");
    });

    for (let i = 0; i < 2; i++) {
      await expect(createSessionReportingAuthFailure(timedOut, config, report)).rejects.toThrow(
        "refresh lock",
      );
    }

    expect((await slotStatus("subB2"))?.consecutiveAuthFailures ?? 0).toBe(0);
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
