import { describe, expect, test } from "bun:test";
import { redactShareTokenInPath, safeRequestUrlForLog } from "../http/utils";

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
