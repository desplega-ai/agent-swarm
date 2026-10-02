/**
 * Credential selection for GitHub reactions (src/github/reactions.ts).
 *
 * Reactions authenticate with, in order:
 *   1. a GitHub App installation token (App creds loaded + installation id),
 *   2. `GITHUB_TOKEN` (PAT) for plain-webhook deployments with no App,
 *   3. nothing: skip quietly, never throw.
 *
 * Uses the real `../github/app` module (App state is driven through env +
 * `initGitHub()`), and spies on `fetch` so nothing reaches api.github.com.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { initGitHub, resetGitHub } from "../github/app";
import {
  addGraphQLReaction,
  addIssueReaction,
  addPullReviewCommentReaction,
  addReaction,
} from "../github/reactions";

const PAT = "ghp_fixturePersonalAccessToken0000000000";
const APP_TOKEN = "ghs_fixtureInstallationToken000000000";

interface FetchCall {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
}

let calls: FetchCall[] = [];
let mintStatus = 201;
let reactionStatus = 201;
let fetchThrows = false;
let fetchSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let appPrivateKeyPem = "";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_DISABLE",
];

function enableApp(): void {
  process.env.GITHUB_APP_ID = "424242";
  process.env.GITHUB_APP_PRIVATE_KEY = appPrivateKeyPem;
  resetGitHub();
  initGitHub();
}

function disableApp(): void {
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  resetGitHub();
  initGitHub();
}

function reactionCalls(): FetchCall[] {
  return calls.filter((c) => !c.url.includes("/access_tokens"));
}

function allLogOutput(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .map((args: unknown[]) => args.map((a) => String(a)).join(" "))
    .join("\n");
}

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  appPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
  delete process.env.GITHUB_DISABLE;
  delete process.env.GITHUB_TOKEN;
  calls = [];
  mintStatus = 201;
  reactionStatus = 201;
  fetchThrows = false;

  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.Authorization ?? null,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (fetchThrows) throw new Error("socket hang up");
    if (String(input).includes("/access_tokens")) {
      if (mintStatus !== 201) return new Response("mint failed", { status: mintStatus });
      return new Response(
        JSON.stringify({
          token: APP_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    if (reactionStatus !== 201) {
      return new Response('{"message":"Resource not accessible"}', { status: reactionStatus });
    }
    return new Response('{"data":{"addReaction":{"reaction":{"content":"EYES"}}}}', {
      status: 201,
    });
  }) as unknown as typeof fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetGitHub();
});

describe("reactions: GitHub App installation token (preferred)", () => {
  test("uses the installation token even when GITHUB_TOKEN is also set", async () => {
    enableApp();
    process.env.GITHUB_TOKEN = PAT;

    const ok = await addReaction("o/r", 11, "eyes", 777);

    expect(ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/app/installations/777/access_tokens",
      "https://api.github.com/repos/o/r/issues/comments/11/reactions",
    ]);
    expect(reactionCalls()[0]?.authorization).toBe(`Bearer ${APP_TOKEN}`);
    expect(calls.some((c) => c.authorization?.includes(PAT))).toBe(false);
  });
});

describe("reactions: GITHUB_TOKEN fallback", () => {
  test("no App credentials: reacts with the PAT, no installation id needed", async () => {
    disableApp();
    process.env.GITHUB_TOKEN = PAT;

    const ok = await addReaction("o/r", 11, "eyes");

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/issues/comments/11/reactions");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.authorization).toBe(`Bearer ${PAT}`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ content: "eyes" });
  });

  test("an installation id without App credentials still falls back to the PAT", async () => {
    disableApp();
    process.env.GITHUB_TOKEN = PAT;

    expect(await addIssueReaction("o/r", 5, "eyes", 777)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${PAT}`);
  });

  test("App credentials but no installation id: falls back to the PAT", async () => {
    enableApp();
    process.env.GITHUB_TOKEN = PAT;

    expect(await addIssueReaction("o/r", 5, "eyes", undefined)).toBe(true);

    expect(calls.some((c) => c.url.includes("/access_tokens"))).toBe(false);
    expect(calls[0]?.authorization).toBe(`Bearer ${PAT}`);
  });

  test("installation token mint fails: falls back to the PAT", async () => {
    enableApp();
    process.env.GITHUB_TOKEN = PAT;
    mintStatus = 500;

    expect(await addIssueReaction("o/r", 5, "eyes", 777)).toBe(true);

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/app/installations/777/access_tokens",
      "https://api.github.com/repos/o/r/issues/5/reactions",
    ]);
    expect(reactionCalls()[0]?.authorization).toBe(`Bearer ${PAT}`);
  });

  test("each helper hits its own endpoint with the PAT", async () => {
    disableApp();
    process.env.GITHUB_TOKEN = PAT;

    await addReaction("o/r", 11, "eyes");
    await addPullReviewCommentReaction("o/r", 12, "eyes");
    await addIssueReaction("o/r", 13, "eyes");
    await addGraphQLReaction("PRR_node", "EYES");

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/o/r/issues/comments/11/reactions",
      "https://api.github.com/repos/o/r/pulls/comments/12/reactions",
      "https://api.github.com/repos/o/r/issues/13/reactions",
      "https://api.github.com/graphql",
    ]);
    for (const call of calls) expect(call.authorization).toBe(`Bearer ${PAT}`);
    expect(JSON.parse(calls[3]?.body ?? "{}").variables.input).toEqual({
      subjectId: "PRR_node",
      content: "EYES",
    });
  });
});

describe("reactions: no credentials", () => {
  test("neither App nor GITHUB_TOKEN: skips without a request or a throw", async () => {
    disableApp();

    expect(await addReaction("o/r", 11, "eyes", 777)).toBe(false);
    expect(await addPullReviewCommentReaction("o/r", 12, "eyes")).toBe(false);
    expect(await addIssueReaction("o/r", 13, "eyes")).toBe(false);
    expect(await addGraphQLReaction("PRR_node", "EYES")).toBe(false);

    expect(calls).toHaveLength(0);
  });

  test("a blank GITHUB_TOKEN counts as unset", async () => {
    disableApp();
    process.env.GITHUB_TOKEN = "   ";

    expect(await addIssueReaction("o/r", 13, "eyes")).toBe(false);

    expect(calls).toHaveLength(0);
  });
});

describe("reactions: failures never throw and never log the token", () => {
  test("HTTP error from GitHub resolves false", async () => {
    disableApp();
    process.env.GITHUB_TOKEN = PAT;
    reactionStatus = 403;

    expect(await addReaction("o/r", 11, "eyes")).toBe(false);
    expect(await addGraphQLReaction("PRR_node", "EYES")).toBe(false);

    expect(allLogOutput()).not.toContain(PAT);
  });

  test("network error resolves false", async () => {
    disableApp();
    process.env.GITHUB_TOKEN = PAT;
    fetchThrows = true;

    expect(await addPullReviewCommentReaction("o/r", 12, "eyes")).toBe(false);
    expect(await addIssueReaction("o/r", 13, "eyes")).toBe(false);

    expect(allLogOutput()).not.toContain(PAT);
  });

  test("no log line carries either token on the success path", async () => {
    enableApp();
    process.env.GITHUB_TOKEN = PAT;

    await addReaction("o/r", 11, "eyes", 777);
    disableApp();
    process.env.GITHUB_TOKEN = PAT;
    await addReaction("o/r", 11, "eyes");

    const output = allLogOutput();
    expect(output).not.toContain(PAT);
    expect(output).not.toContain(APP_TOKEN);
  });
});
