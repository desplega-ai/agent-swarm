import { openAICompatibleKeyVars } from "@desplega/model-catalog";
import type { EnvPresenceMap } from "@/api/hooks/use-integrations-meta";
import type {
  AgentWithTasks,
  OnboardingAiMethod,
  OnboardingProviderSignal,
  ProviderName,
  SwarmConfig,
} from "@/api/types";
import { HARNESS_LABEL } from "@/lib/agent-runtime-models";
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

/**
 * The harnesses of a card by their dashboard names (`HARNESS_LABEL`), so the
 * step uses one name per harness: "Codex", or "Pi-Mono, Opencode, or DeepSeek (dsh)".
 */
export function harnessNames(card: AiCardId, conjunction: "or" | "and" = "or"): string {
  const names = CARD_HARNESSES[card].map((h) => HARNESS_LABEL[h] ?? h);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names[names.length - 1]}`;
}

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
  // OpenAI-compatible registry provider keys, canonical and alias.
  ...openAICompatibleKeyVars(),
  "DEVIN_API_KEY",
  "DEVIN_ORG_ID",
];

export interface CardRollup {
  verified: boolean;
  workers: number;
  verifiedWorkers: number;
  /** The latest live test of a harness on this card failed: its error. */
  error: string | null;
  /** A pool passed, but some of its keys failed: names them. */
  warning: string | null;
}

export function cardRollup(card: AiCardId, providers: OnboardingProviderSignal[]): CardRollup {
  const harnesses = CARD_HARNESSES[card];
  const rollup: CardRollup = {
    verified: false,
    workers: 0,
    verifiedWorkers: 0,
    error: null,
    warning: null,
  };
  for (const signal of providers) {
    if (!harnesses.includes(signal.provider)) continue;
    rollup.workers += signal.workers;
    rollup.verifiedWorkers += signal.verifiedWorkers;
    if (signal.state === "verified") rollup.verified = true;
    rollup.error ??= signal.error ?? null;
    rollup.warning ??= signal.warning ?? null;
  }
  // A harness that verified the card outranks another harness's failure.
  if (rollup.verified) rollup.error = null;
  return rollup;
}

/** The R2 switch the step runs for the user: every listed agent moves to `target`. */
export interface FirstCredentialSwitch {
  card: AiCardId;
  target: ProviderName;
  agentIds: string[];
}

/** A key that only one harness of its card can use. Other methods take the card's default. */
const METHOD_HARNESS: Partial<Record<OnboardingAiMethod, ProviderName>> = { deepseek: "dsh" };

/**
 * The switch on the first credential. A save with `method` moves every agent
 * to the harness of its card (the card's default) when no agent can work yet:
 * no other card holds a credential (a saved key, or a worker that verified
 * one), and no agent runs a harness of this card (the case where the manual
 * switch list shows). Null keeps the manual list. The step decides it once
 * per card, on the first save of that card.
 */
export function firstCredentialSwitch(
  method: OnboardingAiMethod,
  saved: Partial<Record<AiCardId, boolean>>,
  rollups: Record<AiCardId, Pick<CardRollup, "verified">>,
  agents: readonly Pick<AgentWithTasks, "id" | "harnessProvider">[],
): FirstCredentialSwitch | null {
  const card = METHOD_CARD[method];
  const harnesses = CARD_HARNESSES[card];
  const otherCredential = (Object.keys(CARD_HARNESSES) as AiCardId[]).some(
    (other) => other !== card && (saved[other] || rollups[other].verified),
  );
  const runsHarness = agents.some(
    (a) => a.harnessProvider != null && harnesses.includes(a.harnessProvider),
  );
  if (agents.length === 0 || otherCredential || runsHarness) return null;
  const target = METHOD_HARNESS[method] ?? harnesses[0];
  return { card, target, agentIds: agents.map((a) => a.id) };
}

/**
 * The line for a rejected key. A bare `HTTP 401: {body}` from a provider
 * becomes one plain sentence; a worker message that already explains itself
 * (the Claude subscription check, an all-keys-failed pool) stays as it is.
 */
export function rejectionText(error: string): string {
  const status = /^HTTP (\d{3})\b/.exec(error)?.[1];
  return status ? `The provider rejected the key (HTTP ${status}).` : error;
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
  /** Each card tells the step its saved state, for the switch on the first credential. */
  reportSaved: (card: AiCardId, saved: boolean) => void;
  /** The harness of this card the step is switching every agent to, if any. */
  autoSwitching: ProviderName | null;
}

/** Value of a non-secret global config row, for prefilling a field. */
export function globalConfigValue(configs: SwarmConfig[], key: string): string | undefined {
  return configs.find((c) => c.key === key && c.scope === "global")?.value || undefined;
}

/** Same rule as the API validator: http(s), no query string, no fragment. Blank is not an error. */
export function baseUrlError(value: string): string | null {
  return value.trim() ? httpUrlError(value, { bare: true }) : null;
}
