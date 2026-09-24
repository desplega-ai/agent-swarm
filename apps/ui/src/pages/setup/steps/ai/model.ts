import type { EnvPresenceMap } from "@/api/hooks/use-integrations-meta";
import type {
  AgentWithTasks,
  OnboardingAiMethod,
  OnboardingProviderSignal,
  ProviderName,
  SwarmConfig,
} from "@/api/types";

/** The four provider cards on step 3. */
export type AiCardId = "claude" | "codex" | "open" | "devin";

/** Worker harness ids a step-3 card can verify through. */
export type AiHarness = ProviderName;

/** The rollup keys on the worker harness, so each card verifies through these. */
export const CARD_HARNESSES: Record<AiCardId, readonly AiHarness[]> = {
  claude: ["claude"],
  codex: ["codex"],
  open: ["pi", "opencode", "dsh"],
  devin: ["devin"],
};

export const HARNESS_NAME: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "pi",
  opencode: "opencode",
  dsh: "DeepSeek (dsh)",
  devin: "Devin",
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

/** Provider name for the "<Provider> verified." line. */
export const METHOD_PROVIDER: Record<OnboardingAiMethod, string> = {
  claude_setup_token: "Claude",
  claude_api_key: "Claude",
  codex_device: "Codex",
  codex_cli: "Codex",
  openrouter: "OpenRouter",
  openai_gateway: "Gateway",
  deepseek: "DeepSeek",
  devin: "Devin",
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
}

/** Value of a non-secret global config row, for prefilling a field. */
export function globalConfigValue(configs: SwarmConfig[], key: string): string | undefined {
  return configs.find((c) => c.key === key && c.scope === "global")?.value || undefined;
}

/** Same rule as the API validator: http(s), no query string, no fragment. */
export function baseUrlError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.search && !url.hash) {
      return null;
    }
  } catch {
    // Falls through to the message below.
  }
  return "Use an http or https URL without a query string or fragment.";
}
