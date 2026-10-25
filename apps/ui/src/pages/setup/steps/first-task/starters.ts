import { SUGGESTIONS } from "@/components/sessions/new-session-view";
import type { UseCase } from "@/lib/company-profile";

/** The step 2 answers a starter can name. Null when unset. */
export interface StarterProfile {
  company: string | null;
  website: string | null;
}

/**
 * Step 7 starter prompts for the use case picked in step 2. The first one of
 * each needs no repo, no issue list and no answer back: it names agents of
 * the `full` preset and hands the work from one to the next.
 */
const USE_CASE_STARTERS: Record<UseCase, (profile: StarterProfile) => string[]> = {
  features: () => [
    "Have the Coder write a one-page tech spec for a URL shortener, then the Reviewer check it for gaps",
    "Build a small feature from the issue list",
    "Add tests for the feature we shipped last",
  ],
  bugs: () => [
    "Have the Researcher list the 5 most common causes of flaky tests, then the Tester turn them into a checklist with a fix for each",
    "Fix a small bug from the issue list",
    "Find the root cause of a recent error",
  ],
  review: () => [
    "Have the Reviewer write a code review checklist for a small team, then the Tester add a section on test coverage",
    "Review the latest open PRs",
    "Summarize this week's merged PRs",
  ],
  ops: () => [
    "Have the Forward Deployed Engineer write a runbook template for a noisy alert, then the Reviewer check it for missing steps",
    "Find size wins in our Dockerfiles",
    "Audit our dependencies for known risks",
  ],
  data: () => [
    "Have the Coder write a script that summarizes any CSV file, then the Tester try it on a sample file it makes",
    "Write a script for a weekly metrics report",
    "Speed up a slow data pipeline step",
  ],
  content: ({ company, website }) => [
    website
      ? `Have the Content Strategist read ${website} and pick 3 LinkedIn post ideas for ${company ?? website}, then the Content Writer draft them`
      : "Have the Content Strategist pick 3 LinkedIn post ideas about AI agents at work, then the Content Writer draft them",
    "Plan a 4-week content calendar",
    "Turn a long document into 3 short posts",
  ],
  research: ({ website }) => [
    website
      ? `Have the Researcher compare the 3 closest competitors to ${website}, then the Content Writer turn it into a one-page brief`
      : "Have the Researcher map the AI agent market, then the Content Writer turn it into a one-page brief",
    "Research a tool we are thinking of buying",
    "Summarize a long report into its key points",
  ],
  seo: ({ website }) => [
    website
      ? `Have the Discoverability Optimizer audit ${website} for SEO quick wins, then the Content Writer draft the new page titles and descriptions`
      : "Have the Discoverability Optimizer write an SEO checklist for a new website, then the Content Writer add page title templates",
    "Find 10 search terms we could rank for",
    "Write meta descriptions for our main pages",
  ],
  docs: ({ website }) => [
    website
      ? `Have the Researcher read ${website} and list the 10 most likely support questions, then the Content Writer draft the answers`
      : "Have the Content Writer draft a support FAQ template, then the Content Reviewer check it for clarity",
    "Update the README for a new contributor",
    "Write docs for an undocumented module",
  ],
  admin: ({ company }) => [
    `Have the Content Writer draft a weekly team update template for ${company ?? "a small team"}, then the Content Reviewer make it shorter`,
    "Draft a polite reply to a meeting request",
    "Turn meeting notes into a list of action items",
  ],
};

/** The use case's starters, else the general new-session suggestions. */
export function firstTaskStarters(
  useCase: UseCase | null,
  profile: StarterProfile = { company: null, website: null },
): string[] {
  return useCase ? USE_CASE_STARTERS[useCase](profile) : SUGGESTIONS;
}
