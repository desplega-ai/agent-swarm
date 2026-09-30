import { describe, expect, test } from "bun:test";
import { buildPoolRevalidationFailureReason } from "../providers/codex-adapter";
import { CodexOAuthRefreshError } from "../providers/codex-oauth/storage";
import { isCodexAuthFailureReason } from "../utils/codex-auth-failure";

describe("isCodexAuthFailureReason", () => {
  test.each([
    "[auth-error] Codex authentication failed — check OPENAI_API_KEY or ChatGPT login. Original error: workspace routing discovery unauthorized (401)",
    "[auth-error] Codex authentication failed — check OPENAI_API_KEY or ChatGPT login. Original error: Failed to refresh token: 400 Bad Request: Invalid 'refresh_token': empty string",
    '[auth-error] Codex pool slot 2 [...d3Ove] revalidation failed: refresh rejected (401 {"error":"refresh_token_invalidated"}) — credential likely revoked; re-run codex-login for this slot.',
  ])("counts %s", (reason) => {
    expect(isCodexAuthFailureReason(reason)).toBe(true);
  });

  test.each([
    undefined,
    null,
    "",
    "[rate-limit] Codex API rate limit hit. Original error: 429",
    "[auth-error] Codex pool slot 2 [...d3Ove] revalidation failed: timed out waiting for the refresh lock — transient, will retry on next task.",
    "[auth-error] Codex pool slot 2 [...d3Ove] revalidation failed: refresh rejected (429 Too Many Requests) — credential likely revoked; re-run codex-login for this slot.",
    "[auth-error] Codex pool slot 2 [...d3Ove] revalidation failed: refresh rejected (503 Service Unavailable) — credential likely revoked; re-run codex-login for this slot.",
    "[auth-error] Codex pool slot 2 [...d3Ove] revalidation failed: refresh rejected (unknown status ) — credential likely revoked; re-run codex-login for this slot.",
    "[auth-error] Codex pool slot 2 [...d3Ove] revalidation failed: no credentials found in config store — the slot may have just been quarantined; the next task will pick another slot.",
  ])("does not count %p", (reason) => {
    expect(isCodexAuthFailureReason(reason)).toBe(false);
  });

  test.each([
    ["network error", new TypeError("fetch failed")],
    ["refresh-lock HTTP error", new Error("refresh lock acquire failed: HTTP 502")],
    ["persistence error", new Error("Failed to store Codex OAuth credentials: 500")],
    ["lock timeout", new CodexOAuthRefreshError(2, "lock_timeout", "d3Ove")],
    ["throttled refresh", new CodexOAuthRefreshError(2, "refresh_rejected", "d3Ove", 429)],
    ["upstream refresh error", new CodexOAuthRefreshError(2, "refresh_rejected", "d3Ove", 503)],
  ])("a thrown %s during revalidation does not count", (_label, err) => {
    const reason = buildPoolRevalidationFailureReason(err, 2);
    expect(reason).toContain("[auth-error]");
    expect(isCodexAuthFailureReason(reason)).toBe(false);
  });

  test("a confirmed refresh rejection during revalidation counts", () => {
    const err = new CodexOAuthRefreshError(
      2,
      "refresh_rejected",
      "d3Ove",
      401,
      '{"error":"refresh_token_invalidated"}',
    );
    expect(isCodexAuthFailureReason(buildPoolRevalidationFailureReason(err, 2))).toBe(true);
  });
});
