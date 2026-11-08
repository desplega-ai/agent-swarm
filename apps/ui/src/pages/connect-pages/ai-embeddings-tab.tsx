import { Database, Server } from "lucide-react";
import { Link } from "react-router-dom";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useOnboarding } from "@/api/hooks/use-onboarding";
import type { OnboardingMemoryProvider } from "@/api/types";
import { MemoryEmbeddingsSection } from "@/components/integrations/memory-embeddings-section";
import { BrandLogo } from "@/components/shared/brand-logo";
import { KeyStatusPill } from "@/components/shared/key-status-pill";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { FactRow, KeyName, Mono, SetupCard, TabIntro } from "./ai-tab-parts";

const MEMORY_GUIDE = "https://docs.agent-swarm.dev/docs/architecture/memory";

/** Names and marks of `signals.embeddings.provider`, as the `/setup` presets show them. */
const PROVIDERS: Record<OnboardingMemoryProvider, { label: string; logo?: string }> = {
  local: { label: "Local" },
  openai: { label: "OpenAI", logo: "/provider-logos/openai.svg" },
  openrouter: { label: "OpenRouter", logo: "/provider-logos/openrouter.svg" },
  vercel: { label: "Vercel AI Gateway", logo: "/integration-logos/vercel.svg" },
  azure: { label: "Azure / Microsoft Foundry", logo: "/integration-logos/microsoft.svg" },
  custom: { label: "Custom endpoint" },
};

const KEY_KEYS = ["EMBEDDING_API_KEY", "OPENAI_API_KEY"];

function ProviderMark({ provider }: { provider: OnboardingMemoryProvider | null | undefined }) {
  const logo = provider ? PROVIDERS[provider].logo : undefined;
  const Icon = provider === "local" ? Server : Database;
  return (
    <span
      aria-hidden
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background"
    >
      {logo ? <BrandLogo src={logo} className="size-5" /> : <Icon className="size-5" />}
    </span>
  );
}

/**
 * Connect › AI providers › Embeddings: the provider, model and vector size
 * memory uses now, with what a change does to the memories that exist.
 * "Change provider" opens the `/setup` embeddings form (presets, test and
 * save) in a side panel.
 */
export function EmbeddingsTab() {
  const onboarding = useOnboarding();
  const configs = useConfigs({ scope: "global" });
  const presence = useEnvPresence(KEY_KEYS);
  const signals = onboarding.data?.signals.embeddings;

  if (onboarding.isLoading) return <Skeleton className="h-56 w-full" />;
  if (!signals) {
    return (
      <p className="text-sm text-muted-foreground">
        This server does not report its memory setup.{" "}
        <Link to="/integrations/memory" className="text-primary hover:underline">
          Open the memory settings
        </Link>
        .
      </p>
    );
  }

  const { configured, dimensions, model, local, provider } = signals;
  const providerLabel = provider ? PROVIDERS[provider].label : configured ? "Set up" : "Off";
  const baseUrl = configs.data
    ?.find((c) => c.scope === "global" && c.key === "EMBEDDING_API_BASE_URL")
    ?.value.trim();
  const keyName = presence.data?.EMBEDDING_API_KEY
    ? "EMBEDDING_API_KEY"
    : presence.data?.OPENAI_API_KEY
      ? "OPENAI_API_KEY"
      : null;

  return (
    <div className="flex flex-col gap-3">
      <TabIntro href={MEMORY_GUIDE} label="Memory guide">
        Memory turns each memory into a vector, so agents find it by meaning. With no embeddings,
        recall falls back to keyword search.
      </TabIntro>
      <SetupCard
        mark={<ProviderMark provider={provider} />}
        title={configured ? providerLabel : "Keyword search only"}
        status={
          <KeyStatusPill tone={configured ? "success" : "neutral"}>
            {configured ? "On" : "Off"}
          </KeyStatusPill>
        }
        subtitle={
          configured ? (
            <>
              {model ? <Mono>{model}</Mono> : null}
              {model ? " · " : null}
              {dimensions} dims
            </>
          ) : (
            "No embeddings key. Change provider to turn memory search on."
          )
        }
        facts={
          <>
            <FactRow label="Provider">{providerLabel}</FactRow>
            {configured && model ? (
              <FactRow label="Model">
                <Mono>{model}</Mono>
              </FactRow>
            ) : null}
            <FactRow label="Dimensions" note="fixed for every model">
              <Mono>{dimensions}</Mono>
            </FactRow>
            {configured ? (
              <FactRow
                label="Key"
                note={
                  local
                    ? undefined
                    : keyName === "OPENAI_API_KEY"
                      ? "read when EMBEDDING_API_KEY is unset"
                      : undefined
                }
              >
                {local ? "None needed" : keyName ? <KeyName>{keyName}</KeyName> : "Not set"}
              </FactRow>
            ) : null}
            {configured && baseUrl ? (
              <FactRow label="Endpoint">
                <Mono>{baseUrl}</Mono>
              </FactRow>
            ) : null}
          </>
        }
        aside={
          <>
            <h3 className="font-semibold text-foreground">Before you change it</h3>
            <p>
              Memories that have a vector keep it. A new model makes vectors that do not match the
              old ones, so recall of older memories gets worse.
            </p>
            <p>
              Memories with no vector, or one of the wrong size, get a new one in the background
              when the API server starts and when memory search turns on.
            </p>
          </>
        }
        footer={
          <>
            <span>The stored values are on the memory settings page.</span>
            <Link to="/integrations/memory" className="text-primary hover:underline">
              All settings
            </Link>
          </>
        }
      />
    </div>
  );
}

/**
 * The side panel of "Change provider": the same form, presets and
 * test-and-save probe as `/setup` and the memory settings page. The API
 * stores a setup only when its test passes, so closing the panel without a
 * passing test changes nothing.
 */
export function EmbeddingsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="flex-row items-start gap-3 border-b border-border-subtle px-5 py-4 pr-12">
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background"
          >
            <Database className="size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <SheetTitle>Change embeddings provider</SheetTitle>
            <SheetDescription>
              Memory recall finds memories by meaning with these vectors. Pick a preset, a model and
              a key.
            </SheetDescription>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">
          {open ? <MemoryEmbeddingsSection /> : null}
        </div>
        <SheetFooter className="flex-row flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-5 py-3">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            The swarm tests a setup before it saves it.
          </p>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
