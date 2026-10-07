import { describe, expect, test } from "bun:test";
import { countCodexOAuthPoolSlots } from "../providers/codex-oauth/env-keys";

const slot = (access: string) =>
  JSON.stringify({ access, refresh: "rt.secret", expires: 1, accountId: "acct" });

describe("countCodexOAuthPoolSlots", () => {
  test("counts a legacy-only codex_oauth row as slot 0", () => {
    expect(countCodexOAuthPoolSlots([{ key: "codex_oauth", value: slot("legacy") }])).toBe(1);
  });

  test("does not double-count the legacy row next to codex_oauth_0", () => {
    expect(
      countCodexOAuthPoolSlots([
        { key: "codex_oauth", value: slot("legacy") },
        { key: "codex_oauth_0", value: slot("a0") },
      ]),
    ).toBe(1);
  });

  test("skips a legacy row with an empty access token", () => {
    expect(countCodexOAuthPoolSlots([{ key: "codex_oauth", value: slot("") }])).toBe(0);
  });

  test("counts the legacy row alongside higher slots when codex_oauth_0 is absent", () => {
    expect(
      countCodexOAuthPoolSlots([
        { key: "codex_oauth", value: slot("legacy") },
        { key: "codex_oauth_1", value: slot("a1") },
      ]),
    ).toBe(2);
  });
});
