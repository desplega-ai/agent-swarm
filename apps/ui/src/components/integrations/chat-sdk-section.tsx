import { AlertCircle, Check, Copy, Info, RotateCw, Webhook } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  useChatSdkStatus,
  useInvalidateChatSdkStatus,
  useRegisterTelegramWebhook,
} from "@/api/hooks/use-chat-sdk";
import { useUpsertConfigsBatch } from "@/api/hooks/use-config-api";
import type { ChatSdkAdapterStatus, ChatSdkStatusResponse, SwarmConfig } from "@/api/types";
import type { SpecialFlowSectionProps } from "@/components/integrations/special-flows";
import {
  OAuthSection,
  OAuthSectionRow,
  OAuthStatusRow,
  type OAuthStatusTone,
} from "@/components/shared/oauth-section";
import { SecretInput } from "@/components/shared/secret-input";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import { Switch } from "@/components/ui/switch";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  CHAT_SDK_ADAPTER_DEFS,
  type ChatSdkAdapterDef,
  type ChatSdkAdapterName,
  type ChatSdkField,
} from "@/lib/chat-sdk-fields";
import {
  type AdapterDraft,
  buildAll,
  configRefKey,
  type Drafts,
  initialDrafts,
  isObject,
  isRequired,
  type JsonObject,
  maskSecretsForPreview,
  parseAdapters,
  secretFieldProblem,
  storedEntryFor,
} from "@/lib/chat-sdk-form";
import { findConfigForKey, TRUTHY_VALUES } from "@/lib/integrations-status";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Chat SDK card: one panel per adapter. Form logic lives in
// `lib/chat-sdk-form.ts`. A save applies on the debounced config reload, no restart.
// ---------------------------------------------------------------------------

export function ChatSdkSection({ configs }: SpecialFlowSectionProps) {
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
      {status.data?.slackClash && (
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
          the running configuration and are locked. To store config rows, which take precedence on
          save, edit the Advanced fields below.
        </AlertCallout>
      )}
      {/* Remount when the stored values change, so the form follows the Advanced editor. */}
      <ChatSdkForm
        key={`${storedEnabled ?? ""}|${storedAdapters ?? ""}`}
        configs={configs}
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

  const built = useMemo(() => buildAll(drafts, stored), [drafts, stored]);
  // Compared with the stored value as this form would write it, so key order
  // and omitted defaults in hand-written JSON do not count as a change. Object
  // values (`$config` references) pass through unchanged on both sides.
  const baselineJson = useMemo(
    () => JSON.stringify(buildAll(initialDrafts(stored), stored).adapters),
    [stored],
  );
  const nextJson = JSON.stringify(built.adapters);
  const adaptersChanged = nextJson !== baselineJson;
  const dirty = adaptersChanged || enabled !== storedEnabled || built.secretRows.length > 0;

  function update(name: ChatSdkAdapterName, patch: (draft: AdapterDraft) => AdapterDraft) {
    setDrafts((prev) => ({ ...prev, [name]: patch(prev[name]) }));
  }

  async function save() {
    setSaveError(undefined);
    // Batch 1: the secret rows. CHAT_SDK_ADAPTERS references them, so it is
    // written only after every row is stored. On a failure the draft stays.
    if (built.secretRows.length > 0) {
      const secrets = await upsert.mutateAsync(
        built.secretRows.map((row) => ({ ...row, isSecret: true })),
      );
      if (secrets.failureCount > 0) {
        setSaveError(`Secrets not saved, nothing else changed. ${batchErrorText(secrets.errors)}`);
        return;
      }
    }
    // Batch 2: the adapters JSON, then the flag.
    const settings = [
      ...(adaptersChanged ? [{ key: "CHAT_SDK_ADAPTERS", value: nextJson, isSecret: false }] : []),
      ...(enabled !== storedEnabled
        ? [{ key: "CHAT_SDK_ENABLED", value: enabled ? "true" : "false", isSecret: false }]
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

  const blocked = built.problems.length > 0;
  let rowMessage: ReactNode = <span className="text-muted-foreground">No unsaved changes</span>;
  if (saveError) {
    rowMessage = <span className="text-status-error-strong">{saveError}</span>;
  } else if (blocked) {
    rowMessage = <span className="text-status-error-strong">{built.problems.join(". ")}</span>;
  } else if (dirty) {
    rowMessage = <span className="text-muted-foreground">Unsaved changes</span>;
  }

  let channelLabel = status?.enabled ? "Enabled" : "Off";
  if (statusError) channelLabel = "Status unavailable";
  const channelDescription = envOnlyEnabled
    ? "Set by the deployment environment (CHAT_SDK_ENABLED). Starts the Chat SDK channel at API boot."
    : "Starts the Chat SDK channel. A save applies within a few seconds.";

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
          {upsert.isPending ? "Saving…" : "Save Chat SDK settings"}
        </Button>
      </div>

      <OAuthSection title="Channel">
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

      {CHAT_SDK_ADAPTER_DEFS.map((def) => (
        <AdapterPanel
          key={def.name}
          def={def}
          draft={drafts[def.name]}
          storedEntry={storedEntryFor(stored, def.name)}
          status={status?.adapters.find((adapter) => adapter.name === def.name)}
          statusError={statusError}
          envOnly={envOnlyAdapters}
          configs={configs}
          onChange={(patch) => update(def.name, patch)}
        />
      ))}

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
    </div>
  );
}

function healthView(
  status: ChatSdkAdapterStatus | undefined,
  included: boolean,
  statusError: string | undefined,
): { tone: OAuthStatusTone; label: string; description?: string } {
  if (statusError) return { tone: "error", label: "Status unavailable", description: statusError };
  if (!status?.configured) {
    return included
      ? { tone: "neutral", label: "Not saved" }
      : { tone: "neutral", label: "Not configured" };
  }
  if (status.health === "error") {
    return { tone: "error", label: "Failed to start", description: status.error };
  }
  if (status.health === "disabled") {
    return { tone: "neutral", label: "Not running", description: status.error };
  }
  const gateway = status.gateway;
  if (gateway && gateway.state !== "running") {
    return {
      tone: "active",
      label: `Running, Gateway ${gateway.state}`,
      description:
        status.error ??
        "The Gateway listener retries on its own. Messages sent meanwhile are lost.",
    };
  }
  return {
    tone: "success",
    label: "Running",
    description: gateway ? `Gateway restarts: ${gateway.restarts}` : undefined,
  };
}

const WEBHOOK_LABEL: Record<ChatSdkAdapterName, string> = {
  telegram: "Webhook URL",
  slack: "Event Subscriptions request URL",
  discord: "Interactions endpoint URL",
  teams: "Messaging endpoint",
};

interface AdapterPanelProps {
  def: ChatSdkAdapterDef;
  draft: AdapterDraft;
  storedEntry: JsonObject | undefined;
  status: ChatSdkAdapterStatus | undefined;
  statusError: string | undefined;
  /** The adapters come from the deployment env: the switch shows the running state, locked. */
  envOnly: boolean;
  configs: SwarmConfig[];
  onChange: (patch: (draft: AdapterDraft) => AdapterDraft) => void;
}

function AdapterPanel({
  def,
  draft,
  storedEntry,
  status,
  statusError,
  envOnly,
  configs,
  onChange,
}: AdapterPanelProps) {
  const { copied, copy } = useCopyToClipboard();
  const view = healthView(status, draft.included, statusError);
  const envConfigured = envOnly && status?.configured === true;
  const showDetails = draft.included || envConfigured;
  const savedMode = status?.mode;
  // The mode the panel shows: the draft while editing, else the running one.
  const mode = draft.included ? draft.values.mode : savedMode;
  const webhookUnused =
    (def.name === "telegram" && mode === "polling") || (def.name === "slack" && mode === "socket");

  return (
    <OAuthSection title={def.label}>
      <OAuthStatusRow
        tone={view.tone}
        label={view.label}
        description={view.description}
        actions={
          <Switch
            checked={envOnly ? envConfigured : draft.included}
            disabled={envOnly}
            onCheckedChange={(included) => onChange((prev) => ({ ...prev, included }))}
            aria-label={`Use ${def.label}`}
          />
        }
      />
      {showDetails && (
        <>
          {draft.included && (
            <OAuthSectionRow>
              <div className="grid gap-4 sm:grid-cols-2">
                {def.fields.map((field) => (
                  <FieldInput
                    key={field.key}
                    adapter={def.name}
                    field={field}
                    draft={draft}
                    storedValue={storedEntry?.[field.key]}
                    configs={configs}
                    onChange={onChange}
                  />
                ))}
              </div>
            </OAuthSectionRow>
          )}
          {status && (
            <OAuthSectionRow>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {WEBHOOK_LABEL[def.name]}
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                  {status.webhookUrl}
                </code>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-8 shrink-0"
                  onClick={() => void copy(status.webhookUrl)}
                  aria-label={copied ? "Copied" : `Copy the ${def.label} webhook URL`}
                >
                  {copied ? (
                    <Check className="size-3.5 text-status-success-strong" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </Button>
              </div>
              {webhookUnused && (
                <p className="text-xs text-muted-foreground">Not used in {mode} mode.</p>
              )}
            </OAuthSectionRow>
          )}
          {def.name === "telegram" && (
            <TelegramWebhookRow
              configured={status?.configured === true}
              savedMode={savedMode}
              draftMode={mode}
            />
          )}
        </>
      )}
    </OAuthSection>
  );
}

interface FieldInputProps {
  adapter: ChatSdkAdapterName;
  field: ChatSdkField;
  draft: AdapterDraft;
  storedValue: unknown;
  configs: SwarmConfig[];
  onChange: (patch: (draft: AdapterDraft) => AdapterDraft) => void;
}

function FieldInput({ adapter, field, draft, storedValue, configs, onChange }: FieldInputProps) {
  const id = `chat-sdk-${adapter}-${field.key}`;
  const required = isRequired(field, draft);
  const refKey = configRefKey(storedValue);
  const setValue = (value: string) =>
    onChange((prev) => ({ ...prev, values: { ...prev.values, [field.key]: value } }));

  if (field.kind === "secret") {
    const typed = draft.secrets[field.key] ?? "";
    const refMissing =
      refKey !== undefined && !configs.some((c) => c.scope === "global" && c.key === refKey);
    const problem = secretFieldProblem(adapter, field, typed);
    let helper: ReactNode = field.hint;
    if (problem) {
      helper = <span className="text-status-error-strong">{problem}.</span>;
    } else if (!typed && refKey) {
      const key = <CodeChip breakable>{refKey}</CodeChip>;
      helper = refMissing ? (
        <>References {key}, which has no stored value.</>
      ) : (
        <>Saved in {key}. Type a new value to replace it.</>
      );
    } else if (!typed && typeof storedValue === "string") {
      helper = "Stored inline in CHAT_SDK_ADAPTERS. Type a value to move it to a secret row.";
    }
    return (
      <SettingsRow label={field.label} htmlFor={id} required={required} helper={helper}>
        <SecretInput
          id={id}
          value={typed}
          autoComplete="new-password"
          placeholder={storedValue !== undefined ? "••••••••" : field.placeholder}
          aria-invalid={problem || (refMissing && !typed) ? true : undefined}
          onChange={(value) =>
            onChange((prev) => ({ ...prev, secrets: { ...prev.secrets, [field.key]: value } }))
          }
        />
      </SettingsRow>
    );
  }

  const value = draft.values[field.key] ?? "";
  if (field.kind === "select") {
    return (
      <SettingsRow label={field.label} htmlFor={id} helper={field.hint}>
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    );
  }
  if (field.kind === "boolean") {
    return (
      <SettingsRow label={field.label} htmlFor={id} helper={field.hint}>
        <Switch
          id={id}
          checked={value === "true"}
          onCheckedChange={(on) => setValue(on ? "true" : "")}
        />
      </SettingsRow>
    );
  }
  // An object value (a `$config` reference from the Advanced JSON) is kept
  // until the user types a replacement, like a saved secret.
  let helper: ReactNode = field.hint;
  if (!value.trim() && isObject(storedValue)) {
    helper = refKey ? (
      <>
        References <CodeChip breakable>{refKey}</CodeChip>. Type a new value to replace it.
      </>
    ) : (
      "Set as JSON in CHAT_SDK_ADAPTERS. Type a new value to replace it."
    );
  }
  return (
    <SettingsRow label={field.label} htmlFor={id} required={required} helper={helper}>
      <Input
        id={id}
        value={value}
        placeholder={field.placeholder}
        onChange={(event) => setValue(event.target.value)}
      />
    </SettingsRow>
  );
}

interface TelegramWebhookRowProps {
  configured: boolean;
  /** The mode the API runs with (status). The register call uses this one. */
  savedMode: string | undefined;
  draftMode: string | undefined;
}

function TelegramWebhookRow({ configured, savedMode, draftMode }: TelegramWebhookRowProps) {
  const register = useRegisterTelegramWebhook();
  const info = register.data?.webhookInfo;
  let blockedReason: string | undefined;
  if (!configured) blockedReason = "Save the Telegram settings first.";
  else if (draftMode !== savedMode)
    blockedReason = draftMode === "webhook" ? "Save webhook mode first." : "Save the mode first.";
  else if (savedMode !== "webhook") blockedReason = "Polling mode does not use a webhook.";
  return (
    <OAuthSectionRow>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          Points the bot at the webhook URL with the saved secret token (Bot API{" "}
          <CodeChip>setWebhook</CodeChip>).
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => register.mutate()}
          disabled={blockedReason !== undefined || register.isPending}
        >
          <Webhook className="size-3.5" />
          {register.isPending ? "Registering…" : "Register webhook"}
        </Button>
      </div>
      {blockedReason && <p className="text-xs text-muted-foreground">{blockedReason}</p>}
      {register.isError && (
        <AlertCallout tone="error" icon={AlertCircle}>
          {register.error instanceof Error ? register.error.message : "Registration failed"}
        </AlertCallout>
      )}
      {info && (
        <AlertCallout tone="success" icon={Check} title="Telegram webhook registered">
          <span className="block break-all font-mono text-xs">{info.url}</span>
          <span className="block text-xs">
            Pending updates:{" "}
            <span className="font-mono tabular-nums">{info.pending_update_count ?? 0}</span>
            {info.last_error_message ? `. Last error: ${info.last_error_message}` : ""}
          </span>
        </AlertCallout>
      )}
    </OAuthSectionRow>
  );
}

/** Inline mono chip. `breakable` lets a long key wrap inside the chip only. */
function CodeChip({ children, breakable }: { children: ReactNode; breakable?: boolean }) {
  return (
    <code
      className={cn(
        breakable ? "break-all" : "whitespace-nowrap",
        "rounded bg-muted px-1 py-0.5 font-mono text-xs",
      )}
    >
      {children}
    </code>
  );
}
