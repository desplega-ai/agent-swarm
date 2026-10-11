import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { E2BRuntimeProvider } from "../runtime-providers/e2b";

const provider = new E2BRuntimeProvider();
const handle = { kind: "e2b" as const, externalId: "sandbox-1" };
let server: Bun.Server<undefined>;
let target: { E2B_API_KEY: string; E2B_API_BASE: string };
let response: Response;
let calls: Array<{ method: string; path: string }>;

beforeEach(() => {
  calls = [];
  response = new Response(null, { status: 204 });
  server = Bun.serve({
    port: 0,
    fetch(req) {
      calls.push({ method: req.method, path: new URL(req.url).pathname });
      return response.clone();
    },
  });
  target = {
    E2B_API_KEY: `controller-${crypto.randomUUID()}`,
    E2B_API_BASE: `http://localhost:${server.port}`,
  };
});

afterEach(async () => {
  await server.stop(true);
});

describe("E2B runtime termination transport", () => {
  test("termination succeeds when the sandbox is already absent", async () => {
    response = new Response("Sandbox not found", { status: 404 });
    await provider.terminate(target, handle);
    expect(calls).toEqual([{ method: "DELETE", path: "/sandboxes/sandbox-1" }]);
  });

  test("termination preserves authentication and server errors", async () => {
    for (const status of [401, 500]) {
      response = new Response(`delete rejected ${target.E2B_API_KEY}`, { status });
      await expect(provider.terminate(target, handle)).rejects.toThrow(`E2B API ${status}`);
      await expect(provider.terminate(target, handle)).rejects.toThrow("[REDACTED");
    }
  });

  test("termination preserves transport errors", async () => {
    await server.stop(true);
    await expect(provider.terminate(target, handle)).rejects.toThrow();
  });
});
