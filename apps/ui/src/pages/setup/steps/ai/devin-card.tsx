import type { SecretRule } from "@/components/onboarding/secret-field";
import { BrandLogo } from "@/components/onboarding/setup-card";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import { SecretKeyField, TextField } from "./fields";
import { type AiCardProps, globalConfigValue } from "./model";
import { ProviderCard } from "./provider-card";

const API_KEY = "DEVIN_API_KEY";
const ORG_ID = "DEVIN_ORG_ID";

// Service user keys and personal tokens use different prefixes; others save on blur.
const KEY_RULE: SecretRule = { prefixes: ["cog_", "apk_"], minLength: 20 };

export function DevinCard({ presence, configs, onSaved, ...card }: AiCardProps) {
  const { save, isSaved } = useSetupSave(presence);
  const currentOrg = globalConfigValue(configs, ORG_ID);
  // Devin workers need both values.
  const keySaved = isSaved(API_KEY);
  const orgSaved = Boolean(currentOrg) || isSaved(ORG_ID);

  return (
    <ProviderCard
      {...card}
      card="devin"
      icon={<BrandLogo src="/harness-logos/devin.svg" />}
      title="Devin"
      subtitle="Managed cloud agents from app.devin.ai."
      saved={keySaved}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SecretKeyField
          id="setup-ai-devin-key"
          envKey={API_KEY}
          placeholder="cog_..."
          saved={keySaved}
          rule={KEY_RULE}
          info="Service user key or personal access token from app.devin.ai."
          onSave={async (value) => {
            await save([{ key: API_KEY, value, isSecret: true }]);
            if (orgSaved) onSaved("devin");
          }}
        />
        <TextField
          id="setup-ai-devin-org"
          envKey={ORG_ID}
          placeholder="org_..."
          baseline={currentOrg}
          onSave={async (value) => {
            await save([{ key: ORG_ID, value, isSecret: false }]);
            if (keySaved) onSaved("devin");
          }}
        />
      </div>
    </ProviderCard>
  );
}
