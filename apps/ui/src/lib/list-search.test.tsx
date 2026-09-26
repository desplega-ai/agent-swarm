import { describe, expect, test } from "bun:test";
import type { AgentWithTasks } from "../api/types";
import { agentSearchText, matchesSearchTerms } from "./list-search";

function agent(overrides: Partial<AgentWithTasks>): AgentWithTasks {
  return {
    id: "a1",
    name: "e2e-worker-b",
    role: "worker",
    status: "idle",
    harnessProvider: "claude",
    ...overrides,
  } as AgentWithTasks;
}

describe("list search", () => {
  const worker = agentSearchText(agent({}), ["Claude Code", "Opus 5.5 claude-opus-5-5"]);

  test("matches status, as the desktop grid does", () => {
    expect(matchesSearchTerms(worker, "idle")).toBe(true);
    expect(matchesSearchTerms(agentSearchText(agent({ status: "busy" })), "idle")).toBe(false);
  });

  test("matches the displayed model", () => {
    expect(matchesSearchTerms(worker, "opus")).toBe(true);
  });

  test("every term must match, in any order", () => {
    expect(matchesSearchTerms(worker, "idle   worker-b")).toBe(true);
    expect(matchesSearchTerms(worker, "IDLE opus")).toBe(true);
    expect(matchesSearchTerms(worker, "idle lead")).toBe(false);
  });

  test("an empty query matches everything", () => {
    expect(matchesSearchTerms(worker, "   ")).toBe(true);
  });
});
