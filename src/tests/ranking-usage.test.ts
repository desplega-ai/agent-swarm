import { describe, expect, test } from "bun:test";
import { rankingUsageProps } from "../ranking/usage";

const ON = {
  ANONYMIZED_TELEMETRY: "true",
  PUBLIC_RANKING_ENABLED: "true",
  SWARM_ORG_NAME: "Acme",
  SWARM_ORG_WEBSITE: "acme.dev",
};
const COST = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3 };
const SESSION = { model: "claude-opus-5-5", provider: "claude" };

describe("rankingUsageProps (the worker's ranking.usage gate)", () => {
  test("emits token counts, model and provider when every gate passes", () => {
    const props = rankingUsageProps(COST, SESSION, ON);
    expect(props).toEqual({
      model: "claude-opus-5-5",
      provider: "claude",
      totalTokens: 128,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
    });
    // Tokens are the only metric: no cost, task or agent.
    for (const key of ["totalCostUsd", "taskId", "agentId", "durationMs", "numTurns"]) {
      expect(props).not.toHaveProperty(key);
    }
  });

  test.each([
    ["telemetry off", { ANONYMIZED_TELEMETRY: "false" }],
    ["the setting off", { PUBLIC_RANKING_ENABLED: "false" }],
    ["the setting unset", { PUBLIC_RANKING_ENABLED: undefined }],
    ["no org name", { SWARM_ORG_NAME: "" }],
    ["a placeholder org name", { SWARM_ORG_NAME: "Swarm" }],
    ["no website", { SWARM_ORG_WEBSITE: undefined }],
  ])("nothing with %s", (_label, override) => {
    expect(rankingUsageProps(COST, SESSION, { ...ON, ...override })).toBeNull();
  });

  test("omits cache counts the harness did not report", () => {
    expect(rankingUsageProps({ inputTokens: 7, outputTokens: 1 }, SESSION, ON)).toEqual({
      ...SESSION,
      totalTokens: 8,
      inputTokens: 7,
      outputTokens: 1,
    });
  });
});
