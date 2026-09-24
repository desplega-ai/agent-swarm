import { useState } from "react";
import type { UpsertConfigEntry } from "@/api/hooks/use-config-api";
import type { OnboardingAiMethod } from "@/api/types";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrandLogo } from "../../components/setup-card";
import { SaveButton, SecretField, TextField, useSaveKeys } from "./fields";
import { type AiCardProps, baseUrlError, globalConfigValue } from "./model";
import { ProviderCard } from "./provider-card";

type OpenMode = "openrouter" | "gateway";

const OR_KEY = "OPENROUTER_API_KEY";
const BASE_URL = "OPENROUTER_BASE_URL";
const DS_KEY = "DEEPSEEK_API_KEY";

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
  const keys = useSaveKeys(presence);
  const [mode, setMode] = useState<OpenMode | null>(null);
  const [orKey, setOrKey] = useState("");
  // null = untouched, so the field shows the stored base URL.
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [dsKey, setDsKey] = useState("");

  const gatewaySet = Boolean(presence[BASE_URL]);
  const currentUrl = globalConfigValue(configs, BASE_URL);
  const activeMode: OpenMode = mode ?? (gatewaySet ? "gateway" : "openrouter");
  const urlValue = baseUrl ?? currentUrl ?? "";
  const urlError = activeMode === "gateway" ? baseUrlError(urlValue) : null;

  const orV = orKey.trim();
  const dsV = dsKey.trim();
  const urlV = urlValue.trim();

  const entries: UpsertConfigEntry[] = [];
  let method: OnboardingAiMethod = "deepseek";
  let gatewayReady = true;
  if (activeMode === "gateway") {
    if (urlV && urlV !== currentUrl) entries.push({ key: BASE_URL, value: urlV, isSecret: false });
    if (orV) entries.push({ key: OR_KEY, value: orV, isSecret: true });
    if (entries.length > 0) {
      method = "openai_gateway";
      gatewayReady = Boolean(urlV || gatewaySet) && Boolean(orV || keys.isSaved(OR_KEY));
    }
  } else if (orV) {
    entries.push({ key: OR_KEY, value: orV, isSecret: true });
    // A stored gateway URL would send this key to the gateway. Blank reverts to openrouter.ai.
    if (gatewaySet) entries.push({ key: BASE_URL, value: "", isSecret: false });
    method = "openrouter";
  }
  if (dsV) entries.push({ key: DS_KEY, value: dsV, isSecret: true });

  async function save() {
    const ok = await keys.save(entries);
    if (!ok) return;
    setOrKey("");
    setDsKey("");
    setBaseUrl(null);
    onSaved(method);
  }

  const keyField = (placeholder: string, helper?: string) => (
    <SecretField
      key={keys.version}
      id="setup-ai-openrouter-key"
      envKey={OR_KEY}
      placeholder={placeholder}
      saved={keys.isSaved(OR_KEY)}
      value={orKey}
      onChange={setOrKey}
      helper={helper}
      logo={<BrandLogo src="/provider-logos/openrouter.svg" className="size-3.5" />}
    />
  );

  return (
    <ProviderCard
      {...card}
      card="open"
      icon={<OpenHarnessIcon />}
      title="Open harnesses: opencode, pi, DeepSeek"
      subtitle="Model-agnostic harnesses. One OpenRouter key runs all three."
      saved={keys.isSaved(OR_KEY) || keys.isSaved(DS_KEY)}
    >
      <Tabs value={activeMode} onValueChange={(v) => setMode(v as OpenMode)}>
        <TabsList>
          <TabsTrigger value="openrouter">OpenRouter</TabsTrigger>
          <TabsTrigger value="gateway">OpenAI-compatible gateway</TabsTrigger>
        </TabsList>
        <TabsContent value="openrouter">
          {keyField(
            "sk-or-v1-...",
            gatewaySet
              ? "A gateway base URL is set. Saving a key here switches back to openrouter.ai."
              : undefined,
          )}
        </TabsContent>
        <TabsContent value="gateway" className="space-y-3">
          <TextField
            id="setup-ai-openrouter-base-url"
            envKey={BASE_URL}
            placeholder="https://gateway.example.com/v1"
            value={urlValue}
            onChange={setBaseUrl}
            error={urlError}
          />
          {keyField("sk-...")}
          <p className="text-xs text-muted-foreground">
            The gateway must accept OpenRouter-style requests. Pick models with{" "}
            <code className="rounded border border-border bg-muted px-1 font-mono text-[11px]">
              MODEL_OVERRIDE=openrouter/&lt;model&gt;
            </code>
            . The API's own LLM calls (workflows, memory) also go through it.
          </p>
        </TabsContent>
      </Tabs>

      <CollapsibleSection title="Direct keys instead">
        <div className="space-y-2 pt-1.5">
          <SecretField
            key={keys.version}
            id="setup-ai-deepseek-key"
            envKey={DS_KEY}
            placeholder="sk-..."
            saved={keys.isSaved(DS_KEY)}
            value={dsKey}
            onChange={setDsKey}
            helper="For DeepSeek (dsh) without OpenRouter."
            logo={<BrandLogo src="/provider-logos/deepseek.svg" className="size-3.5" />}
          />
          <p className="text-xs text-muted-foreground">
            pi and opencode also reuse the Anthropic and OpenAI keys from above.
          </p>
        </div>
      </CollapsibleSection>

      <SaveButton
        saving={keys.saving}
        disabled={entries.length === 0 || Boolean(urlError) || !gatewayReady}
        onClick={save}
      />
    </ProviderCard>
  );
}
