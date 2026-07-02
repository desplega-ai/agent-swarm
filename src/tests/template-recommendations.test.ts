/**
 * Phase 3 — unit tests for `apps/ui/src/lib/template-recommendations.ts`.
 *
 * Lives in `src/tests/` (not under `apps/ui/`) because `apps/ui/` has no test runner
 * configured. The recommendation lib is pure logic with only a `StatusResponse`
 * type import, so the cross-tree relative import works without aliases.
 */

import { describe, expect, test } from "bun:test";
import type { StatusResponse } from "../../apps/ui/src/api/types.ts";
import {
  type DetectedIntegration,
  detectedFromStatus,
  recommendTemplates,
  topRecommendation,
} from "../../apps/ui/src/lib/template-recommendations.ts";

function makeStatus(overrides: {
  slack?: "unverified" | "configured" | "verified";
  github?: "unverified" | "configured" | "verified";
  linear?: "unverified" | "configured" | "verified";
  jira?: "unverified" | "configured" | "verified";
}): StatusResponse {
  return {
    identity: {
      name: "Swarm",
      logo_url: null,
      brand_color: null,
      is_cloud: false,
      marketing_url: null,
      hide_cloud_promo: false,
      org_id: null,
    },
    setup: [
      { id: "harness", label: "Harness", state: "unverified" },
      { id: "slack", label: "Slack", state: overrides.slack ?? "unverified" },
      { id: "github", label: "GitHub", state: overrides.github ?? "unverified" },
      { id: "linear", label: "Linear", state: overrides.linear ?? "unverified" },
      { id: "jira", label: "Jira", state: overrides.jira ?? "unverified" },
      { id: "workers", label: "Workers", state: "unverified" },
      { id: "first_task", label: "First task", state: "unverified" },
    ],
    activity: { agents_online: 0, leads_online: 0, recent_tasks_count: 0 },
    agent_fs: { configured: false, base_url: null },
    health: "broken",
  };
}

describe("recommendTemplates — priority rules", () => {
  test("slack + github → pr-triage", () => {
    const recs = recommendTemplates(new Set<DetectedIntegration>(["slack", "github"]));
    expect(recs[0]?.templateId).toBe("pr-triage");
  });

  test("linear + github → issue-to-pr", () => {
    const recs = recommendTemplates(new Set<DetectedIntegration>(["linear", "github"]));
    expect(recs[0]?.templateId).toBe("issue-to-pr");
  });

  test("jira → bug-intake", () => {
    const recs = recommendTemplates(new Set<DetectedIntegration>(["jira"]));
    expect(recs[0]?.templateId).toBe("bug-intake");
  });

  test("empty set → hello-world fallback", () => {
    const recs = recommendTemplates(new Set<DetectedIntegration>());
    expect(recs).toHaveLength(1);
    expect(recs[0]?.templateId).toBe("hello-world");
    expect(recs[0]?.reason).toMatch(/hello world/i);
  });

  test("slack alone falls through to hello-world (no PR-triage promo without GitHub)", () => {
    const recs = recommendTemplates(new Set<DetectedIntegration>(["slack"]));
    expect(recs[0]?.templateId).toBe("hello-world");
  });

  test("github alone falls through to hello-world", () => {
    const recs = recommendTemplates(new Set<DetectedIntegration>(["github"]));
    expect(recs[0]?.templateId).toBe("hello-world");
  });

  test("linear alone falls through to hello-world", () => {
    const recs = recommendTemplates(new Set<DetectedIntegration>(["linear"]));
    expect(recs[0]?.templateId).toBe("hello-world");
  });

  test("priority — slack+github+linear matches pr-triage first, also matches issue-to-pr", () => {
    const recs = recommendTemplates(new Set<DetectedIntegration>(["slack", "github", "linear"]));
    // pr-triage comes first because slack+github rule is listed before linear+github.
    expect(recs[0]?.templateId).toBe("pr-triage");
    expect(recs.map((r) => r.templateId)).toContain("issue-to-pr");
  });

  test("all four detected — all three rule-based recs returned, no fallback", () => {
    const recs = recommendTemplates(
      new Set<DetectedIntegration>(["slack", "github", "linear", "jira"]),
    );
    const ids = recs.map((r) => r.templateId);
    expect(ids).toEqual(["pr-triage", "issue-to-pr", "bug-intake"]);
    expect(ids).not.toContain("hello-world");
  });
});

describe("detectedFromStatus", () => {
  test("verified milestones count as detected", () => {
    const status = makeStatus({ slack: "verified", github: "verified" });
    const detected = detectedFromStatus(status);
    expect(detected.has("slack")).toBe(true);
    expect(detected.has("github")).toBe(true);
  });

  test("configured milestones count as detected (live-call not required)", () => {
    const status = makeStatus({ slack: "configured", jira: "configured" });
    const detected = detectedFromStatus(status);
    expect(detected.has("slack")).toBe(true);
    expect(detected.has("jira")).toBe(true);
  });

  test("unverified milestones do NOT count as detected", () => {
    const status = makeStatus({ slack: "unverified", github: "unverified" });
    const detected = detectedFromStatus(status);
    expect(detected.size).toBe(0);
  });

  test("non-integration milestones (harness, workers, first_task) are excluded", () => {
    const status = makeStatus({});
    // All four integration milestones are unverified by default; harness etc.
    // are also unverified — none should leak into the detected set.
    const detected = detectedFromStatus(status);
    expect(detected.size).toBe(0);
  });
});

describe("topRecommendation — end-to-end from a /status payload", () => {
  test("slack+github verified → pr-triage", () => {
    const status = makeStatus({ slack: "verified", github: "verified" });
    expect(topRecommendation(status).templateId).toBe("pr-triage");
  });

  test("linear configured + github verified → issue-to-pr", () => {
    const status = makeStatus({ linear: "configured", github: "verified" });
    expect(topRecommendation(status).templateId).toBe("issue-to-pr");
  });

  test("nothing connected → hello-world", () => {
    const status = makeStatus({});
    expect(topRecommendation(status).templateId).toBe("hello-world");
  });
});
