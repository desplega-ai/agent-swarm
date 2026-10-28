import { describe, expect, test } from "bun:test";
import { parseSlackIconInput } from "../../apps/ui/src/lib/slack-icon";
import { getAgentEmoji, getAgentSlackIcon } from "../slack/responses";
import { type Agent, AgentSlackIconSchema } from "../types";

function agent(overrides: Partial<Agent> = {}): Agent {
  return { id: "a1", name: "Owl Worker", isLead: false, status: "idle", ...overrides } as Agent;
}

describe("getAgentSlackIcon", () => {
  test("uses the configured emoji or URL", () => {
    expect(getAgentSlackIcon(agent({ slackIcon: { type: "emoji", emoji: ":owl:" } }))).toEqual({
      icon_emoji: ":owl:",
    });
    expect(
      getAgentSlackIcon(agent({ slackIcon: { type: "url", url: "https://example.com/o.png" } })),
    ).toEqual({ icon_url: "https://example.com/o.png" });
  });

  test("falls back to the crown for the lead and the hashed emoji for workers", () => {
    expect(getAgentSlackIcon(agent({ isLead: true, slackIcon: null }))).toEqual({
      icon_emoji: ":crown:",
    });
    const worker = agent();
    expect(getAgentSlackIcon(worker)).toEqual({ icon_emoji: getAgentEmoji(worker) });
  });
});

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
