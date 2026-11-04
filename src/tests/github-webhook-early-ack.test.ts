import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { listenOnFreePort } from "./test-net";

// Events nothing handles (check_run, workflow_run, push, ...) are acknowledged
// before their body is read; handled events and ping keep the signature check.

const GOOD_SIGNATURE = "sha256=good";
let handlePullRequestCalls = 0;
let handleCheckRunCalls = 0;

const realGithub = await import("../github");
mock.module("../github", () => ({
  ...realGithub,
  isGitHubEnabled: () => true,
  verifyWebhookSignature: async (_payload: string, signature: string | null) =>
    signature === GOOD_SIGNATURE,
  handlePullRequest: async () => {
    handlePullRequestCalls++;
    return { created: false };
  },
  handleCheckRun: async () => {
    handleCheckRunCalls++;
    return { created: false };
  },
}));

const { handleWebhooks } = await import("../http/webhooks");

let server: Server;
let baseUrl: string;
let port: number;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const handled = await handleWebhooks(req, res, ["api", "github", "webhook"]);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  port = await listenOnFreePort(server);
  baseUrl = `http://127.0.0.1:${port}/api/github/webhook`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

function post(event: string | null, body: string, signature: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (event !== null) headers["x-github-event"] = event;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return fetch(baseUrl, { method: "POST", headers, body });
}

describe("GitHub webhook early ack", () => {
  test("unhandled event is acked without a signature and never reaches its handler", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.join(" "));
    };
    try {
      const noSig = await post("check_run", JSON.stringify({ action: "completed" }), null);
      expect(noSig.status).toBe(200);
      expect(await noSig.json()).toEqual({ created: false });

      const badSig = await post("workflow_run", "{}", "sha256=bad");
      expect(badSig.status).toBe(200);
      expect(await badSig.json()).toEqual({ created: false });
    } finally {
      console.log = origLog;
    }
    expect(handleCheckRunCalls).toBe(0);
    expect(logs.some((l) => l.includes("[GitHub] Received"))).toBe(false);
    expect(logs.some((l) => l.includes("Invalid webhook signature"))).toBe(false);
  });

  test("response arrives before a slow body finishes and the server stays healthy", async () => {
    const bodyDelayMs = 400;
    const payload = JSON.stringify({ action: "completed", pad: "x".repeat(1000) });
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const start = Date.now();
    const gotResponse = new Promise<number>((resolve) => {
      socket.once("data", () => resolve(Date.now() - start));
    });
    socket.write(
      [
        "POST /api/github/webhook HTTP/1.1",
        "Host: localhost",
        "x-github-event: check_run",
        "content-type: application/json",
        `content-length: ${Buffer.byteLength(payload)}`,
        "",
        "",
      ].join("\r\n"),
    );
    socket.write(payload.slice(0, 10));
    const elapsed = await gotResponse;
    expect(elapsed).toBeLessThan(bodyDelayMs);
    await Bun.sleep(bodyDelayMs);
    socket.end(payload.slice(10));
    socket.destroy();

    const next = await post("pull_request", "{}", "sha256=bad");
    expect(next.status).toBe(401);
  });

  test("handled event with a bad signature is still rejected", async () => {
    const res = await post("pull_request", "{}", "sha256=bad");
    expect(res.status).toBe(401);
    expect(handlePullRequestCalls).toBe(0);
  });

  test("ping with a bad signature is rejected, with a good one returns pong", async () => {
    expect((await post("ping", "{}", "sha256=bad")).status).toBe(401);
    const ok = await post("ping", "{}", GOOD_SIGNATURE);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ message: "pong" });
  });

  test("missing event header with a bad signature is still rejected", async () => {
    const res = await post(null, "{}", "sha256=bad");
    expect(res.status).toBe(401);
  });

  test("handled event with a good signature still runs its handler", async () => {
    const res = await post(
      "pull_request",
      JSON.stringify({
        action: "opened",
        repository: { full_name: "acme/repo" },
        pull_request: { number: 1, title: "t", body: "", html_url: "u", user: { login: "a" } },
      }),
      GOOD_SIGNATURE,
    );
    expect(res.status).toBe(200);
    expect(handlePullRequestCalls).toBe(1);
  });
});
