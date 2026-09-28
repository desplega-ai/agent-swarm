import type { EnvPresenceMap } from "@/api/hooks/use-integrations-meta";
import type {
  AgentWithTasks,
  OnboardingAiMethod,
  OnboardingProviderSignal,
  ProviderName,
  SwarmConfig,
} from "@/api/types";
import type { DialContext } from "@/lib/model-dial";
import { httpUrlError } from "../../components/http-url";

/** The four provider cards on step 3. */
export type AiCardId = "claude" | "codex" | "open" | "devin";

/** The rollup keys on the worker harness, so each card verifies through these. */
export const CARD_HARNESSES: Record<AiCardId, readonly ProviderName[]> = {
  claude: ["claude"],
  codex: ["codex"],
  open: ["pi", "opencode", "dsh"],
  devin: ["devin"],
};

/** Which card a recorded method belongs to. */
export const METHOD_CARD: Record<OnboardingAiMethod, AiCardId> = {
  claude_setup_token: "claude",
  claude_api_key: "claude",
  codex_device: "codex",
  codex_cli: "codex",
  openrouter: "open",
  openai_gateway: "open",
  deepseek: "open",
  devin: "devin",
};

export function isAiMethod(method: string | null): method is OnboardingAiMethod {
  return method !== null && method in METHOD_CARD;
}

/** Keys whose presence in the API env means a card has a saved credential. */
export const PRESENCE_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEVIN_API_KEY",
  "DEVIN_ORG_ID",
];

export interface CardRollup {
  verified: boolean;
  workers: number;
  verifiedWorkers: number;
}

export function cardRollup(card: AiCardId, providers: OnboardingProviderSignal[]): CardRollup {
  const harnesses = CARD_HARNESSES[card];
  const rollup: CardRollup = { verified: false, workers: 0, verifiedWorkers: 0 };
  for (const signal of providers) {
    if (!harnesses.includes(signal.provider)) continue;
    rollup.workers += signal.workers;
    rollup.verifiedWorkers += signal.verifiedWorkers;
    if (signal.state === "verified") rollup.verified = true;
  }
  return rollup;
}

/** Props the step passes to every provider card. */
export interface AiCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rollup: CardRollup;
  presence: EnvPresenceMap;
  configs: SwarmConfig[];
  agents: AgentWithTasks[];
  /** Called after a save succeeds, with the method that save completes the step with. */
  onSaved: (method: OnboardingAiMethod) => void;
  /** How dsh routes, for the model level the R2 switch carries over. */
  dialContext: DialContext;
}

/** Value of a non-secret global config row, for prefilling a field. */
export function globalConfigValue(configs: SwarmConfig[], key: string): string | undefined {
  return configs.find((c) => c.key === key && c.scope === "global")?.value || undefined;
}

/** Same rule as the API validator: http(s), no query string, no fragment. Blank is not an error. */
export function baseUrlError(value: string): string | null {
  return value.trim() ? httpUrlError(value, { bare: true }) : null;
}
