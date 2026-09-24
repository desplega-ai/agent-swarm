import { type ReactNode, useState } from "react";
import { SetupChip } from "@/components/onboarding/setup-card";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import { BrandLogo } from "@/components/shared/brand-logo";
import { KEY_RULES, type SecretRule } from "@/components/shared/secret-field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SecretKeyField } from "./fields";
import type { AiCardProps } from "./model";
import { ProviderCard } from "./provider-card";

type ClaudeTab = "token" | "key";

const TAB_KEY: Record<ClaudeTab, string> = {
  token: "CLAUDE_CODE_OAUTH_TOKEN",
  key: "ANTHROPIC_API_KEY",
};

const RULES: Record<ClaudeTab, SecretRule> = {
  token: KEY_RULES.claudeToken,
  key: KEY_RULES.anthropicKey,
};

const TOKEN_TERMS =
  "The swarm runs the unmodified Claude Code CLI. Anthropic documents setup tokens for CI and automation on your own subscription. Do not share a token across people or organizations.";

export function ClaudeCard({ presence, onSaved, ...card }: AiCardProps) {
  const [tab, setTab] = useState<ClaudeTab>("token");
  const { save, isSaved } = useSetupSave(presence);

  const field = (t: ClaudeTab, placeholder: string, info: string, helper?: ReactNode) => (
    <SecretKeyField
      id={`setup-ai-${TAB_KEY[t]}`}
      envKey={TAB_KEY[t]}
      placeholder={placeholder}
      saved={isSaved(TAB_KEY[t])}
      rule={RULES[t]}
      info={info}
      helper={helper}
      onSave={async (value) => {
        await save([{ key: TAB_KEY[t], value, isSecret: true }]);
        onSaved(t === "token" ? "claude_setup_token" : "claude_api_key");
      }}
    />
  );

  return (
    <ProviderCard
      {...card}
      card="claude"
      icon={<BrandLogo src="/harness-logos/claude-code.svg" />}
      title="Claude"
      subtitle="Setup token from your subscription, or an API key."
      saved={isSaved(TAB_KEY.token) || isSaved(TAB_KEY.key)}
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
            TOKEN_TERMS,
            <>
              Run{" "}
              <code className="rounded border border-border bg-muted px-1 font-mono text-[11px]">
                claude setup-token
              </code>{" "}
              and paste the token.
            </>,
          )}
        </TabsContent>
        <TabsContent value="key">
          {field("key", "sk-ant-api03-...", "Billed per token through console.anthropic.com.")}
        </TabsContent>
      </Tabs>
    </ProviderCard>
  );
}
