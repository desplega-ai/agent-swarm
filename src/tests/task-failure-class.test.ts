import { describe, expect, test } from "bun:test";
import { classifyTaskFailureReason } from "../utils/task-failure-class";

describe("classifyTaskFailureReason", () => {
  test.each([
    ["Lead credential missing: ANTHROPIC_API_KEY", "credential_missing"],
    ["The lead agent is missing required LLM credentials: OPENAI_API_KEY.", "credential_missing"],
    ["No agents online to claim this task", "no_agent"],
    ["No available agent has claimed this task.", "no_agent"],
    ["No agents eligible to claim this task are online.", "no_agent"],
    ["No eligible agent has the required capabilities", "no_capable_agent"],
    ["No registered agent matches this task's required role or capabilities.", "no_capable_agent"],
    ["Auto-failed by reboot sweep: worker session not found", "session_crash"],
    ["resume_budget_exhausted", "session_crash"],
    ["Worker session heartbeat is stale", "stale_heartbeat"],
    ["Tests failed in package foo", "agent_reported"],
    ["Unassigned from GitHub PR #42", "cancelled"],
    ["Unknown failure", "unknown"],
    ["", "unknown"],
  ] as const)("maps %p to %s", (reason, expected) => {
    expect(classifyTaskFailureReason(reason)).toBe(expected);
  });
});
