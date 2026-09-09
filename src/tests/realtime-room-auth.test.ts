import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { isReservedNamespace, reservedRoomKeyError } from "../kv-reserved-namespaces";
import { authorizeRoomNamespace, resolveRoomNamespace, roomRequestInfo } from "../realtime/auth";

describe("realtime room namespace guards", () => {
  test("pins page requests to the page namespace", async () => {
    const resolved = await resolveRoomNamespace("task:agent:other", { pageId: "page-1" });
    expect(resolved).toEqual({ namespace: "task:page:page-1", source: "page" });
  });

  test("allows explicit namespaces for authenticated agents", async () => {
    const resolved = await resolveRoomNamespace("task:page:page-1", { agentId: "agent-1" });
    expect(resolved).toEqual({ namespace: "task:page:page-1", source: "explicit" });
  });

  test("rejects room writes without an agent identity", async () => {
    await expect(
      authorizeRoomNamespace("task:page:page-1", { callOrigin: "http" }, true),
    ).resolves.toBe("page room writes require an authenticated agent");
  });

  test("protects room snapshot keys from generic KV writes", () => {
    expect(reservedRoomKeyError("_room/board")).toContain("reserved");
    expect(reservedRoomKeyError("user/board")).toBeNull();
  });

  test("retains the apps namespace reservation", () => {
    expect(isReservedNamespace("apps:demo")).toBe(true);
  });

  test("does not trust an agent header from a user bearer request", () => {
    const req = {
      headers: { "x-agent-id": "spoofed-agent" },
    } as unknown as IncomingMessage;
    expect(
      roomRequestInfo(req, {
        kind: "user",
        userId: "user-1",
        user: {} as never,
      }),
    ).toEqual({ agentId: undefined, sourceTaskId: undefined, pageId: undefined });
  });

  test("allows page writes for user and operator contexts when RBAC is disabled", async () => {
    const previous = process.env.RBAC_ENABLED;
    delete process.env.RBAC_ENABLED;
    try {
      await expect(
        authorizeRoomNamespace(
          "task:page:page-1",
          { pageId: "page-1", userId: "user-1", callOrigin: "http" },
          true,
        ),
      ).resolves.toBeNull();
      await expect(
        authorizeRoomNamespace(
          "task:page:page-1",
          { pageId: "page-1", isOperator: true, callOrigin: "http" },
          true,
        ),
      ).resolves.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.RBAC_ENABLED;
      else process.env.RBAC_ENABLED = previous;
    }
  });
});
