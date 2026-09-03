import { describe, expect, test } from "bun:test";
import type { Agent } from "@/api/types";
import { getLeadCredentialIssue, shouldShowTaskFailureHelp } from "./task-support";

const baseLead: Agent = {
  id: "lead-1",
  name: "Lead",
  isLead: true,
  status: "waiting_for_credentials",
  createdAt: "2026-09-03T00:00:00.000Z",
  lastUpdatedAt: "2026-09-03T00:00:00.000Z",
};

describe("getLeadCredentialIssue", () => {
  test("returns the API-reported missing credentials and hint for an unready lead", () => {
    const issue = getLeadCredentialIssue(
      [
        {
          ...baseLead,
          harnessProvider: "claude",
          credStatus: {
            ready: false,
            missing: ["CLAUDE_CODE_OAUTH_TOKEN"],
            hint: "Run claude setup-token",
            reportedAt: 1,
          },
        },
      ],
      true,
    );

    expect(issue).toEqual({
      agentId: "lead-1",
      agentName: "Lead",
      provider: "claude",
      missing: ["CLAUDE_CODE_OAUTH_TOKEN"],
      hint: "Run claude setup-token",
    });
  });

  test("supports the legacy credentialMissing report", () => {
    const issue = getLeadCredentialIssue(
      [
        {
          ...baseLead,
          provider: "pi",
          credentialMissing: ["OPENROUTER_API_KEY"],
        },
      ],
      true,
    );

    expect(issue?.missing).toEqual(["OPENROUTER_API_KEY"]);
    expect(issue?.provider).toBe("pi");
  });

  test("does not inspect credential fields from an older API", () => {
    expect(
      getLeadCredentialIssue([{ ...baseLead, credentialMissing: ["OPENROUTER_API_KEY"] }], false),
    ).toBeNull();
  });
});

describe("shouldShowTaskFailureHelp", () => {
  test("shows for a failed task after confirming lead credentials are not the cause", () => {
    expect(shouldShowTaskFailureHelp("failed", true, null)).toBe(true);
  });

  test("waits for the credential check and defers to the credential popup", () => {
    const issue = getLeadCredentialIssue(
      [{ ...baseLead, credentialMissing: ["ANTHROPIC_API_KEY"] }],
      true,
    );

    expect(shouldShowTaskFailureHelp("failed", false, null)).toBe(false);
    expect(shouldShowTaskFailureHelp("failed", true, issue)).toBe(false);
    expect(shouldShowTaskFailureHelp("completed", true, null)).toBe(false);
  });
});
