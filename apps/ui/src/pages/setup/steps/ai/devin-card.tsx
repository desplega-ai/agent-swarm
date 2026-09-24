import { useState } from "react";
import type { UpsertConfigEntry } from "@/api/hooks/use-config-api";
import { BrandLogo } from "../../components/setup-card";
import { SaveButton, SecretField, TextField, useSaveKeys } from "./fields";
import { type AiCardProps, globalConfigValue } from "./model";
import { ProviderCard } from "./provider-card";

const API_KEY = "DEVIN_API_KEY";
const ORG_ID = "DEVIN_ORG_ID";

export function DevinCard({ presence, configs, onSaved, ...card }: AiCardProps) {
  const keys = useSaveKeys(presence);
  const [apiKey, setApiKey] = useState("");
  // null = untouched, so the field shows the stored org id.
  const [orgId, setOrgId] = useState<string | null>(null);

  const currentOrg = globalConfigValue(configs, ORG_ID);
  const keyV = apiKey.trim();
  const orgV = (orgId ?? currentOrg ?? "").trim();

  const entries: UpsertConfigEntry[] = [];
  if (keyV) entries.push({ key: API_KEY, value: keyV, isSecret: true });
  if (orgV && orgV !== currentOrg) entries.push({ key: ORG_ID, value: orgV, isSecret: false });
  // Devin workers need both values.
  const ready = Boolean(keyV || keys.isSaved(API_KEY)) && Boolean(orgV || keys.isSaved(ORG_ID));

  async function save() {
    const ok = await keys.save(entries);
    if (!ok) return;
    setApiKey("");
    setOrgId(null);
    onSaved("devin");
  }

  return (
    <ProviderCard
      {...card}
      card="devin"
      icon={<BrandLogo src="/harness-logos/devin.svg" />}
      title="Devin"
      subtitle="Managed cloud agents from app.devin.ai."
      saved={keys.isSaved(API_KEY)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SecretField
          key={keys.version}
          id="setup-ai-devin-key"
          envKey={API_KEY}
          placeholder="cog_..."
          saved={keys.isSaved(API_KEY)}
          value={apiKey}
          onChange={setApiKey}
        />
        <TextField
          id="setup-ai-devin-org"
          envKey={ORG_ID}
          placeholder="org_..."
          value={orgId ?? currentOrg ?? ""}
          onChange={setOrgId}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Service user key or personal access token from app.devin.ai.
      </p>
      <SaveButton saving={keys.saving} disabled={entries.length === 0 || !ready} onClick={save} />
    </ProviderCard>
  );
}
