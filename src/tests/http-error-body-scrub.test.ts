import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { jsonError, writeUnhandledError } from "../http/utils";
import { clearVolatileSecretsForTesting, registerVolatileSecret } from "../utils/secret-scrubber";

type FakeResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  headersSent: boolean;
  writableEnded: boolean;
  endCalls: number;
};

function fakeResponse(init: { headersSent?: boolean } = {}) {
  const state: FakeResponse = {
    headersSent: init.headersSent ?? false,
    writableEnded: false,
    endCalls: 0,
  };
  const res = {
    get headersSent() {
      return state.headersSent;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status;
      state.headers = headers;
      state.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      state.endCalls += 1;
      if (chunk !== undefined) state.body = chunk;
      state.writableEnded = true;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, state };
}

// Built at runtime so no secret-shaped literal lands in the repo.
function randomToken(len = 32): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, len).padEnd(len, "Q");
}

describe("HTTP error bodies are scrubbed", () => {
  let secret: string;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    secret = ["sk", "live", randomToken()].join("_");
    registerVolatileSecret(secret, "UPSTREAM_TEST_TOKEN");
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    clearVolatileSecretsForTesting();
    errorSpy.mockRestore();
  });

  test("jsonError redacts a secret and keeps the status", () => {
    const { res, state } = fakeResponse();
    jsonError(res, `upstream said Authorization=${secret}`, 502);

    expect(state.status).toBe(502);
    expect(state.headers).toEqual({ "Content-Type": "application/json" });
    expect(state.body).toBeDefined();
    expect(state.body).not.toContain(secret);
    expect(state.body).toContain("[REDACTED:");
    expect(JSON.parse(state.body as string).error).toStartWith("upstream said Authorization=");
  });

  test("jsonError redacts a pattern-matched token with no registration", () => {
    const token = `ghp_${"Z".repeat(36)}`;
    const { res, state } = fakeResponse();
    jsonError(res, `GitHub rejected ${token}`, 401);

    expect(state.status).toBe(401);
    expect(state.body).not.toContain(token);
    expect(state.body).toContain("[REDACTED:");
    expect(state.body).toContain("GitHub rejected");
  });

  test("jsonError leaves a plain message byte-identical", () => {
    const { res, state } = fakeResponse();
    jsonError(res, "Task not found", 404);

    expect(state.status).toBe(404);
    expect(state.body).toBe(JSON.stringify({ error: "Task not found" }));
  });

  test("writeUnhandledError writes a scrubbed 500 and a scrubbed log line", () => {
    const { res, state } = fakeResponse();
    writeUnhandledError(res, new Error(`boom ${secret}`), {
      method: "POST",
      url: "/api/things?token=abc",
    });

    expect(state.status).toBe(500);
    expect(state.body).not.toContain(secret);
    expect(state.body).toContain("[REDACTED:");
    expect(JSON.parse(state.body as string).error).toStartWith("boom ");

    const logged = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).not.toContain(secret);
    expect(logged).toContain("[REDACTED:");
    expect(logged).toContain("POST /api/things?token=[REDACTED]");
  });

  test("writeUnhandledError handles a non-Error throw", () => {
    const { res, state } = fakeResponse();
    writeUnhandledError(res, `raw ${secret}`);

    expect(state.status).toBe(500);
    expect(state.body).not.toContain(secret);
    expect(state.body).toContain("[REDACTED:");
  });

  test("writeUnhandledError only ends the response when headers were already sent", () => {
    const { res, state } = fakeResponse({ headersSent: true });
    writeUnhandledError(res, new Error(`boom ${secret}`));

    expect(state.status).toBeUndefined();
    expect(state.body).toBeUndefined();
    expect(state.endCalls).toBe(1);
  });
});
