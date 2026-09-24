import { useState } from "react";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import { BrandLogo } from "@/components/shared/brand-logo";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { KEY_RULES, type SecretRule } from "@/components/shared/secret-field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SecretKeyField, TextField } from "./fields";
import { type AiCardProps, baseUrlError, globalConfigValue } from "./model";
import { ProviderCard } from "./provider-card";

type OpenMode = "openrouter" | "gateway";

const OR_KEY = "OPENROUTER_API_KEY";
const BASE_URL = "OPENROUTER_BASE_URL";
const DS_KEY = "DEEPSEEK_API_KEY";

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
  const { save, isSaved } = useSetupSave(presence);
  const [mode, setMode] = useState<OpenMode | null>(null);

  const gatewaySet = Boolean(presence[BASE_URL]);
  const currentUrl = globalConfigValue(configs, BASE_URL);
  const activeMode: OpenMode = mode ?? (gatewaySet ? "gateway" : "openrouter");

  const keyField = (rule: SecretRule, placeholder: string, helper?: string) => (
    <SecretKeyField
      id={`setup-ai-openrouter-key-${activeMode}`}
      envKey={OR_KEY}
      placeholder={placeholder}
      saved={isSaved(OR_KEY)}
      rule={rule}
      helper={helper}
      logo={<BrandLogo src="/provider-logos/openrouter.svg" className="size-3.5" />}
      onSave={async (value) => {
        if (activeMode === "gateway") {
          await save([{ key: OR_KEY, value, isSecret: true }]);
          if (currentUrl || gatewaySet) onSaved("openai_gateway");
          return;
        }
        // A stored gateway URL would send this key to the gateway. Blank reverts to openrouter.ai.
        await save([
          { key: OR_KEY, value, isSecret: true },
          ...(gatewaySet ? [{ key: BASE_URL, value: "", isSecret: false }] : []),
        ]);
        onSaved("openrouter");
      }}
    />
  );

  return (
    <ProviderCard
      {...card}
      card="open"
      icon={<OpenHarnessIcon />}
      title="Open harnesses: opencode, pi, DeepSeek"
      subtitle="Model-agnostic harnesses. One OpenRouter key runs all three."
      saved={isSaved(OR_KEY) || isSaved(DS_KEY)}
    >
      <Tabs value={activeMode} onValueChange={(v) => setMode(v as OpenMode)}>
        <TabsList>
          <TabsTrigger value="openrouter">OpenRouter</TabsTrigger>
          <TabsTrigger value="gateway">OpenAI-compatible gateway</TabsTrigger>
        </TabsList>
        <TabsContent value="openrouter">
          {keyField(
            KEY_RULES.openRouter,
            "sk-or-v1-...",
            gatewaySet ? "A new key here clears the gateway URL." : undefined,
          )}
        </TabsContent>
        <TabsContent value="gateway" className="space-y-3">
          <TextField
            id="setup-ai-openrouter-base-url"
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
          {keyField(GATEWAY_RULE, "sk-...")}
        </TabsContent>
      </Tabs>

      <CollapsibleSection title="Direct keys instead">
        <div className="pt-1.5">
          <SecretKeyField
            id="setup-ai-deepseek-key"
            envKey={DS_KEY}
            placeholder="sk-..."
            saved={isSaved(DS_KEY)}
            rule={KEY_RULES.deepSeek}
            info={
              <>
                For DeepSeek (dsh) without OpenRouter. pi and opencode also reuse the Anthropic and
                OpenAI keys.
              </>
            }
            logo={<BrandLogo src="/provider-logos/deepseek.svg" className="size-3.5" />}
            onSave={async (value) => {
              await save([{ key: DS_KEY, value, isSecret: true }]);
              onSaved("deepseek");
            }}
          />
        </div>
      </CollapsibleSection>
    </ProviderCard>
  );
}
