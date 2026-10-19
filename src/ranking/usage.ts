/**
 * Worker side of the public ranking: the `ranking.usage` properties for one
 * session. Pure, so the runner and its test share the gate.
 */
import { isEnvFlagEnabled } from "../utils/env-flag";
import { orgIdentityStatus } from "../utils/org-identity";

export interface SessionTokens {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

export interface RankingUsageProps {
  /** The same model and provider `session.cost` reports for the session. */
  model: string;
  provider: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const tokens = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * Null unless telemetry is on, `PUBLIC_RANKING_ENABLED` is set and both org
 * identity envs are set. Carries token counts plus the model and provider
 * (for the per-model chart), never the task, agent or cost.
 */
export function rankingUsageProps(
  cost: SessionTokens,
  session: { model: string; provider: string },
  env: NodeJS.ProcessEnv = process.env,
): RankingUsageProps | null {
  if (!isEnvFlagEnabled("ANONYMIZED_TELEMETRY", true, env)) return null;
  if (!isEnvFlagEnabled("PUBLIC_RANKING_ENABLED", false, env)) return null;
  const identity = { SWARM_ORG_NAME: env.SWARM_ORG_NAME, SWARM_ORG_WEBSITE: env.SWARM_ORG_WEBSITE };
  if (!orgIdentityStatus(identity).ok) return null;
  const input = tokens(cost.inputTokens);
  const output = tokens(cost.outputTokens);
  const cacheRead = tokens(cost.cacheReadTokens);
  const cacheWrite = tokens(cost.cacheWriteTokens);
  return {
    model: session.model,
    provider: session.provider,
    // The unified sum, as computeContextUsedUnified counts it.
    totalTokens: input + cacheRead + cacheWrite + output,
    inputTokens: input,
    outputTokens: output,
    ...(cost.cacheReadTokens != null ? { cacheReadTokens: cacheRead } : {}),
    ...(cost.cacheWriteTokens != null ? { cacheWriteTokens: cacheWrite } : {}),
  };
}
