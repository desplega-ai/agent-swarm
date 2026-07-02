import { describe, expect, test } from "bun:test";
import { safeRequestUrlForLog } from "../http/utils";

describe("safeRequestUrlForLog", () => {
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
});
