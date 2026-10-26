import { type ReactNode, useState } from "react";
import { KEY_RULES, type SecretRule } from "@/components/onboarding/autosave-secret-field";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import { BrandLogo } from "@/components/shared/brand-logo";
import { SetupChip } from "@/components/shared/setup-chip";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PoolKeyField } from "./fields";
import type { AiCardProps } from "./model";
import { ProviderCard } from "./provider-card";

type ClaudeTab = "token" | "key";

const TAB_KEY: Record<ClaudeTab, string> = {
  token: "CLAUDE_CODE_OAUTH_TOKEN",
  key: "ANTHROPIC_API_KEY",
};

const TAB_LABEL: Record<ClaudeTab, string> = {
  token: "Claude subscription token",
  key: "Anthropic API key",
};

const RULES: Record<ClaudeTab, SecretRule> = {
  token: KEY_RULES.claudeToken,
  key: KEY_RULES.anthropicKey,
};

const fieldId = (t: ClaudeTab) => `setup-ai-${TAB_KEY[t]}`;

const TOKEN_TERMS =
  "The swarm runs the unmodified Claude Code CLI. Anthropic documents setup tokens for CI and automation on your own subscription. Do not share a token across people or organizations.";

export function ClaudeCard({ presence, onSaved, ...card }: AiCardProps) {
  const [tab, setTab] = useState<ClaudeTab>("token");
  const { save, markSaved, isSaved } = useSetupSave(presence);

  const field = (t: ClaudeTab, placeholder: string, helper: ReactNode, info?: string) => (
    <PoolKeyField
      inputId={fieldId(t)}
      label={TAB_LABEL[t]}
      envKey={TAB_KEY[t]}
      placeholder={placeholder}
      rule={RULES[t]}
      info={info}
      helper={helper}
      onAdded={() => {
        markSaved(TAB_KEY[t], true);
        onSaved(t === "token" ? "claude_setup_token" : "claude_api_key");
      }}
      onRemoved={(list) => markSaved(TAB_KEY[t], list.keys.length > 0)}
      legacy={{
        saved: isSaved(TAB_KEY[t]),
        onSave: async (value) => {
          await save([{ key: TAB_KEY[t], value, isSecret: true }]);
          onSaved(t === "token" ? "claude_setup_token" : "claude_api_key");
        },
      }}
    />
  );

  return (
    <ProviderCard
      {...card}
      card="claude"
      icon={<BrandLogo src="/harness-logos/claude-code.svg" />}
      title="Claude"
      subtitle="Your Claude subscription, or an Anthropic API key."
      saved={isSaved(TAB_KEY.token) || isSaved(TAB_KEY.key)}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as ClaudeTab)}>
        <TabsList>
          <TabsTrigger value="token">
            Subscription
            <SetupChip tone="info">Recommended</SetupChip>
          </TabsTrigger>
          <TabsTrigger value="key">API key</TabsTrigger>
        </TabsList>
        <TabsContent value="token" className="space-y-1">
          {field(
            "token",
            "sk-ant-oat01-...",
            <>
              Uses your Claude subscription. On a computer with Claude Code, run{" "}
              <code className="rounded border border-border bg-muted px-1 font-mono text-[11px]">
                claude setup-token
              </code>{" "}
              in a terminal and paste the token it prints.
            </>,
            TOKEN_TERMS,
          )}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0"
            onClick={() => {
              setTab("key");
              // The link unmounts with its tab: focus the field it opens. The
              // tab content mounts its children one render later, before the frame.
              requestAnimationFrame(() => document.getElementById(fieldId("key"))?.focus());
            }}
          >
            Use an Anthropic API key instead
          </Button>
        </TabsContent>
        <TabsContent value="key">
          {field(
            "key",
            "sk-ant-api03-...",
            "Billed per token. Create a key at console.anthropic.com.",
          )}
        </TabsContent>
      </Tabs>
    </ProviderCard>
  );
}
