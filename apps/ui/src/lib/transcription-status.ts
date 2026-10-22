import type { SwarmConfig } from "@/api/types";
import type { EnvPresence } from "./integrations-status";

// Which provider and key audio transcription uses, from presence only (never
// values). Mirrors `resolveTranscriptionConfig` in src/utils/transcription.ts:
// an explicit TRANSCRIPTION_API_KEY wins; else a pinned TRANSCRIPTION_PROVIDER
// uses only its own key; else the first provider key the swarm already has.

export const TRANSCRIPTION_PROVIDERS = [
  { id: "elevenlabs", label: "ElevenLabs", keyEnv: "ELEVENLABS_API_KEY" },
  { id: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY" },
  { id: "groq", label: "Groq", keyEnv: "GROQ_API_KEY" },
] as const;

export const TRANSCRIPTION_API_KEY = "TRANSCRIPTION_API_KEY";

/** Env keys whose presence decides the active provider. */
export const TRANSCRIPTION_PRESENCE_KEYS = [
  TRANSCRIPTION_API_KEY,
  "TRANSCRIPTION_PROVIDER",
  ...TRANSCRIPTION_PROVIDERS.map((p) => p.keyEnv),
];

export interface TranscriptionStatus {
  /** Provider id, or null when TRANSCRIPTION_PROVIDER is set only in the deployment env. */
  provider: string | null;
  /** The key in use, or null when the env-only provider hides which one. */
  keyEnv: string | null;
  source: "explicit" | "auto";
}

function storedValue(configs: SwarmConfig[], key: string): string | undefined {
  return (
    configs
      .find((c) => c.scope === "global" && c.key === key)
      ?.value.trim()
      .toLowerCase() || undefined
  );
}

export function providerLabel(id: string): string {
  return TRANSCRIPTION_PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

/** The active provider and key, or null when transcription is off. */
export function resolveTranscriptionStatus(
  configs: SwarmConfig[],
  presence: EnvPresence,
): TranscriptionStatus | null {
  const isSet = (key: string) => presence[key] === true || storedValue(configs, key) !== undefined;
  const stored = storedValue(configs, "TRANSCRIPTION_PROVIDER");
  const envOnlyProvider = !stored && presence.TRANSCRIPTION_PROVIDER === true;
  if (isSet(TRANSCRIPTION_API_KEY)) {
    return {
      provider: stored ?? (envOnlyProvider ? null : "openai"),
      keyEnv: TRANSCRIPTION_API_KEY,
      source: "explicit",
    };
  }
  // Presence cannot show which provider the env pins, so not which key it uses.
  if (envOnlyProvider) {
    const anyKey = TRANSCRIPTION_PROVIDERS.some((p) => isSet(p.keyEnv));
    return anyKey ? { provider: null, keyEnv: null, source: "auto" } : null;
  }
  const candidates = stored
    ? TRANSCRIPTION_PROVIDERS.filter((p) => p.id === stored)
    : TRANSCRIPTION_PROVIDERS;
  const found = candidates.find((p) => isSet(p.keyEnv));
  return found ? { provider: found.id, keyEnv: found.keyEnv, source: "auto" } : null;
}
