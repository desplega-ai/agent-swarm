import {
  type OpenAICompatibleProviderId,
  openAICompatibleProviders,
  providerKeyVars,
} from "@desplega/model-catalog";
import { useState } from "react";
import { usePoolKeysSupport } from "@/api/hooks/use-pool-keys-support";
import type { PoolKeysResponse } from "@/api/types";
import { KEY_RULES, type SecretRule } from "@/components/onboarding/autosave-secret-field";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import { BrandLogo } from "@/components/shared/brand-logo";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HARNESS_LABEL } from "@/lib/agent-runtime-models";
import { DISCLOSURE_TITLE, POOL_LIST_HINT, PoolKeyField, TextField } from "./fields";
import { type AiCardProps, baseUrlError, globalConfigValue, harnessNames } from "./model";
import { ProviderCard } from "./provider-card";

type OpenMode = "openrouter" | "gateway";

const OR_KEY = "OPENROUTER_API_KEY";
const BASE_URL = "OPENROUTER_BASE_URL";
const DS_KEY = "DEEPSEEK_API_KEY";
// OpenAI-compatible registry providers (NaN, Helmcode, ...), one key field each.
const DIRECT_PROVIDERS = openAICompatibleProviders();

// Gateway keys have no fixed shape: any value of 16+ characters.
const GATEWAY_RULE: SecretRule = {};

const GATEWAY_INFO = (
  <>
    The gateway must accept OpenRouter-style requests. Pick models with{" "}
    <code className="font-mono">MODEL_OVERRIDE=openrouter/&lt;model&gt;</code>. The API's own LLM
    calls (workflows, memory) also go through it.
  </>
);

function OpenHarnessIcon() {
  return (
    <span className="grid grid-cols-2 place-items-center gap-0.5">
      <BrandLogo src="/harness-logos/opencode.svg" className="size-3.5" />
      <BrandLogo src="/harness-logos/pi.svg" className="size-3.5" />
      <BrandLogo src="/provider-logos/deepseek.svg" className="col-span-2 size-3.5" />
    </span>
  );
}

export function OpenHarnessCard({ presence, configs, onSaved, ...card }: AiCardProps) {
  const { save, markSaved, isSaved } = useSetupSave(presence);
  // An alias (HELMCODE_API_NAN) counts: the runner copies it into the canonical var.
  const directSaved = (p: (typeof DIRECT_PROVIDERS)[number]) => providerKeyVars(p).some(isSaved);
  const [mode, setMode] = useState<OpenMode | null>(null);
  const poolSupport = usePoolKeysSupport();

  const gatewaySet = Boolean(presence[BASE_URL]);
  const currentUrl = globalConfigValue(configs, BASE_URL);
  const activeMode: OpenMode = mode ?? (gatewaySet ? "gateway" : "openrouter");

  // Removing the last key of a pool can clear the card's saved state.
  const onPoolRemoved = (key: string) => (list: PoolKeysResponse) =>
    markSaved(key, list.keys.length > 0);

  async function afterOpenRouterAdd() {
    if (activeMode === "gateway") {
      if (currentUrl || gatewaySet) onSaved("openai_gateway");
      return;
    }
    // A stored gateway URL would send this key to the gateway. Blank reverts to openrouter.ai.
    if (gatewaySet) {
      try {
        await save([{ key: BASE_URL, value: "", isSecret: false }]);
      } catch {
        return; // `save` already showed the error.
      }
    }
    onSaved("openrouter");
  }

  const keyField = (label: string, rule: SecretRule, placeholder: string, helper?: string) => (
    <PoolKeyField
      inputId={`setup-ai-openrouter-key-${activeMode}`}
      label={label}
      envKey={OR_KEY}
      placeholder={placeholder}
      rule={rule}
      helper={helper}
      logo={<BrandLogo src="/provider-logos/openrouter.svg" className="size-3.5" />}
      // OpenRouter mode tests at openrouter.ai, even while a gateway URL is still stored.
      checkBaseUrl={activeMode === "openrouter" ? null : undefined}
      onRemoved={onPoolRemoved(OR_KEY)}
      onAdded={() => {
        markSaved(OR_KEY, true);
        void afterOpenRouterAdd();
      }}
      legacy={{
        saved: isSaved(OR_KEY),
        onSave: async (value) => {
          if (activeMode === "gateway") {
            await save([{ key: OR_KEY, value, isSecret: true }]);
            if (currentUrl || gatewaySet) onSaved("openai_gateway");
            return;
          }
          await save([
            { key: OR_KEY, value, isSecret: true },
            ...(gatewaySet ? [{ key: BASE_URL, value: "", isSecret: false }] : []),
          ]);
          onSaved("openrouter");
        },
      }}
    />
  );

  return (
    <ProviderCard
      {...card}
      card="open"
      icon={<OpenHarnessIcon />}
      title="Open harnesses"
      subtitle={`${harnessNames("open", "and")}. One OpenRouter key runs all three.`}
      saved={isSaved(OR_KEY) || isSaved(DS_KEY) || DIRECT_PROVIDERS.some(directSaved)}
    >
      <Tabs value={activeMode} onValueChange={(v) => setMode(v as OpenMode)}>
        <TabsList>
          <TabsTrigger value="openrouter">OpenRouter</TabsTrigger>
          <TabsTrigger value="gateway">OpenAI-compatible gateway</TabsTrigger>
        </TabsList>
        <TabsContent value="openrouter">
          {keyField(
            "OpenRouter API key",
            KEY_RULES.openRouter,
            "sk-or-v1-...",
            gatewaySet ? "A new key here clears the gateway URL." : undefined,
          )}
        </TabsContent>
        <TabsContent value="gateway" className="space-y-3">
          <TextField
            id="setup-ai-openrouter-base-url"
            label="Gateway URL"
            envKey={BASE_URL}
            placeholder="https://gateway.example.com/v1"
            baseline={currentUrl}
            validate={baseUrlError}
            info={GATEWAY_INFO}
            onSave={async (value) => {
              await save([{ key: BASE_URL, value, isSecret: false }]);
              if (isSaved(OR_KEY)) onSaved("openai_gateway");
            }}
          />
          {keyField("Gateway API key", GATEWAY_RULE, "sk-...")}
        </TabsContent>
      </Tabs>

      {/* No onboarding method names the registry routes: a verified pi/opencode worker completes the step. */}
      <CollapsibleSection title="Direct keys instead" titleClassName={DISCLOSURE_TITLE}>
        <div className="space-y-3 pt-1.5">
          <p className="text-xs text-muted-foreground">
            {poolSupport === "legacy"
              ? "Each field takes more than one key: separate them with commas."
              : POOL_LIST_HINT}
          </p>
          <PoolKeyField
            inputId="setup-ai-deepseek-key"
            label="DeepSeek API key"
            envKey={DS_KEY}
            placeholder="sk-..."
            rule={KEY_RULES.deepSeek}
            poolHint={false}
            info={`For ${HARNESS_LABEL.dsh} without OpenRouter. ${HARNESS_LABEL.pi} and ${HARNESS_LABEL.opencode} also reuse the Anthropic and OpenAI keys.`}
            logo={<BrandLogo src="/provider-logos/deepseek.svg" className="size-3.5" />}
            onRemoved={onPoolRemoved(DS_KEY)}
            onAdded={() => {
              markSaved(DS_KEY, true);
              onSaved("deepseek");
            }}
            legacy={{
              saved: isSaved(DS_KEY),
              onSave: async (value) => {
                await save([{ key: DS_KEY, value, isSecret: true }]);
                onSaved("deepseek");
              },
            }}
          />
          {DIRECT_PROVIDERS.map((p) => (
            <PoolKeyField
              key={p.id}
              inputId={`setup-ai-${p.id}-key`}
              label={`${p.displayName} API key`}
              envKey={p.envVar}
              placeholder="sk-..."
              rule={GATEWAY_RULE}
              poolHint={false}
              info={
                <>
                  Runs <code className="font-mono">{p.id}/&lt;model&gt;</code> on {HARNESS_LABEL.pi}{" "}
                  and {HARNESS_LABEL.opencode}.
                </>
              }
              logo={
                <ProviderIcon provider={p.id as OpenAICompatibleProviderId} className="size-3.5" />
              }
              onRemoved={onPoolRemoved(p.envVar)}
              onAdded={() => markSaved(p.envVar, true)}
              legacy={{
                saved: directSaved(p),
                onSave: async (value) => {
                  await save([{ key: p.envVar, value, isSecret: true }]);
                },
              }}
            />
          ))}
        </div>
      </CollapsibleSection>
    </ProviderCard>
  );
}
