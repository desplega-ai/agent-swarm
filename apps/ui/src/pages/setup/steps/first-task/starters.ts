import { SUGGESTIONS } from "@/components/sessions/new-session-view";
import type { UseCase } from "@/lib/company-profile";

/** Step 7 starter prompts for the use case picked in step 2. */
const USE_CASE_STARTERS: Record<UseCase, string[]> = {
  features: [
    "Draft a tech spec for a feature idea",
    "Build a small feature from the issue list",
    "Add tests for the feature we shipped last",
  ],
  bugs: [
    "Investigate a flaky test in the test suite",
    "Fix a small bug from the issue list",
    "Find the root cause of a recent error",
  ],
  review: [
    "Review the latest open PRs",
    "Summarize this week's merged PRs",
    "Check an open PR for missing tests",
  ],
  ops: [
    "Write a runbook for a noisy alert",
    "Find size wins in our Dockerfiles",
    "Audit our dependencies for known risks",
  ],
  docs: [
    "Update the README for a new contributor",
    "Write docs for an undocumented module",
    "Draft answers to common support questions",
  ],
  data: [
    "Explore a dataset and summarize what is in it",
    "Write a script for a weekly metrics report",
    "Speed up a slow data pipeline step",
  ],
};

/** The use case's starters, else the general new-session suggestions. */
export function firstTaskStarters(useCase: UseCase | null): string[] {
  return useCase ? USE_CASE_STARTERS[useCase] : SUGGESTIONS;
}
