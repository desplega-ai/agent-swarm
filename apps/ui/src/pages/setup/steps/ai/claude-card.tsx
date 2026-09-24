import { Info } from "lucide-react";
import { type ReactNode, useState } from "react";
import { BrandLogo, SetupChip } from "@/components/onboarding/setup-card";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SaveButton, SecretKeyField } from "./fields";
import type { AiCardProps } from "./model";
import { ProviderCard } from "./provider-card";

type ClaudeTab = "token" | "key";

const TAB_KEY: Record<ClaudeTab, string> = {
  token: "CLAUDE_CODE_OAUTH_TOKEN",
  key: "ANTHROPIC_API_KEY",
};

export function ClaudeCard({ presence, onSaved, ...card }: AiCardProps) {
  const [tab, setTab] = useState<ClaudeTab>("token");
  const [values, setValues] = useState<Record<ClaudeTab, string>>({ token: "", key: "" });
  const keys = useSetupSave(presence);
  const value = values[tab].trim();

  async function save() {
    const ok = await keys.save([{ key: TAB_KEY[tab], value, isSecret: true }]);
    if (!ok) return;
    setValues({ token: "", key: "" });
    onSaved(tab === "token" ? "claude_setup_token" : "claude_api_key");
  }

  const field = (t: ClaudeTab, placeholder: string, helper: ReactNode) => (
    <SecretKeyField
      key={keys.version}
      id={`setup-ai-${TAB_KEY[t]}`}
      envKey={TAB_KEY[t]}
      placeholder={placeholder}
      saved={keys.isSaved(TAB_KEY[t])}
      value={values[t]}
      onChange={(v) => setValues((prev) => ({ ...prev, [t]: v }))}
      helper={helper}
    />
  );

  return (
    <ProviderCard
      {...card}
      card="claude"
      icon={<BrandLogo src="/harness-logos/claude-code.svg" />}
      title="Claude"
      subtitle="Setup token from your subscription, or an API key."
      saved={keys.isSaved(TAB_KEY.token) || keys.isSaved(TAB_KEY.key)}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as ClaudeTab)}>
        <TabsList>
          <TabsTrigger value="token">
            Setup token
            <SetupChip tone="info">Recommended</SetupChip>
          </TabsTrigger>
          <TabsTrigger value="key">API key</TabsTrigger>
        </TabsList>
        <TabsContent value="token">
          {field(
            "token",
            "sk-ant-oat01-...",
            <>
              Run{" "}
              <code className="rounded border border-border bg-muted px-1 font-mono text-[11px]">
                claude setup-token
              </code>{" "}
              on your machine and paste the token. Uses your Claude subscription.
            </>,
          )}
        </TabsContent>
        <TabsContent value="key">
          {field("key", "sk-ant-api03-...", "Billed per token through console.anthropic.com.")}
        </TabsContent>
      </Tabs>
      <AlertCallout tone="info" icon={Info}>
        The swarm runs the unmodified Claude Code CLI. Anthropic documents setup tokens for CI and
        automation on your own subscription. Do not share a token across people or organizations.
      </AlertCallout>
      <SaveButton saving={keys.saving} disabled={!value} onClick={save} />
    </ProviderCard>
  );
}
