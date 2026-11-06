import { AlertTriangle, Check, Mic, Minus } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import {
  useConfigs,
  useDeleteConfigsBatch,
  useUpsertConfigsBatch,
} from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import type { SwarmConfig } from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import { BrandLogo } from "@/components/shared/brand-logo";
import { KeyStatusPill } from "@/components/shared/key-status-pill";
import { SecretInput } from "@/components/shared/secret-input";
import { StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  providerLabel,
  resolveTranscriptionStatus,
  TRANSCRIPTION_API_KEY,
  TRANSCRIPTION_PRESENCE_KEYS,
  TRANSCRIPTION_PROVIDERS,
  type TranscriptionStatus,
} from "@/lib/transcription-status";
import { cn } from "@/lib/utils";
import { FactRow, KeyName, Mono, SetupCard, TabIntro } from "./ai-tab-parts";

const VOICE_NOTES_GUIDE = "https://docs.agent-swarm.dev/docs/integrations/chat-sdk#voice-notes";

type ProviderChoice = "auto" | (typeof TRANSCRIPTION_PROVIDERS)[number]["id"];

function stored(configs: SwarmConfig[], key: string): string | undefined {
  const value = configs.find((c) => c.scope === "global" && c.key === key)?.value.trim();
  return value ? value : undefined;
}

/** Each transcription provider's mark; `img` logos are full colour. */
const PROVIDER_MARKS: Record<string, { src?: string; img?: string }> = {
  elevenlabs: { src: "/provider-logos/elevenlabs.svg" },
  openai: { src: "/provider-logos/openai.svg" },
  groq: { img: "/provider-logos/groq.svg" },
};

function ProviderMark({ id, className = "size-4" }: { id: string; className?: string }) {
  const mark = PROVIDER_MARKS[id];
  if (mark?.img) {
    return <img src={mark.img} alt="" aria-hidden className={cn(className, "rounded-[3px]")} />;
  }
  if (mark?.src) return <BrandLogo src={mark.src} className={cn(className, "text-foreground")} />;
  return <Mic aria-hidden className={className} />;
}

function providerSpec(id: string | null) {
  return TRANSCRIPTION_PROVIDERS.find((p) => p.id === id);
}

function subtitle(status: TranscriptionStatus | null, pinned: string | undefined) {
  const pin = providerSpec(pinned ?? null);
  if (status === null && pin) {
    return `TRANSCRIPTION_PROVIDER pins ${pin.label}, and the swarm has no ${pin.keyEnv}.`;
  }
  if (status === null) {
    return "No transcription key. Change provider, or add an ElevenLabs, OpenAI or Groq key to the swarm.";
  }
  if (status.provider === null) {
    return "TRANSCRIPTION_PROVIDER is set in the deployment env. Its key decides the provider.";
  }
  if (status.source === "explicit") {
    return (
      <>
        Uses its own key, <KeyName>{TRANSCRIPTION_API_KEY}</KeyName>.
      </>
    );
  }
  return (
    <>
      Auto-detected: reuses <KeyName>{status.keyEnv ?? ""}</KeyName>, already configured on the
      swarm.
    </>
  );
}

/** Transcription state from the stored rows and the env presence of its keys. */
function useTranscription() {
  const configs = useConfigs({ scope: "global" });
  const presence = useEnvPresence(TRANSCRIPTION_PRESENCE_KEYS);
  const list = configs.data ?? [];
  const map = presence.data ?? {};
  return {
    configs: list,
    presence: map,
    status: resolveTranscriptionStatus(list, map),
    loading: configs.isLoading || presence.isLoading,
    keySet: (key: string) => map[key] === true || stored(list, key) !== undefined,
  };
}

/**
 * Connect › AI providers › Transcription: the provider voice notes use now,
 * where its key comes from, its model and endpoint, and the auto-detect
 * order. "Change provider" pins a provider or sets a key of its own.
 */
export function TranscriptionTab() {
  const { configs, status, loading, keySet } = useTranscription();
  if (loading) return <Skeleton className="h-56 w-full" />;

  const spec = providerSpec(status?.provider ?? null);
  const pinned = stored(configs, "TRANSCRIPTION_PROVIDER") !== undefined;
  const model = stored(configs, "TRANSCRIPTION_MODEL");
  const baseUrl =
    status?.source === "explicit" ? stored(configs, "TRANSCRIPTION_BASE_URL") : undefined;
  const title =
    status === null
      ? "Off"
      : status.provider === null
        ? "Set by deployment env"
        : providerLabel(status.provider);

  return (
    <div className="flex flex-col gap-3">
      <TabIntro href={VOICE_NOTES_GUIDE} label="Voice notes guide">
        Transcription turns voice notes and audio files from chat channels into task text.
      </TabIntro>
      <SetupCard
        mark={
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background "
          >
            {spec ? <ProviderMark id={spec.id} className="size-5" /> : <Mic className="size-5" />}
          </span>
        }
        title={title}
        status={
          <KeyStatusPill tone={status ? "success" : "neutral"}>
            {status ? "On" : "Off"}
          </KeyStatusPill>
        }
        subtitle={subtitle(status, stored(configs, "TRANSCRIPTION_PROVIDER")?.toLowerCase())}
        facts={
          <>
            <FactRow
              label="Provider"
              note={
                status
                  ? pinned
                    ? "pinned"
                    : status.provider
                      ? "auto-detected"
                      : undefined
                  : undefined
              }
            >
              {status ? title : "None"}
            </FactRow>
            {spec ? (
              <FactRow label="Model" note={model ? undefined : "provider default"}>
                <Mono>{model ?? spec.defaultModel}</Mono>
              </FactRow>
            ) : null}
            {status?.keyEnv ? (
              <FactRow label="Key">
                <KeyName>{status.keyEnv}</KeyName>
              </FactRow>
            ) : null}
            {spec ? (
              <FactRow label="Endpoint" note={baseUrl ? undefined : "provider default"}>
                <Mono>{baseUrl ?? spec.defaultBaseUrl}</Mono>
              </FactRow>
            ) : null}
            <FactRow label="Applies">To the next voice note. No restart.</FactRow>
          </>
        }
        aside={
          <>
            <h3 className="font-semibold text-foreground">Auto-detect order</h3>
            <p>
              With no key of its own, transcription reuses the first of these keys that the swarm
              has.
            </p>
            <ol className="space-y-1.5 pt-1">
              {TRANSCRIPTION_PROVIDERS.map((p, index) => (
                <li key={p.id} className="flex items-center gap-2 text-foreground">
                  <span className="w-4 font-mono text-xs text-muted-foreground">{index + 1}</span>
                  {keySet(p.keyEnv) ? (
                    <Check aria-label="set" className="size-3.5 text-status-success-strong" />
                  ) : (
                    <Minus aria-label="not set" className="size-3.5 text-muted-foreground" />
                  )}
                  <ProviderMark id={p.id} className="size-3.5" />
                  <span className="flex-1">{p.label}</span>
                  <KeyName>{p.keyEnv}</KeyName>
                </li>
              ))}
            </ol>
          </>
        }
        footer={
          <>
            <span>The stored values are on the transcription settings page.</span>
            <Link to="/integrations/transcription" className="text-primary hover:underline">
              All settings
            </Link>
          </>
        }
      />
    </div>
  );
}

function FieldLabel({
  htmlFor,
  label,
  configKey,
}: {
  htmlFor: string;
  label: string;
  configKey: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>
      </label>
      <code className="truncate font-mono text-[11px] text-muted-foreground">{configKey}</code>
    </div>
  );
}

function PanelBody({ onDone }: { onDone: () => void }) {
  const id = useId();
  const { configs, presence, keySet } = useTranscription();
  const upsert = useUpsertConfigsBatch();
  const remove = useDeleteConfigsBatch();
  const storedProvider = stored(configs, "TRANSCRIPTION_PROVIDER")?.toLowerCase();
  const [choice, setChoice] = useState<ProviderChoice>(
    providerSpec(storedProvider ?? null) ? (storedProvider as ProviderChoice) : "auto",
  );
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(stored(configs, "TRANSCRIPTION_MODEL") ?? "");
  const [baseUrl, setBaseUrl] = useState(stored(configs, "TRANSCRIPTION_BASE_URL") ?? "");
  const [error, setError] = useState<string | null>(null);
  const spec = choice === "auto" ? undefined : providerSpec(choice);
  const hasOwnKey = apiKey.trim() !== "" || keySet(TRANSCRIPTION_API_KEY);
  const envPinned = !storedProvider && presence.TRANSCRIPTION_PROVIDER === true;

  const upserts = [
    ...(choice !== "auto" && choice !== storedProvider
      ? [{ key: "TRANSCRIPTION_PROVIDER", value: choice, isSecret: false }]
      : []),
    ...(apiKey.trim()
      ? [{ key: TRANSCRIPTION_API_KEY, value: apiKey.trim(), isSecret: true }]
      : []),
    ...(model.trim() && model.trim() !== stored(configs, "TRANSCRIPTION_MODEL")
      ? [{ key: "TRANSCRIPTION_MODEL", value: model.trim(), isSecret: false }]
      : []),
    ...(baseUrl.trim() && baseUrl.trim() !== stored(configs, "TRANSCRIPTION_BASE_URL")
      ? [{ key: "TRANSCRIPTION_BASE_URL", value: baseUrl.trim(), isSecret: false }]
      : []),
  ];
  const removals = choice === "auto" && storedProvider ? ["TRANSCRIPTION_PROVIDER"] : [];
  const pending = upsert.isPending || remove.isPending;
  const dirty = upserts.length > 0 || removals.length > 0;

  async function save() {
    if (!dirty || pending) return;
    setError(null);
    try {
      if (upserts.length > 0) {
        const res = await upsert.mutateAsync(upserts);
        if (res.failureCount > 0) throw new Error(res.errors[0]?.message ?? "Could not save.");
      }
      if (removals.length > 0) {
        const res = await remove.mutateAsync({ configs, keys: removals });
        if (res.failureCount > 0) throw new Error(res.errors[0]?.message ?? "Could not save.");
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <section className="space-y-3 border-b border-border-subtle px-5 py-4">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id={`${id}-provider`} className="text-sm font-semibold">
              Provider
            </h3>
            <code className="font-mono text-[11px] text-muted-foreground">
              TRANSCRIPTION_PROVIDER
            </code>
          </div>
          <SegmentedControl<ProviderChoice>
            aria-labelledby={`${id}-provider`}
            value={choice}
            onValueChange={setChoice}
            options={[
              { value: "auto", label: "Auto-detect" },
              ...TRANSCRIPTION_PROVIDERS.map((p) => ({
                value: p.id,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <ProviderMark id={p.id} className="size-3.5" />
                    {p.label}
                  </span>
                ),
              })),
            ]}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Auto-detect uses the first key in the order ElevenLabs, OpenAI, Groq. A pinned provider
            uses only its own key.
            {envPinned ? " The deployment env pins one now." : null}
          </p>
          {spec && !hasOwnKey && !keySet(spec.keyEnv) ? (
            <p className="flex items-start gap-1.5 text-xs text-status-warning-strong">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              The swarm has no {spec.keyEnv}. Add an API key below, or transcription turns off.
            </p>
          ) : null}
        </section>
        <section className="space-y-4 px-5 py-4">
          <h3 className="text-sm font-semibold">Key and model</h3>
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${id}-key`} label="API key" configKey={TRANSCRIPTION_API_KEY} />
            <SecretInput
              id={`${id}-key`}
              value={apiKey}
              onChange={setApiKey}
              placeholder={
                keySet(TRANSCRIPTION_API_KEY)
                  ? "Saved. Paste a new value to replace it."
                  : `Paste a ${spec?.label ?? "provider"} key`
              }
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">
              Overrides the auto-detected key. Only the API server reads it. Agents and scripts
              never get it.
            </p>
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${id}-model`} label="Model" configKey="TRANSCRIPTION_MODEL" />
            <Input
              id={`${id}-model`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={spec?.defaultModel ?? "Provider default"}
              className="font-mono"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Empty uses the {spec ? `${spec.label} default` : "provider's default"}.
            </p>
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${id}-url`} label="Base URL" configKey="TRANSCRIPTION_BASE_URL" />
            <Input
              id={`${id}-url`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={spec?.defaultBaseUrl ?? "Provider default"}
              className="font-mono"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Applies only with the API key above. OpenAI also covers self-hosted whisper servers.
            </p>
          </div>
        </section>
      </div>
      <SheetFooter className="flex-row flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-5 py-3">
        <output className="min-w-0 flex-1 text-xs text-muted-foreground">
          {error ? (
            <StatusLine tone="error">{error}</StatusLine>
          ) : (
            "Applies to the next voice note. No restart."
          )}
        </output>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!dirty || pending}>
            {pending ? <Spinner className="size-4" /> : null}
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </SheetFooter>
    </>
  );
}

/** The "Change provider" side panel: pin a provider, or give transcription a key of its own. */
export function TranscriptionPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="flex-row items-start gap-3 border-b border-border-subtle px-5 py-4 pr-12">
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background"
          >
            <Mic className="size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <SheetTitle>Change transcription provider</SheetTitle>
            <SheetDescription>
              Pin a provider, or give transcription a key of its own.
            </SheetDescription>
          </div>
        </SheetHeader>
        {open ? <PanelBody onDone={() => onOpenChange(false)} /> : null}
      </SheetContent>
    </Sheet>
  );
}
