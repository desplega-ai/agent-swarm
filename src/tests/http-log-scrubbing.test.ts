import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { createBunSqliteClient } from "../be/db-client";
import { formatStallLine, withLoopPath } from "../be/event-loop-lag";
import {
  getPathSegments,
  loopPathForRequest,
  redactShareTokenInPath,
  safeRequestUrlForLog,
} from "../http/utils";

describe("safeRequestUrlForLog", () => {
  test("redacts invite codes in request logs and the OTel path attribute", () => {
    for (const suffix of ["", "/", "/extra"]) {
      expect(safeRequestUrlForLog(`/invite/example_invite_code${suffix}?code=secret`)).toBe(
        `/invite/[REDACTED]${suffix}?code=[REDACTED]`,
      );
      expect(redactShareTokenInPath(`/invite/example_invite_code${suffix}`)).toBe(
        `/invite/[REDACTED]${suffix}`,
      );
    }
    expect(safeRequestUrlForLog("/invite")).toBe("/invite");
    expect(safeRequestUrlForLog("/api/invites")).toBe("/api/invites");
  });
  test("redacts OAuth callback query values", () => {
    expect(
      safeRequestUrlForLog(
        "/api/trackers/jira/callback?state=opaque-state-value&code=oauth-code-value",
      ),
    ).toBe("/api/trackers/jira/callback?state=[REDACTED]&code=[REDACTED]");
  });

  test("preserves paths without query strings", () => {
    expect(safeRequestUrlForLog("/api/trackers/jira/authorize")).toBe(
      "/api/trackers/jira/authorize",
    );
  });

  test("redacts every query parameter value in order", () => {
    expect(safeRequestUrlForLog("/mcp?session=abc&session=def&token=secret")).toBe(
      "/mcp?session=[REDACTED]&session=[REDACTED]&token=[REDACTED]",
    );
  });

  test("redacts the agent-fs share token after /share/ and /site/", () => {
    expect(safeRequestUrlForLog("/share/tok_secret123/raw")).toBe("/share/[REDACTED]/raw");
    expect(safeRequestUrlForLog("/site/tok_secret123/")).toBe("/site/[REDACTED]/");
    expect(safeRequestUrlForLog("/site/tok_secret123/a/index.html?v=1")).toBe(
      "/site/[REDACTED]/a/index.html?v=[REDACTED]",
    );
  });

  test("redacts the share token behind the /agentfs proxy prefix", () => {
    expect(safeRequestUrlForLog("/agentfs/share/tok_secret123")).toBe("/agentfs/share/[REDACTED]");
    expect(safeRequestUrlForLog("/agentfs/site/tok_secret123/x.css")).toBe(
      "/agentfs/site/[REDACTED]/x.css",
    );
  });

  test("leaves other share-like paths alone", () => {
    expect(safeRequestUrlForLog("/share")).toBe("/share");
    expect(safeRequestUrlForLog("/api/share/abc")).toBe("/api/share/abc");
    expect(safeRequestUrlForLog("/agentfs/orgs/o/share")).toBe("/agentfs/orgs/o/share");
  });
});

describe("loopPathForRequest", () => {
  const TOKEN = "credential_token_value_123"; // gitleaks:allow (synthetic test fixture)
  const cases: Array<[string, string]> = [
    [`/invite/${TOKEN}`, "http GET invite/[REDACTED]"],
    [`/invite/${TOKEN}/extra?x=1`, "http GET invite/[REDACTED]/extra"],
    [`/share/${TOKEN}/page.html`, "http GET share/[REDACTED]/page.html"],
    [`/site/${TOKEN}/index.html`, "http GET site/[REDACTED]/index.html"],
    [`/agentfs/share/${TOKEN}/a/b`, "http GET agentfs/share/[REDACTED]"],
    [`/agentfs/site/${TOKEN}`, "http GET agentfs/site/[REDACTED]"],
  ];

  for (const [url, expected] of cases) {
    test(`redacts the credential in ${url.split("/").slice(0, -1).join("/") || url}`, () => {
      const label = loopPathForRequest("GET", getPathSegments(url));
      expect(label).toBe(expected);
      expect(label).not.toContain(TOKEN);
    });
  }

  test("keeps ordinary routes and bounds them to three segments", () => {
    expect(loopPathForRequest("POST", getPathSegments("/api/tasks/abc-123/progress"))).toBe(
      "http POST api/tasks/abc-123",
    );
  });

  test("no credential reaches the stall line or the slow-statement line", async () => {
    const raw = new Database(":memory:");
    const client = createBunSqliteClient(() => raw);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [url] of cases) {
        const label = loopPathForRequest("GET", getPathSegments(url));
        expect(formatStallLine(1500, [{ path: label, sql: "SELECT 1", ms: 1200 }])).not.toContain(
          TOKEN,
        );
        await withLoopPath(label, () =>
          client.get(
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c",
            [3_000_000],
          ),
        );
      }
      const slow = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((l) => l.includes("[db-client] slow sync statement"));
      // Guard the premise: each request ran a statement slow enough to log.
      expect(slow).toHaveLength(cases.length);
      for (const line of slow) {
        expect(line).toContain("[REDACTED]");
        expect(line).not.toContain(TOKEN);
      }
    } finally {
      warn.mockRestore();
      raw.close();
    }
  }, 30_000);
});
