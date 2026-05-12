/**
 * Phase 3: Smart empty-state template recommendations.
 *
 * Maps detected integrations (from `/status`) to a starter template the user
 * is most likely to want next. Pure logic — consumed by `/templates`,
 * `/tasks`, `/workflows` empty states and the home "First steps" section.
 *
 * Decision rule (priority order, first match wins):
 *   1. slack + github → pr-triage
 *   2. linear + github → issue-to-pr
 *   3. jira → bug-intake
 *   4. (fallback) → hello-world
 *
 * "Detected" means a milestone state of `configured` OR `verified` (NOT
 * `unverified`). Slack-alone or GitHub-alone deliberately fall through to
 * `hello-world` — promoting a template that requires the *other* integration
 * is a usability trap.
 *
 * Adding a new TemplateId requires creating a matching record in
 * `templates/official/<id>/config.json`; the unit test in
 * `src/tests/template-recommendations.test.ts` enforces the contract.
 */

import type { SetupMilestone, StatusResponse } from "@/api/types";

/** Integrations the recommendation engine looks at. Subset of `MilestoneId`. */
export type DetectedIntegration = "slack" | "github" | "linear" | "jira";

/**
 * The four starter templates we recommend. Each value MUST resolve to a real
 * record in `templates/official/<id>/config.json` (enforced by unit test).
 */
export type TemplateId = "pr-triage" | "issue-to-pr" | "bug-intake" | "hello-world";

export interface Recommendation {
  templateId: TemplateId;
  reason: string;
}

interface Rule {
  requires: DetectedIntegration[];
  templateId: TemplateId;
  reason: string;
}

/**
 * Priority-ordered rules. First rule whose `requires` are all satisfied wins.
 * Empty `requires` is the implicit fallback (handled separately so the type
 * stays honest about non-empty rule sets).
 */
const RULES: readonly Rule[] = [
  {
    requires: ["slack", "github"],
    templateId: "pr-triage",
    reason: "You have Slack + GitHub — start with PR triage.",
  },
  {
    requires: ["linear", "github"],
    templateId: "issue-to-pr",
    reason: "You have Linear + GitHub — start with the Issue → PR template.",
  },
  {
    requires: ["jira"],
    templateId: "bug-intake",
    reason: "You have Jira — start with the Bug intake template.",
  },
] as const;

const FALLBACK: Recommendation = {
  templateId: "hello-world",
  reason: "Start with a no-integration Hello World.",
};

/**
 * Derive the set of integrations to feed into `recommendTemplates`. A
 * milestone counts as "detected" if it's `configured` OR `verified`.
 */
export function detectedFromStatus(status: StatusResponse): Set<DetectedIntegration> {
  const detected = new Set<DetectedIntegration>();
  for (const milestone of status.setup) {
    if (!isDetectableIntegration(milestone)) continue;
    if (milestone.state === "configured" || milestone.state === "verified") {
      detected.add(milestone.id);
    }
  }
  return detected;
}

function isDetectableIntegration(
  milestone: SetupMilestone,
): milestone is SetupMilestone & { id: DetectedIntegration } {
  return (
    milestone.id === "slack" ||
    milestone.id === "github" ||
    milestone.id === "linear" ||
    milestone.id === "jira"
  );
}

/**
 * Returns recommendations in priority order. Always returns at least one
 * entry (the fallback `hello-world` when no rule matches).
 */
export function recommendTemplates(detected: Set<DetectedIntegration>): Recommendation[] {
  const matches: Recommendation[] = [];
  for (const rule of RULES) {
    if (rule.requires.every((i) => detected.has(i))) {
      matches.push({ templateId: rule.templateId, reason: rule.reason });
    }
  }
  if (matches.length === 0) return [FALLBACK];
  return matches;
}

/** Convenience for callers that only care about the top recommendation. */
export function topRecommendation(status: StatusResponse): Recommendation {
  const detected = detectedFromStatus(status);
  const recs = recommendTemplates(detected);
  // recommendTemplates always returns ≥ 1 item — fall back defensively.
  return recs[0] ?? FALLBACK;
}
