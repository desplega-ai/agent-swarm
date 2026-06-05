import { describe, expect, test } from "bun:test";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeIdleMcpTransports } from "../http/mcp";
import { closeIdleMcpUserTransports } from "../http/mcp-user";

function fakeTransport(onClose: () => void): StreamableHTTPServerTransport {
  return {
    close: onClose,
  } as StreamableHTTPServerTransport;
}

describe("MCP transport idle GC", () => {
  test("closes and deletes stale owner transports", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      fresh: fakeTransport(() => closed.push("fresh")),
      stale: fakeTransport(() => closed.push("stale")),
      unknown: fakeTransport(() => closed.push("unknown")),
    };
    const activity = {
      fresh: 9_500,
      stale: 1_000,
    };

    const removed = closeIdleMcpTransports(transports, activity, {
      now: 10_000,
      idleTimeoutMs: 1_000,
    });

    expect(removed).toBe(1);
    expect(closed).toEqual(["stale"]);
    expect(transports.stale).toBeUndefined();
    expect(activity.stale).toBeUndefined();
    expect(transports.fresh).toBeDefined();
    expect(transports.unknown).toBeDefined();
    expect(activity.unknown).toBe(10_000);
  });

  test("deletes user ownership metadata for stale user transports", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      stale: fakeTransport(() => closed.push("stale")),
    };
    const sessionUsers = { stale: "user_1" };
    const activity = { stale: 1_000 };

    const removed = closeIdleMcpUserTransports(transports, sessionUsers, activity, {
      now: 10_000,
      idleTimeoutMs: 1_000,
    });

    expect(removed).toBe(1);
    expect(closed).toEqual(["stale"]);
    expect(transports.stale).toBeUndefined();
    expect(sessionUsers.stale).toBeUndefined();
    expect(activity.stale).toBeUndefined();
  });
});
