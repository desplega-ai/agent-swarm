import { describe, expect, test } from "bun:test";
import { matchRoute } from "../http/utils";

describe("matchRoute", () => {
  // --- Method matching ---
  test("matches correct HTTP method", () => {
    expect(matchRoute("GET", ["api", "config"], "GET", ["api", "config"])).toBe(true);
  });

  test("rejects wrong HTTP method", () => {
    expect(matchRoute("POST", ["api", "config"], "GET", ["api", "config"])).toBe(false);
  });

  // --- Literal segment matching ---
  test("matches all literal segments", () => {
    expect(
      matchRoute("GET", ["api", "config", "resolved"], "GET", ["api", "config", "resolved"]),
    ).toBe(true);
  });

  test("rejects when a literal segment differs", () => {
    expect(
      matchRoute("GET", ["api", "config", "other"], "GET", ["api", "config", "resolved"]),
    ).toBe(false);
  });

  test("rejects when path is shorter than pattern", () => {
    expect(matchRoute("GET", ["api"], "GET", ["api", "config"])).toBe(false);
  });

  // --- Dynamic segment matching (null) ---
  test("null matches any truthy segment", () => {
    expect(matchRoute("GET", ["api", "config", "abc-123"], "GET", ["api", "config", null])).toBe(
      true,
    );
  });

  test("null rejects missing segment", () => {
    expect(matchRoute("GET", ["api", "config"], "GET", ["api", "config", null])).toBe(false);
  });

  test("null rejects empty string segment", () => {
    expect(matchRoute("GET", ["api", "config", ""], "GET", ["api", "config", null])).toBe(false);
  });

  // --- Exact mode ---
  test("exact mode rejects trailing segments", () => {
    expect(matchRoute("GET", ["api", "config", "extra"], "GET", ["api", "config"], true)).toBe(
      false,
    );
  });

  test("exact mode accepts exact segment count", () => {
    expect(matchRoute("GET", ["api", "config"], "GET", ["api", "config"], true)).toBe(true);
  });

  test("non-exact mode allows trailing segments", () => {
    expect(matchRoute("GET", ["api", "config", "extra"], "GET", ["api", "config"])).toBe(true);
  });

  // --- Mixed literal + dynamic patterns ---
  test("matches pattern with dynamic param in the middle", () => {
    expect(
      matchRoute("PUT", ["api", "agents", "uuid-123", "profile"], "PUT", [
        "api",
        "agents",
        null,
        "profile",
      ]),
    ).toBe(true);
  });

  test("rejects when action segment differs in mixed pattern", () => {
    expect(
      matchRoute("PUT", ["api", "agents", "uuid-123", "name"], "PUT", [
        "api",
        "agents",
        null,
        "profile",
      ]),
    ).toBe(false);
  });

  // --- Deep route with multiple dynamic segments ---
  test("matches deep route: GET /api/channels/:id/messages/:messageId/thread", () => {
    expect(
      matchRoute("GET", ["api", "channels", "ch-1", "messages", "msg-2", "thread"], "GET", [
        "api",
        "channels",
        null,
        "messages",
        null,
        "thread",
      ]),
    ).toBe(true);
  });

  test("rejects deep route when dynamic segment is missing", () => {
    expect(
      matchRoute("GET", ["api", "channels", "ch-1", "messages"], "GET", [
        "api",
        "channels",
        null,
        "messages",
        null,
        "thread",
      ]),
    ).toBe(false);
  });

  // --- Exact + dynamic combo ---
  test("exact mode with dynamic param accepts correct length", () => {
    expect(matchRoute("GET", ["api", "repos", "uuid-1"], "GET", ["api", "repos", null], true)).toBe(
      true,
    );
  });

  test("exact mode with dynamic param rejects trailing", () => {
    expect(
      matchRoute("GET", ["api", "repos", "uuid-1", "extra"], "GET", ["api", "repos", null], true),
    ).toBe(false);
  });

  // --- Edge cases ---
  test("empty pathSegments only matches empty pattern", () => {
    expect(matchRoute("GET", [], "GET", [])).toBe(true);
    expect(matchRoute("GET", [], "GET", ["api"])).toBe(false);
  });

  test("empty pattern matches any path in non-exact mode", () => {
    expect(matchRoute("GET", ["api", "config"], "GET", [])).toBe(true);
  });

  test("empty pattern rejects non-empty path in exact mode", () => {
    expect(matchRoute("GET", ["api"], "GET", [], true)).toBe(false);
  });

  // --- Real-world route patterns from the codebase ---
  describe("real-world routes", () => {
    test("GET /api/config/resolved (exact)", () => {
      const ps = ["api", "config", "resolved"];
      expect(matchRoute("GET", ps, "GET", ["api", "config", "resolved"], true)).toBe(true);
      expect(matchRoute("GET", [...ps, "extra"], "GET", ["api", "config", "resolved"], true)).toBe(
        false,
      );
    });

    test("GET /api/config/:id (exact)", () => {
      expect(
        matchRoute("GET", ["api", "config", "some-id"], "GET", ["api", "config", null], true),
      ).toBe(true);
      expect(matchRoute("GET", ["api", "config"], "GET", ["api", "config", null], true)).toBe(
        false,
      );
    });

    test("DELETE /api/active-sessions/by-task/:taskId (non-exact)", () => {
      expect(
        matchRoute("DELETE", ["api", "active-sessions", "by-task", "t-1"], "DELETE", [
          "api",
          "active-sessions",
          "by-task",
          null,
        ]),
      ).toBe(true);
    });

    test("POST /api/tasks/:id/finish (non-exact)", () => {
      expect(
        matchRoute("POST", ["api", "tasks", "t-1", "finish"], "POST", [
          "api",
          "tasks",
          null,
          "finish",
        ]),
      ).toBe(true);
    });

    test("GET /api/tasks/:id (non-exact, no length guard)", () => {
      // This should match even with trailing segments (preserving original behavior)
      expect(matchRoute("GET", ["api", "tasks", "t-1"], "GET", ["api", "tasks", null])).toBe(true);
      expect(
        matchRoute("GET", ["api", "tasks", "t-1", "extra"], "GET", ["api", "tasks", null]),
      ).toBe(true);
    });
  });
});
