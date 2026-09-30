import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import {
  isReservedNamespace,
  reservedNamespaceError,
  reservedRoomKeyError,
} from "../kv-reserved-namespaces";
import { can } from "../rbac";
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

  test("reserves the comb namespace family for Comb's send claims", () => {
    expect(isReservedNamespace("comb")).toBe(true);
    expect(isReservedNamespace("comb:sent")).toBe(true);
    expect(reservedNamespaceError("comb:sent")).toContain("Comb");
    expect(reservedNamespaceError("apps")).toContain("swarm apps");
    expect(isReservedNamespace("combo")).toBe(false);
    expect(isReservedNamespace("user:comb")).toBe(false);
  });

  test("limits Comb presence namespaces to dashboard presence operations", async () => {
    const previous = process.env.RBAC_ENABLED;
    process.env.RBAC_ENABLED = "false";
    const namespace = "presence:comb:org_123:drive-456";
    try {
      await expect(
        authorizeRoomNamespace(namespace, { isOperator: true, callOrigin: "ws" }, "join"),
      ).resolves.toBeNull();
      await expect(
        authorizeRoomNamespace(namespace, { userId: "user-1", callOrigin: "ws" }, "presence"),
      ).resolves.toBeNull();
      await expect(
        authorizeRoomNamespace(namespace, { isOperator: true, callOrigin: "ws" }, "update"),
      ).resolves.toContain("only allow");
      await expect(
        authorizeRoomNamespace(namespace, { isOperator: true, callOrigin: "ws" }, "publish"),
      ).resolves.toContain("only allow");
      await expect(
        authorizeRoomNamespace(namespace, { agentId: "agent-1", callOrigin: "ws" }, "join"),
      ).resolves.toContain("dashboard authentication");
      await expect(
        authorizeRoomNamespace(
          namespace,
          { pageId: "page-1", userId: "user-1", callOrigin: "ws" },
          "join",
        ),
      ).resolves.toContain("dashboard authentication");
      await expect(
        authorizeRoomNamespace(
          "presence:comb:org:drive:extra",
          { isOperator: true, callOrigin: "ws" },
          "join",
        ),
      ).resolves.toContain("invalid");
    } finally {
      if (previous === undefined) delete process.env.RBAC_ENABLED;
      else process.env.RBAC_ENABLED = previous;
    }
  });

  test("allows Comb presence for humans and denies agents in the legacy policy", () => {
    const resource = { kind: "kv-namespace", namespace: "presence:comb:org:drive" } as const;
    expect(
      can({ principal: { kind: "operator" }, verb: "comb.presence", resource, source: "http" }),
    ).toEqual({ allow: true });
    expect(
      can({
        principal: { kind: "user", userId: "user-1" },
        verb: "comb.presence",
        resource,
        source: "http",
      }),
    ).toEqual({ allow: true });
    expect(
      can({
        principal: { kind: "agent", agentId: "agent-1", isLead: true },
        verb: "comb.presence",
        resource,
        source: "http",
      }),
    ).toMatchObject({ allow: false, missing: "comb.presence" });
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
    process.env.RBAC_ENABLED = "false";
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
