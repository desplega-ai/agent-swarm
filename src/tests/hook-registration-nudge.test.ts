/**
 * Registration-nudge gate tests.
 *
 * The "use join-swarm" nudge previously fired on EVERY hook event when
 * getAgentInfo() returned null — including transient lookup failures for
 * already-registered agents. This caused 123 redundant join-swarm calls
 * in a 3-day window, all bouncing off "already exists".
 *
 * The fix: only nudge on SessionStart AND only when no X-Agent-ID header
 * is present (genuinely unregistered).
 */
import { describe, expect, test } from "bun:test";
import { shouldShowRegistrationNudge } from "../hooks/hook";

describe("shouldShowRegistrationNudge", () => {
  test("(a) pre-assigned agent (X-Agent-ID present) + null lookup on SessionStart → NO nudge", () => {
    expect(
      shouldShowRegistrationNudge({
        agentInfoPresent: false,
        eventType: "SessionStart",
        hasAgentIdHeader: true,
      }),
    ).toBe(false);
  });

  test("(b) non-SessionStart event → NO nudge regardless of other conditions", () => {
    const nonStartEvents = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"];

    for (const eventType of nonStartEvents) {
      expect(
        shouldShowRegistrationNudge({
          agentInfoPresent: false,
          eventType,
          hasAgentIdHeader: false,
        }),
      ).toBe(false);
    }
  });

  test("(c) genuinely unregistered (no X-Agent-ID) on SessionStart → nudge present", () => {
    expect(
      shouldShowRegistrationNudge({
        agentInfoPresent: false,
        eventType: "SessionStart",
        hasAgentIdHeader: false,
      }),
    ).toBe(true);
  });

  test("registered agent (agentInfo present) never gets nudged", () => {
    expect(
      shouldShowRegistrationNudge({
        agentInfoPresent: true,
        eventType: "SessionStart",
        hasAgentIdHeader: false,
      }),
    ).toBe(false);
  });

  test("pre-assigned agent on non-SessionStart event → NO nudge", () => {
    expect(
      shouldShowRegistrationNudge({
        agentInfoPresent: false,
        eventType: "UserPromptSubmit",
        hasAgentIdHeader: true,
      }),
    ).toBe(false);
  });
});
