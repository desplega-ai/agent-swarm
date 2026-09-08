import { describe, expect, test } from "bun:test";
import {
  type IdentityProfileFields,
  type IdentityRefreshContext,
  refreshIdentityIfChanged,
} from "../commands/identity-refresh.ts";

const cached: IdentityProfileFields = {
  soulMd: "old soul",
  identityMd: "old identity",
  toolsMd: "old tools",
  claudeMd: "old notes",
  heartbeatMd: "old heartbeat",
  name: "worker",
  description: "old description",
};
const context: IdentityRefreshContext = {
  apiUrl: "http://identity.invalid",
  apiKey: "test-key",
  agentId: "38d36438-58a0-45b5-8602-a5d52b07c2f1",
  role: "worker",
  timeoutMs: 20,
};
function responseFetch(payload: unknown): typeof fetch {
  return (async () => Response.json(payload)) as typeof fetch;
}

describe("refreshIdentityIfChanged", () => {
  test("merges changed prompt fields without mutating the previous task identity", async () => {
    const result = await refreshIdentityIfChanged(
      { ...context, fetchImpl: responseFetch({ soulMd: "new soul", name: "new name" }) },
      cached,
    );
    expect(result.changedFields).toEqual(["soulMd", "name"]);
    expect(result.fields).toEqual({ ...cached, soulMd: "new soul", name: "new name" });
    expect(cached.soulMd).toBe("old soul");
  });

  test("omitted fields preserve cached values and identical fields report no change", async () => {
    for (const payload of [{}, cached, { unrelated: "ignored" }]) {
      const result = await refreshIdentityIfChanged(
        { ...context, fetchImpl: responseFetch(payload) },
        cached,
      );
      expect(result).toEqual({ changed: false, fields: cached, changedFields: [] });
      expect(result.fields).toBe(cached);
    }
  });

  test("empty strings clear toolsMd, claudeMd and heartbeatMd without treating them as omitted", async () => {
    const cleared = { toolsMd: "", claudeMd: "", heartbeatMd: "" };
    const result = await refreshIdentityIfChanged(
      { ...context, fetchImpl: responseFetch(cleared) },
      cached,
    );
    expect(result.changedFields).toEqual(["toolsMd", "claudeMd", "heartbeatMd"]);
    expect(result.fields).toEqual({ ...cached, ...cleared });
  });

  test("null JSON preserves the cached identity without throwing", async () => {
    const result = await refreshIdentityIfChanged(
      { ...context, fetchImpl: responseFetch(null) },
      cached,
    );
    expect(result.changed).toBe(false);
    expect(result.fields).toBe(cached);
  });

  test("non-record or invalid field payloads cannot partially corrupt the cache", async () => {
    for (const payload of [[], "text", 42, { soulMd: "new", toolsMd: null }, { name: 42 }]) {
      const result = await refreshIdentityIfChanged(
        { ...context, fetchImpl: responseFetch(payload) },
        cached,
      );
      expect(result.fields).toBe(cached);
      expect(result.changed).toBe(false);
    }
  });

  test("HTTP, transport and JSON errors preserve the cached identity", async () => {
    const fetches = [
      async () => new Response("unavailable", { status: 503 }),
      async () => {
        throw new Error("offline");
      },
      async () => new Response("invalid json"),
    ];
    for (const fetchImpl of fetches) {
      const result = await refreshIdentityIfChanged(
        { ...context, fetchImpl: fetchImpl as typeof fetch },
        cached,
      );
      expect(result.fields).toBe(cached);
      expect(result.changed).toBe(false);
    }
  });

  test("a hanging fetch reaches its deadline, aborts and returns cached identity", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = ((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const result = await refreshIdentityIfChanged({ ...context, fetchImpl }, cached);
    expect(result.fields).toBe(cached);
    expect(signal?.aborted).toBe(true);
  });

  test("a hanging response body shares the deadline and cannot update the cache later", async () => {
    let finishBody!: (payload: unknown) => void;
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_url, init) => {
      signal = init?.signal ?? undefined;
      return {
        ok: true,
        json: () =>
          new Promise((resolve) => {
            finishBody = resolve;
          }),
      } as Response;
    }) as typeof fetch;
    const result = await refreshIdentityIfChanged({ ...context, fetchImpl }, cached);
    expect(result.fields).toBe(cached);
    expect(signal?.aborted).toBe(true);
    finishBody({ soulMd: "late stale response" });
    await Promise.resolve();
    expect(result.fields.soulMd).toBe("old soul");
  });

  test("sends agent authentication and cancels the deadline after a successful read", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (url, init) => {
      expect(url).toBe(`${context.apiUrl}/me`);
      expect(init?.headers).toEqual({
        "X-Agent-ID": context.agentId,
        Authorization: "Bearer test-key",
      });
      signal = init?.signal ?? undefined;
      return Response.json({ soulMd: "new" });
    }) as typeof fetch;
    await refreshIdentityIfChanged({ ...context, fetchImpl }, cached);
    await Bun.sleep(30);
    expect(signal?.aborted).toBe(false);
  });
});
