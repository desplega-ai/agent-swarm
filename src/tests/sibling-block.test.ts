import { describe, expect, test } from "bun:test";
import {
  formatRelativeTime,
  pickResumeParent,
  prependSiblingBlock,
  renderSiblingBlock,
  type SiblingTaskInfo,
  stripSiblingBlock,
  truncateForBlock,
} from "../tasks/sibling-block";

const NOW = Date.parse("2026-04-22T12:00:00.000Z");

function sibling(overrides: Partial<SiblingTaskInfo> = {}): SiblingTaskInfo {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    status: "in_progress",
    agentId: "agent-A",
    agentName: "Picateclas",
    description: "Do the thing",
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

describe("truncateForBlock", () => {
  test("returns string unchanged when under limit", () => {
    expect(truncateForBlock("hello world")).toBe("hello world");
  });

  test("collapses internal whitespace", () => {
    expect(truncateForBlock("hello\n\n  world\t!")).toBe("hello world !");
  });

  test("truncates to max length and appends ellipsis", () => {
    const long = "a".repeat(250);
    const out = truncateForBlock(long, 200);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(201);
  });

  test("handles non-string input gracefully", () => {
    // @ts-expect-error — runtime safety
    expect(truncateForBlock(undefined)).toBe("");
    // @ts-expect-error — runtime safety
    expect(truncateForBlock(null)).toBe("");
  });
});

describe("formatRelativeTime", () => {
  test("seconds", () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("30s");
  });
  test("minutes", () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5m");
  });
  test("hours", () => {
    expect(formatRelativeTime(NOW - 3 * 3600_000, NOW)).toBe("3h");
  });
  test("days", () => {
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d");
  });
  test("treats future timestamps as 0s, not negative", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("0s");
  });
  test("returns 'unknown time' for unparseable input", () => {
    expect(formatRelativeTime("not a date", NOW)).toBe("unknown time");
  });
});

describe("renderSiblingBlock", () => {
  test("returns empty string when there are no siblings", () => {
    expect(renderSiblingBlock("task:slack:C1:1", [], NOW)).toBe("");
  });

  test("renders one sibling with all expected fields", () => {
    const out = renderSiblingBlock("task:slack:C1:1", [sibling()], NOW);
    expect(out).toContain("<sibling_tasks_in_progress>");
    expect(out).toContain("</sibling_tasks_in_progress>");
    expect(out).toContain("contextKey: task:slack:C1:1");
    expect(out).toContain("[in_progress] task:00000000-0000-0000-0000-000000000001");
    expect(out).toContain("agent:Picateclas");
    expect(out).toContain("started 1m ago");
    expect(out).toContain('"Do the thing"');
  });

  test("renders multiple siblings as separate bullets", () => {
    const out = renderSiblingBlock(
      "task:slack:C1:1",
      [
        sibling({ id: "id-1", description: "first" }),
        sibling({
          id: "id-2",
          status: "pending",
          description: "second",
          updatedAt: new Date(NOW - 3600_000).toISOString(),
        }),
      ],
      NOW,
    );
    expect(out).toContain("[in_progress] task:id-1");
    expect(out).toContain("[pending] task:id-2");
    expect(out).toContain("started 1h ago");
  });

  test("falls back to agent:unassigned when no agent info", () => {
    const out = renderSiblingBlock(
      "task:slack:C1:1",
      [sibling({ agentId: null, agentName: null })],
      NOW,
    );
    expect(out).toContain("agent:unassigned");
  });

  test("falls back to agentId when agentName missing", () => {
    const out = renderSiblingBlock(
      "task:slack:C1:1",
      [sibling({ agentName: null, agentId: "agent-XYZ" })],
      NOW,
    );
    expect(out).toContain("agent:agent-XYZ");
  });

  test("truncates long descriptions to 200 chars + ellipsis", () => {
    const long = "x".repeat(500);
    const out = renderSiblingBlock("task:slack:C1:1", [sibling({ description: long })], NOW);
    expect(out).toContain("…");
    // Per-description line: bullet has the truncated description in quotes.
    const descLine = out.split("\n").find((l) => l.includes('"x'));
    expect(descLine).toBeDefined();
    expect((descLine as string).length).toBeLessThan(220);
  });
});

describe("prependSiblingBlock", () => {
  test("prepends the block with a blank line separator", () => {
    const out = prependSiblingBlock("Original task body", "task:slack:C1:1", [sibling()], NOW);
    expect(out.startsWith("<sibling_tasks_in_progress>")).toBe(true);
    expect(out.endsWith("Original task body")).toBe(true);
    expect(out).toContain("</sibling_tasks_in_progress>\n\nOriginal task body");
  });

  test("returns the description unchanged when there are no siblings", () => {
    expect(prependSiblingBlock("Original", "task:slack:C1:1", [], NOW)).toBe("Original");
  });
});

describe("stripSiblingBlock", () => {
  test("returns description unchanged when no block", () => {
    expect(stripSiblingBlock("Just a body")).toBe("Just a body");
  });

  test("removes a prepended block and its separator", () => {
    const withBlock = prependSiblingBlock("Real body", "task:slack:C1:1", [sibling()], NOW);
    expect(stripSiblingBlock(withBlock)).toBe("Real body");
  });

  test("removes a block that appears mid-description", () => {
    const block = renderSiblingBlock("task:slack:C1:1", [sibling()], NOW);
    const mixed = `Prelude\n\n${block}\n\nAfter`;
    expect(stripSiblingBlock(mixed)).toBe("Prelude\n\nAfter");
  });

  test("returns input unchanged when tags are unmatched", () => {
    const broken = "<sibling_tasks_in_progress> no closing tag here";
    expect(stripSiblingBlock(broken)).toBe(broken);
  });

  test("handles non-string input", () => {
    // @ts-expect-error — runtime safety
    expect(stripSiblingBlock(undefined)).toBe("");
  });
});

describe("pickResumeParent", () => {
  test("returns null when currentAgentId is missing", () => {
    expect(pickResumeParent([sibling()], null)).toBeNull();
    expect(pickResumeParent([sibling()], undefined)).toBeNull();
  });

  test("returns null when no siblings are on the same agent", () => {
    const out = pickResumeParent([sibling({ agentId: "agent-B" })], "agent-A");
    expect(out).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(pickResumeParent([], "agent-A")).toBeNull();
  });

  test("in_progress beats pending even if pending is more recent", () => {
    const recent_pending = sibling({
      id: "rp",
      status: "pending",
      updatedAt: new Date(NOW).toISOString(),
    });
    const older_in_progress = sibling({
      id: "oip",
      status: "in_progress",
      updatedAt: new Date(NOW - 3600_000).toISOString(),
    });
    const picked = pickResumeParent([recent_pending, older_in_progress], "agent-A");
    expect(picked?.id).toBe("oip");
  });

  test("among same-status siblings, most recent wins", () => {
    const older = sibling({ id: "o", updatedAt: new Date(NOW - 3600_000).toISOString() });
    const newer = sibling({ id: "n", updatedAt: new Date(NOW - 60_000).toISOString() });
    const picked = pickResumeParent([older, newer], "agent-A");
    expect(picked?.id).toBe("n");
  });

  test("ordering: in_progress > pending > offered > paused", () => {
    const all = [
      sibling({ id: "p", status: "paused" }),
      sibling({ id: "o", status: "offered" }),
      sibling({ id: "pe", status: "pending" }),
      sibling({ id: "ip", status: "in_progress" }),
    ];
    expect(pickResumeParent(all, "agent-A")?.id).toBe("ip");
    expect(pickResumeParent(all.slice(0, 3), "agent-A")?.id).toBe("pe");
    expect(pickResumeParent(all.slice(0, 2), "agent-A")?.id).toBe("o");
    expect(pickResumeParent(all.slice(0, 1), "agent-A")?.id).toBe("p");
  });

  test("ignores siblings with null agentId", () => {
    const out = pickResumeParent(
      [sibling({ agentId: null }), sibling({ id: "ok", agentId: "agent-A" })],
      "agent-A",
    );
    expect(out?.id).toBe("ok");
  });
});
