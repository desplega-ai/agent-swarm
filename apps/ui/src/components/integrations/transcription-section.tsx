import { Check, Minus } from "lucide-react";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import type { SpecialFlowSectionProps } from "@/components/integrations/special-flows";
import { OAuthSection, OAuthStatusRow } from "@/components/shared/oauth-section";
import {
  providerLabel,
  resolveTranscriptionStatus,
  TRANSCRIPTION_PRESENCE_KEYS,
  TRANSCRIPTION_PROVIDERS,
} from "@/lib/transcription-status";

function describeStatus(status: NonNullable<ReturnType<typeof resolveTranscriptionStatus>>) {
  if (status.provider === null) {
    return "TRANSCRIPTION_PROVIDER is set in the deployment env; its key decides the provider.";
  }
  if (status.source === "explicit") return "Uses the API key set below (TRANSCRIPTION_API_KEY).";
  return `Auto-detected: reuses ${status.keyEnv}, already configured on the swarm. Set an API key below to override it.`;
}

/**
 * Transcription: which provider is active and where its key came from. The
 * generic fields below set the provider, an explicit key, base URL and model.
 */
export function TranscriptionSection({ configs }: SpecialFlowSectionProps) {
  const { data: presence = {} } = useEnvPresence(TRANSCRIPTION_PRESENCE_KEYS);
  const status = resolveTranscriptionStatus(configs, presence);
  const keySet = (key: string) =>
    presence[key] === true || configs.some((c) => c.scope === "global" && c.key === key);

  return (
    <OAuthSection title="Active provider">
      <OAuthStatusRow
        connected={status !== null}
        label={
          status === null
            ? "Off"
            : status.provider === null
              ? "Set by deployment env"
              : providerLabel(status.provider)
        }
        description={
          status === null
            ? "No transcription key. Set an API key below, or add an ElevenLabs, OpenAI or Groq key to the swarm."
            : describeStatus(status)
        }
      />
      <div className="border-t border-border p-4 space-y-2">
        <div className="text-xs text-muted-foreground">
          Without an API key here, transcription reuses the first provider key it finds:
        </div>
        <ol className="space-y-1">
          {TRANSCRIPTION_PROVIDERS.map((p, index) => (
            <li key={p.id} className="flex items-center gap-2 text-sm">
              <span className="w-4 text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
              {keySet(p.keyEnv) ? (
                <Check className="h-3.5 w-3.5 text-status-success-strong" aria-label="set" />
              ) : (
                <Minus className="h-3.5 w-3.5 text-muted-foreground" aria-label="not set" />
              )}
              <span>{p.label}</span>
              <code className="text-[11px] font-mono text-muted-foreground">{p.keyEnv}</code>
            </li>
          ))}
        </ol>
      </div>
    </OAuthSection>
  );
}
