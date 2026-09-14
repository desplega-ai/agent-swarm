import { describe, expect, spyOn, test } from "bun:test";
import { revokeAcpSessionToken } from "../utils/acp-session-token";

describe("ACP session token revocation", () => {
  test("logs HTTP 503 without rejecting or disclosing credentials", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("sensitive body", { status: 503 }),
    });
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        revokeAcpSessionToken(server.url.origin, "test-operator-key", "test-token-id"),
      ).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalled();
      const log = JSON.stringify(warning.mock.calls);
      expect(log).toContain("Session token revoke failed");
      expect(log).toContain("503");
      expect(log).not.toContain("test-operator-key");
      expect(log).not.toContain("sensitive body");
    } finally {
      warning.mockRestore();
      server.stop(true);
    }
  });

  test("logs connection failure against a stopped server without rejecting", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
    const url = server.url.origin;
    await server.stop(true);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        revokeAcpSessionToken(url, "test-operator-key", "test-token-id"),
      ).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalled();
      expect(JSON.stringify(warning.mock.calls)).toContain("Session token revoke failed");
    } finally {
      warning.mockRestore();
    }
  });

  test("aborts a stalled revoke request within its timeout and logs the failure", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    // Exercise the real fetch cancellation with a short test-only clock budget.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(25));
    try {
      const pending = revokeAcpSessionToken(
        server.url.origin,
        "test-operator-key",
        "test-token-id",
      );
      expect(timeout).toHaveBeenCalled();
      expect(timeout.mock.calls[0]![0]).toBeGreaterThan(0);
      expect(timeout.mock.calls[0]![0]).toBeLessThanOrEqual(5000);
      await expect(pending).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalled();
      expect(JSON.stringify(warning.mock.calls)).toContain("Session token revoke failed");
    } finally {
      server.stop(true);
      timeout.mockRestore();
      warning.mockRestore();
    }
  });
});
