import { describe, expect, test } from "bun:test";
import {
  defaultSlackEmoji,
  parseSlackIconInput,
  slackEmojiGlyph,
} from "../../apps/ui/src/lib/slack-icon";
import { getAgentEmoji } from "../slack/responses";
import { type Agent, AgentSlackIconSchema } from "../types";

function agent(overrides: Partial<Agent> = {}): Agent {
  return { id: "a1", name: "Owl Worker", isLead: false, status: "idle", ...overrides } as Agent;
}

// Each raw input, the icon the server receives for it, and whether both the
// zod schema and the dashboard parser accept it.
const PARITY_CASES: Array<[string, boolean]> = [
  [":owl:", true],
  [":+1:", true],
  [":bee-lgtm:", true],
  [":thumbs_up:", true],
  ["https://example.com/owl.png", true],
  ["https://example.com/owl.png?size=64", true],
  ["http://example.com/owl.png", false],
  ["https://", false],
  ["https://exa mple.com/owl.png", false],
  ["https://[::1", false],
  ["https://user:pass@example.com/owl.png", false],
  ["https://user@example.com/owl.png", false],
  [`https://example.com/${"a".repeat(2048)}`, false],
  ["javascript:alert(1)", false],
  [":owl face:", false],
  [":wave::skin-tone-3:", false],
  [`:${"a".repeat(101)}:`, false],
];

function asIcon(raw: string) {
  return /^https?:/i.test(raw) ? { type: "url", url: raw } : { type: "emoji", emoji: raw };
}

describe("Slack icon validation parity", () => {
  for (const [raw, accepted] of PARITY_CASES) {
    test(`${raw.slice(0, 48)} is ${accepted ? "accepted" : "rejected"} by both`, () => {
      expect(AgentSlackIconSchema.safeParse(asIcon(raw)).success).toBe(accepted);
      const parsed = parseSlackIconInput(raw);
      expect(parsed.ok).toBe(accepted);
      if (parsed.ok) expect(parsed.icon).toEqual(asIcon(raw) as never);
    });
  }

  test("the schema rejects shortcodes the dashboard would normalise", () => {
    expect(AgentSlackIconSchema.safeParse({ type: "emoji", emoji: "owl" }).success).toBe(false);
    expect(AgentSlackIconSchema.safeParse({ type: "emoji", emoji: ":Owl:" }).success).toBe(false);
  });

  test("the dashboard normalises bare and capitalised shortcodes, and blank resets", () => {
    expect(parseSlackIconInput(" owl ")).toEqual({
      ok: true,
      icon: { type: "emoji", emoji: ":owl:" },
    });
    expect(parseSlackIconInput(":Owl:")).toEqual({
      ok: true,
      icon: { type: "emoji", emoji: ":owl:" },
    });
    expect(parseSlackIconInput("  ")).toEqual({ ok: true, icon: null });
    expect(parseSlackIconInput("http://example.com/owl.png")).toEqual({
      ok: false,
      error: "Use an https URL.",
    });
  });
});

describe("default emoji parity", () => {
  test("the dashboard picks the same default as getAgentEmoji", () => {
    const agents = [
      agent({ isLead: true, name: "Neo" }),
      ...["Owl Worker", "Coder", "Reviewer", "Mobile Coder", "e2e-worker-a", "Ω", ""].map((name) =>
        agent({ name }),
      ),
    ];
    for (const a of agents) {
      expect(defaultSlackEmoji(a)).toBe(getAgentEmoji(a));
      expect(slackEmojiGlyph(getAgentEmoji(a))).not.toBeNull();
    }
  });
});
