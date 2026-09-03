import { describe, expect, test } from "bun:test";
import type { StatusAutomation } from "../../api/types";
import {
  automationDisplayName,
  automationFixText,
  automationMissingItems,
  automationMissingSummary,
  automationPurpose,
  findAutomation,
} from "../../lib/automation-setup";

const waitingSchedule: StatusAutomation = {
  id: "schedule-1",
  name: "weekly-dependabot-triage",
  kind: "schedule",
  state: "needs_setup",
  missing: { params: ["REPO_URL"], integrations: ["github"] },
  fixUrl: "/schedules/schedule-1?param=REPO_URL",
};

describe("automation setup helpers", () => {
  test("lists every missing parameter and integration", () => {
    expect(automationMissingItems(waitingSchedule)).toEqual(["REPO_URL", "github"]);
    expect(automationMissingSummary(waitingSchedule)).toBe("a repository URL and GitHub");
    expect(automationFixText(waitingSchedule)).toBe("Set a repository URL and connect GitHub.");
  });

  test("uses readable purpose and title text instead of the raw automation ID", () => {
    expect(automationDisplayName(waitingSchedule)).toBe("Weekly Dependabot Triage");
    expect(automationPurpose(waitingSchedule)).toBe(
      "Weekly Dependabot Triage runs on its configured schedule.",
    );
  });

  test("matches status automations by their stable key or display name", () => {
    expect(findAutomation([waitingSchedule], "schedule", "weekly-dependabot-triage")).toBe(
      waitingSchedule,
    );
    expect(
      findAutomation([waitingSchedule], "workflow", "weekly-dependabot-triage"),
    ).toBeUndefined();
  });
});
