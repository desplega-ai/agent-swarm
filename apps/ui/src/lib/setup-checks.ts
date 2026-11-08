// The setup checks behind the header health badge, also listed as the first
// phase of Home's "Getting started".

import type { MilestoneId, SetupMilestone, StatusResponse } from "../api/types";

export interface FailingCheck {
  /** A setup milestone, or `lead`: no lead can take work (`activity.leads_ready`). */
  milestone: Omit<SetupMilestone, "id"> & { id: MilestoneId | "lead" };
  /** `true` turns the badge red: no task can run. */
  blocks: boolean;
}

/** The checks behind a red or amber badge, by the rules of `computeHealth` in src/http/status.ts. */
export function failingChecks({ setup, activity }: StatusResponse): FailingCheck[] {
  const checks = setup.flatMap((milestone): FailingCheck[] => {
    const { id, state } = milestone;
    if ((id === "harness" || id === "workers") && state === "unverified") {
      return [{ milestone, blocks: true }];
    }
    if (["harness", "slack", "github", "linear", "jira"].includes(id) && state === "configured") {
      return [{ milestone, blocks: false }];
    }
    return [];
  });
  // With no agents at all, the workers check already says it.
  const noAgents = setup.some((m) => m.id === "workers" && m.state === "unverified");
  if (activity.leads_ready === 0 && !noAgents) {
    checks.push({
      milestone: {
        id: "lead",
        label: "No lead online",
        state: "unverified",
        hint: "Start the lead. New tasks wait until it is online.",
        action_url: "/agents",
      },
      blocks: false,
    });
  }
  return checks;
}
