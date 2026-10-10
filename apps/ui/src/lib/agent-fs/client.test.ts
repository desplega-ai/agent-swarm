import { afterEach, describe, expect, test } from "bun:test";
import { AgentFsClient, AgentFsError, isAgentFsAuthError } from "./client";

const KEY = "af_secret_0123456789abcdefghij";
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function caught(promise: Promise<unknown>): Promise<AgentFsError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AgentFsError);
    return err as AgentFsError;
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("AgentFsClient", () => {
  test("callOp posts { op, ...params, driveId } to /orgs/<org>/ops with the Bearer key", async () => {
    const calls = mockFetch(() => jsonResponse(200, { entries: [] }));
    const client = new AgentFsClient({ endpoint: "http://fs.test/", apiKey: KEY });
    await client.callOp("org-1", "ls", { path: "/" }, "drive-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://fs.test/orgs/org-1/ops");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      op: "ls",
      path: "/",
      driveId: "drive-1",
    });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  test("error messages never contain the key", async () => {
    mockFetch(() =>
      jsonResponse(403, { error: "PERMISSION_DENIED", message: `key ${KEY} is not a member` }),
    );
    const client = new AgentFsClient({ endpoint: "http://fs.test", apiKey: KEY });
    const err = await caught(client.callOp("org-1", "ls", {}, "drive-1"));
    expect(err.status).toBe(403);
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });

  test("the key is not a visible property of the client", () => {
    const client = new AgentFsClient({ endpoint: "http://fs.test", apiKey: KEY });
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(Object.values(client)).not.toContain(KEY);
  });

  test("a 401 is an auth error, a network failure is status 0", async () => {
    mockFetch(() => jsonResponse(401, { error: "UNAUTHORIZED", message: "Invalid API key" }));
    const client = new AgentFsClient({ endpoint: "http://fs.test", apiKey: KEY });
    const unauthorized = await caught(client.getMe());
    expect(isAgentFsAuthError(unauthorized)).toBe(true);

    mockFetch(() => {
      throw new TypeError(`Failed to fetch http://fs.test with ${KEY}`);
    });
    const offline = await caught(client.getMe());
    expect(offline.status).toBe(0);
    expect(offline.code).toBe("NETWORK");
    expect(offline.message).not.toContain(KEY);
  });

  test("register surfaces a taken email as a 409 CONFLICT", async () => {
    const calls = mockFetch(() =>
      jsonResponse(409, { error: "CONFLICT", message: "User with this email already exists" }),
    );
    const err = await caught(
      AgentFsClient.register({ endpoint: "http://fs.test", email: "human@example.com" }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("CONFLICT");
    expect(calls[0]?.url).toBe("http://fs.test/auth/register");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test("health reads the public route without a key", async () => {
    const calls = mockFetch(() =>
      jsonResponse(200, { ok: true, version: "0.14.0", features: ["share-links"] }),
    );
    const health = await AgentFsClient.health("http://fs.test/");
    expect(health.features).toEqual(["share-links"]);
    expect(calls[0]?.url).toBe("http://fs.test/health");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test("getRawUrl encodes the whole path as one segment", () => {
    const client = new AgentFsClient({ endpoint: "http://fs.test", apiKey: KEY });
    expect(client.getRawUrl("org-1", "drive-1", "docs/a b.md")).toBe(
      "http://fs.test/orgs/org-1/drives/drive-1/files/docs%2Fa%20b.md/raw",
    );
  });
});
