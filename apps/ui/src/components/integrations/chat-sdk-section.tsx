import { AlertCircle, Info, RotateCw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { useChatSdkStatus, useInvalidateChatSdkStatus } from "@/api/hooks/use-chat-sdk";
import { useUpsertConfigsBatch } from "@/api/hooks/use-config-api";
import type { ChatSdkStatusResponse, SwarmConfig } from "@/api/types";
import { AdapterPanel } from "@/components/integrations/chat-sdk-adapter-form";
import { CodeChip } from "@/components/integrations/chat-sdk-setup";
import type { SpecialFlowSectionProps } from "@/components/integrations/special-flows";
import { OAuthSection, OAuthSectionRow, OAuthStatusRow } from "@/components/shared/oauth-section";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CHAT_SDK_ADAPTER_DEFS, type ChatSdkAdapterName } from "@/lib/chat-sdk-fields";
import {
  type AdapterDraft,
  buildAll,
  type Drafts,
  initialDrafts,
  type JsonObject,
  maskSecretsForPreview,
  mergeAdaptersForSave,
  parseAdapters,
  storedEntryFor,
} from "@/lib/chat-sdk-form";
import { findConfigForKey, TRUTHY_VALUES } from "@/lib/integrations-status";

// ---------------------------------------------------------------------------
// Chat SDK card: one panel per adapter (`chat-sdk-adapter-form.tsx`), or only
// the `adapter` one (Connect > Channels links here with `?adapter=`). Form
// logic lives in `lib/chat-sdk-form.ts`. A save applies on the debounced config
// reload, no restart.
// ---------------------------------------------------------------------------

export function ChatSdkSection({ def, configs, adapter }: SpecialFlowSectionProps) {
  const status = useChatSdkStatus();
  const [savedNotice, setSavedNotice] = useState(false);
  const storedAdapters = findConfigForKey(configs, "CHAT_SDK_ADAPTERS")?.value;
  const storedEnabled = findConfigForKey(configs, "CHAT_SDK_ENABLED")?.value;
  // No config row: the running values come from the deployment environment.
  const envOnlyAdapters =
    storedAdapters === undefined && (status.data?.adapters.some((a) => a.configured) ?? false);
  const envOnlyEnabled = storedEnabled === undefined && status.data?.enabled === true;
  const statusError = status.isError
    ? `Status unavailable: ${status.error instanceof Error ? status.error.message : "request failed"}`
    : undefined;
  return (
    <div className="space-y-6">
      {savedNotice && (
        <AlertCallout tone="info" icon={RotateCw} title="Applying">
          Saved. The adapters restart with the new configuration within a few seconds.
        </AlertCallout>
      )}
      {status.data?.slackClash && (!adapter || adapter === "slack") && (
        <AlertCallout tone="error" icon={AlertCircle} title="Slack conflict">
          The Chat SDK Slack adapter needs the built-in Slack integration off. Set{" "}
          <CodeChip>SLACK_DISABLE=true</CodeChip>, or remove the Slack adapter. Until then the Chat
          SDK does not start.
        </AlertCallout>
      )}
      {status.data?.error && (
        <AlertCallout tone="error" icon={AlertCircle} title="Configuration error">
          {status.data.error}
        </AlertCallout>
      )}
      {envOnlyAdapters && (
        <AlertCallout tone="info" icon={Info} title="Set by the deployment environment">
          <CodeChip>CHAT_SDK_ADAPTERS</CodeChip> comes from the API environment. The switches show
          the running configuration and are locked. To store config rows, which take precedence, add{" "}
          <CodeChip>CHAT_SDK_ADAPTERS</CodeChip> under Settings, Secrets.
        </AlertCallout>
      )}
      {/* Remount when the stored values change, so the form follows an edit made elsewhere. */}
      <ChatSdkForm
        key={`${storedEnabled ?? ""}|${storedAdapters ?? ""}`}
        configs={configs}
        adapter={adapter}
        docsUrl={def.docsUrl}
        storedAdapters={storedAdapters}
        storedEnabled={
          storedEnabled !== undefined && TRUTHY_VALUES.has(storedEnabled.trim().toLowerCase())
        }
        envOnlyAdapters={envOnlyAdapters}
        envOnlyEnabled={envOnlyEnabled}
        status={status.data}
        statusError={statusError}
        onSaved={() => setSavedNotice(true)}
      />
    </div>
  );
}

interface ChatSdkFormProps {
  configs: SwarmConfig[];
  /** Show and save only this adapter. The other entries stay as stored. */
  adapter: ChatSdkAdapterName | undefined;
  docsUrl: string | undefined;
  storedAdapters: string | undefined;
  storedEnabled: boolean;
  envOnlyAdapters: boolean;
  envOnlyEnabled: boolean;
  status: ChatSdkStatusResponse | undefined;
  statusError: string | undefined;
  onSaved: () => void;
}

function batchErrorText(errors: Array<{ key: string; message: string }>): string {
  return errors.map((error) => `${error.key}: ${error.message}`).join(". ");
}

function ChatSdkForm({
  configs,
  adapter,
  docsUrl,
  storedAdapters,
  storedEnabled,
  envOnlyAdapters,
  envOnlyEnabled,
  status,
  statusError,
  onSaved,
}: ChatSdkFormProps) {
  const stored = useMemo(() => parseAdapters(storedAdapters), [storedAdapters]);
  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(stored));
  const [enabled, setEnabled] = useState(storedEnabled);
  const [saveError, setSaveError] = useState<string | undefined>();
  const upsert = useUpsertConfigsBatch();
  const invalidateStatus = useInvalidateChatSdkStatus();

  // Secret rows that exist: an adapter switched back on reuses its own rows.
  const existingKeys = useMemo(
    () => new Set(configs.filter((c) => c.scope === "global").map((c) => c.key)),
    [configs],
  );
  const built = useMemo(
    () => buildAll(drafts, stored, existingKeys),
    [drafts, stored, existingKeys],
  );
  // Compared with the stored value as this form would write it, so key order
  // and omitted defaults in hand-written JSON do not count as a change. Object
  // values (`$config` references) pass through unchanged on both sides.
  const baselineJson = useMemo(
    () => JSON.stringify(buildAll(initialDrafts(stored), stored, existingKeys).adapters),
    [stored, existingKeys],
  );
  const nextJson = JSON.stringify(built.adapters);
  const adaptersChanged = nextJson !== baselineJson;
  const dirty = adaptersChanged || enabled !== storedEnabled || built.secretRows.length > 0;

  function update(name: ChatSdkAdapterName, patch: (draft: AdapterDraft) => AdapterDraft) {
    // One adapter view has no separate step for the shared channel switch:
    // switching the adapter on switches the channel on with it.
    if (adapter && !envOnlyEnabled && patch(drafts[name]).enabled && !drafts[name].enabled) {
      setEnabled(true);
    }
    setDrafts((prev) => ({ ...prev, [name]: patch(prev[name]) }));
  }

  async function save() {
    setSaveError(undefined);
    // Batch 1: the secret rows. CHAT_SDK_ADAPTERS references them, so it is
    // written only after every row is stored. On a failure the draft stays.
    if (built.secretRows.length > 0) {
      // Server-only: the API reads bot tokens, agent shells never need them.
      const secrets = await upsert.mutateAsync(
        built.secretRows.map((row) => ({ ...row, isSecret: true, exportToEnv: false })),
      );
      if (secrets.failureCount > 0) {
        setSaveError(`Secrets not saved, nothing else changed. ${batchErrorText(secrets.errors)}`);
        return;
      }
    }
    // Batch 2: the adapters JSON, then the flag. The JSON is merged over the
    // row as stored right now, so an adapter added elsewhere while this form
    // was open survives the save.
    let mergedJson: string | undefined;
    if (adaptersChanged) {
      let fresh: JsonObject = stored;
      try {
        const current = await api.fetchConfigs({ scope: "global" });
        fresh = parseAdapters(findConfigForKey(current.configs, "CHAT_SDK_ADAPTERS")?.value);
      } catch {
        // Offline or denied: fall back to the value this form was built from.
      }
      mergedJson = JSON.stringify(mergeAdaptersForSave(fresh, stored, drafts, built.adapters));
    }
    const settings = [
      ...(mergedJson !== undefined
        ? [{ key: "CHAT_SDK_ADAPTERS", value: mergedJson, isSecret: false, exportToEnv: false }]
        : []),
      ...(enabled !== storedEnabled
        ? [
            {
              key: "CHAT_SDK_ENABLED",
              value: enabled ? "true" : "false",
              isSecret: false,
              exportToEnv: false,
            },
          ]
        : []),
    ];
    if (settings.length > 0) {
      const result = await upsert.mutateAsync(settings);
      if (result.failureCount > 0) {
        setSaveError(`Settings not saved. ${batchErrorText(result.errors)}`);
        return;
      }
    }
    // A secret-only change keeps the same JSON, so the form does not remount.
    setDrafts((prev) => {
      const next = { ...prev };
      for (const def of CHAT_SDK_ADAPTER_DEFS) next[def.name] = { ...prev[def.name], secrets: {} };
      return next;
    });
    void invalidateStatus();
    onSaved();
  }

  const shownDefs = adapter
    ? CHAT_SDK_ADAPTER_DEFS.filter((candidate) => candidate.name === adapter)
    : CHAT_SDK_ADAPTER_DEFS;
  // Messages carry a "<Label>: " prefix; one adapter view shows only its own.
  const ownMessage = (message: string) =>
    shownDefs.some((candidate) => message.startsWith(`${candidate.label}: `));
  const problems = built.problems.filter(ownMessage);
  const missing = built.missing.filter(ownMessage);
  const blocked = problems.length > 0;
  let rowMessage: ReactNode = <span className="text-muted-foreground">No unsaved changes</span>;
  if (saveError) {
    rowMessage = <span className="text-status-error-strong">{saveError}</span>;
  } else if (blocked) {
    rowMessage = <span className="text-status-error-strong">{problems.join(". ")}</span>;
  } else if (missing.length > 0) {
    // A partial save is allowed: the adapter stays off until it is complete.
    rowMessage = (
      <span className="text-status-warning-strong">
        {dirty ? "Saves as incomplete. " : "Incomplete. "}
        Still missing: {missing.join(", ")}. The adapter stays off until these are filled in.
      </span>
    );
  } else if (dirty) {
    rowMessage = <span className="text-muted-foreground">Unsaved changes</span>;
  }

  let channelLabel = status?.enabled ? "Enabled" : "Off";
  if (statusError) channelLabel = "Status unavailable";
  const adapterLabel = shownDefs[0]?.label;
  let channelDescription: ReactNode = envOnlyEnabled
    ? "Set by the deployment environment (CHAT_SDK_ENABLED). Starts the Chat SDK channel at API boot."
    : "Starts the Chat SDK channel. A save applies within a few seconds.";
  if (adapter && !statusError) {
    channelDescription = (
      <>
        {adapterLabel} runs on the Chat SDK channel, shared with the other adapters.
        {envOnlyEnabled && " Set by the deployment environment."}
        {!envOnlyEnabled && !enabled && ` Switching ${adapterLabel} on switches it on.`}{" "}
        <Link
          to="/integrations/chat-sdk"
          className="underline underline-offset-2 hover:text-foreground"
        >
          All adapters
        </Link>
      </>
    );
  }

  return (
    <div className="space-y-6">
      {/* Sticky, so Save stays in reach above the panels and the JSON preview. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background p-3">
        <div className="min-w-0 flex-1 text-xs">{rowMessage}</div>
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          disabled={!dirty || blocked || upsert.isPending}
        >
          {upsert.isPending ? "Saving…" : `Save ${adapter ? adapterLabel : "Chat SDK"} settings`}
        </Button>
      </div>

      <OAuthSection title={adapter ? "Chat SDK channel" : "Channel"}>
        <OAuthStatusRow
          tone={statusError ? "error" : status?.enabled ? "success" : "neutral"}
          label={channelLabel}
          description={statusError ?? channelDescription}
          actions={
            <Switch
              checked={envOnlyEnabled ? true : enabled}
              disabled={envOnlyEnabled}
              onCheckedChange={setEnabled}
              aria-label="Enable the Chat SDK channel"
            />
          }
        />
      </OAuthSection>

      {shownDefs.map((def) => (
        <AdapterPanel
          key={def.name}
          def={def}
          draft={drafts[def.name]}
          storedEntry={storedEntryFor(stored, def.name)}
          existingKeys={existingKeys}
          status={status?.adapters.find((adapter) => adapter.name === def.name)}
          statusError={statusError}
          envOnly={envOnlyAdapters}
          configs={configs}
          docsUrl={docsUrl}
          onChange={(patch) => update(def.name, patch)}
        />
      ))}

      {/* The whole JSON belongs to the all-adapters view. */}
      {!adapter && (
        <OAuthSection title="CHAT_SDK_ADAPTERS preview">
          <OAuthSectionRow className="border-t-0">
            <pre className="max-h-72 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {JSON.stringify(maskSecretsForPreview(built.adapters), null, 2)}
            </pre>
            <p className="text-xs text-muted-foreground">
              Secrets appear as <CodeChip>{'{"$config": "KEY"}'}</CodeChip> references. Their values
              are stored as secret config rows.
            </p>
          </OAuthSectionRow>
        </OAuthSection>
      )}
    </div>
  );
}
