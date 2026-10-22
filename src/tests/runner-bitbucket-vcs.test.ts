/**
 * Worker-side Bitbucket PR linking. There is no Bitbucket CLI in the worker
 * image, so `detectVcsForTask` asks the Bitbucket REST API (via `fetch`) for an
 * open PR on the current branch and PATCHes `/api/tasks/:id/vcs` when it finds
 * one. Both calls go through `globalThis.fetch`, which these tests stub, so no
 * server or port is involved. The git side runs against a real temp repo.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVcsForTask, findBitbucketOpenPullRequest } from "../commands/runner";
import { expectChildOk, runChild } from "./test-proc";

const API_URL = "http://swarm.invalid";
const BRANCH = "feature/bb-link";
const PR_HTML = "https://bitbucket.org/acme-ws/web.app/pull-requests/17";

type Call = { url: string; method: string; headers: Headers; body: string };
type BitbucketReply = { status: number; body: unknown } | "throw";

const originalFetch = globalThis.fetch;
const originalToken = process.env.BITBUCKET_TOKEN;
let calls: Call[] = [];
let bitbucketReply: BitbucketReply = { status: 200, body: { values: [] } };
let repoDir = "";
let taskSeq = 0;

function nextTaskId(): string {
  taskSeq += 1;
  return `00000000-0000-4000-8000-${String(taskSeq).padStart(12, "0")}`;
}

async function git(args: string[]): Promise<void> {
  expectChildOk(await runChild(["git", "-C", repoDir, ...args]), `git ${args.join(" ")}`);
}

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (url.startsWith("https://api.bitbucket.org/")) {
      if (bitbucketReply === "throw") throw new TypeError("network down");
      return new Response(JSON.stringify(bitbucketReply.body), {
        status: bitbucketReply.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const bitbucketCalls = () => calls.filter((c) => c.url.startsWith("https://api.bitbucket.org/"));
const patchCalls = () => calls.filter((c) => c.method === "PATCH");

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "runner-bb-vcs-"));
  await git(["init", "--quiet"]);
  await git(["checkout", "--quiet", "-b", BRANCH]);
  await git(["remote", "add", "origin", "https://bitbucket.org/acme-ws/web.app.git"]);
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  bitbucketReply = { status: 200, body: { values: [] } };
  process.env.BITBUCKET_TOKEN = "example-bb-token";
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.BITBUCKET_TOKEN;
  else process.env.BITBUCKET_TOKEN = originalToken;
});

describe("detectVcsForTask on a Bitbucket remote", () => {
  test("an open PR for the branch links the task", async () => {
    bitbucketReply = {
      status: 200,
      body: { values: [{ id: 17, links: { html: { href: PR_HTML } } }] },
    };
    const taskId = nextTaskId();
    await detectVcsForTask(API_URL, "swarm-key", taskId, repoDir);

    const [lookup] = bitbucketCalls();
    expect(lookup).toBeDefined();
    const lookupUrl = new URL(lookup!.url);
    expect(lookupUrl.pathname).toBe("/2.0/repositories/acme-ws/web.app/pullrequests");
    expect(lookupUrl.searchParams.get("q")).toBe(`source.branch.name="${BRANCH}" AND state="OPEN"`);
    expect(lookupUrl.searchParams.get("pagelen")).toBe("1");
    expect(lookup!.headers.get("authorization")).toBe("Bearer example-bb-token");

    const patches = patchCalls();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe(`${API_URL}/api/tasks/${taskId}/vcs`);
    expect(patches[0]!.headers.get("authorization")).toBe("Bearer swarm-key");
    expect(JSON.parse(patches[0]!.body)).toEqual({
      vcsProvider: "bitbucket",
      vcsRepo: "acme-ws/web.app",
      vcsNumber: 17,
      vcsUrl: PR_HTML,
    });
  });

  test("no open PR sends no PATCH", async () => {
    await detectVcsForTask(API_URL, "swarm-key", nextTaskId(), repoDir);
    expect(bitbucketCalls()).toHaveLength(1);
    expect(patchCalls()).toHaveLength(0);
  });

  test("a non-200 answer is swallowed and sends no PATCH", async () => {
    bitbucketReply = { status: 401, body: { type: "error", error: { message: "Unauthorized" } } };
    await expect(
      detectVcsForTask(API_URL, "swarm-key", nextTaskId(), repoDir),
    ).resolves.toBeUndefined();
    expect(bitbucketCalls()).toHaveLength(1);
    expect(patchCalls()).toHaveLength(0);
  });

  test("a network failure is swallowed and sends no PATCH", async () => {
    bitbucketReply = "throw";
    await expect(
      detectVcsForTask(API_URL, "swarm-key", nextTaskId(), repoDir),
    ).resolves.toBeUndefined();
    expect(patchCalls()).toHaveLength(0);
  });

  test("without BITBUCKET_TOKEN it calls nothing", async () => {
    delete process.env.BITBUCKET_TOKEN;
    await detectVcsForTask(API_URL, "swarm-key", nextTaskId(), repoDir);
    expect(calls).toHaveLength(0);
  });
});

describe("findBitbucketOpenPullRequest", () => {
  test("escapes quotes in the branch name inside the BBQL query", async () => {
    let seen = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      seen = String(input);
      return new Response(JSON.stringify({ values: [] }), { status: 200 });
    }) as typeof fetch;
    await findBitbucketOpenPullRequest("git@bitbucket.org:ws/repo.git", 'we"ird', {
      token: "t",
      fetchImpl,
    });
    expect(new URL(seen).searchParams.get("q")).toBe(
      'source.branch.name="we\\"ird" AND state="OPEN"',
    );
  });

  test("rejects a reply without a numeric id or an html link", async () => {
    for (const values of [
      [{ id: "17", links: { html: { href: PR_HTML } } }],
      [{ id: 17, links: {} }],
      [{}],
    ]) {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ values }), { status: 200 })) as unknown as typeof fetch;
      expect(
        await findBitbucketOpenPullRequest("https://bitbucket.org/ws/repo", "b", {
          token: "t",
          fetchImpl,
        }),
      ).toBeNull();
    }
  });

  test("returns null for a non-Bitbucket remote without calling fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(
      await findBitbucketOpenPullRequest("https://github.com/ws/repo", "b", {
        token: "t",
        fetchImpl,
      }),
    ).toBeNull();
    expect(called).toBe(false);
  });
});
