import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getOpenRouterAttributionHeaders } from "../../../../src/utils/openrouter-base-url";

/** The ai-sdk provider's default endpoint; the judges never override it. */
const JUDGE_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** OpenRouter provider for the judges, attributed to Agent Swarm unless opted out. */
export function createJudgeOpenRouter(apiKey: string, fetchImpl?: typeof fetch) {
  return createOpenRouter({
    apiKey,
    headers: getOpenRouterAttributionHeaders(JUDGE_OPENROUTER_BASE_URL),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
