import { AlertCircle, Check, Copy, Webhook } from "lucide-react";
import type { ReactNode } from "react";
import { useRegisterTelegramWebhook } from "@/api/hooks/use-chat-sdk";
import type { ChatSdkAdapterStatus, SwarmConfig } from "@/api/types";
import { ChatSdkSetup, CodeChip } from "@/components/integrations/chat-sdk-setup";
import { BetaTag } from "@/components/shared/beta-tag";
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
import type { ChatSdkAdapterDef, ChatSdkAdapterName, ChatSdkField } from "@/lib/chat-sdk-fields";
import {
  type AdapterDraft,
  configRefKey,
  discordInviteUrl,
  effectiveSecretValue,
  isObject,
  isRequired,
  type JsonObject,
  localTunnelPort,
  secretFieldProblem,
} from "@/lib/chat-sdk-form";
import { cn } from "@/lib/utils";

// One Chat SDK adapter: health, enable switch, setup steps, fields, webhook
// URL, and for Telegram the webhook registration. The shared shell
// (`chat-sdk-section.tsx`) owns the drafts and the save.

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
  if (!status.enabled) {
    return { tone: "neutral", label: "Off, configuration kept", description: status.error };
  }
  if (status.health === "error") {
    return { tone: "error", label: "Failed to start", description: status.error };
  }
  if (status.health === "incomplete") {
    return { tone: "neutral", label: "Incomplete, not running", description: status.error };
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
  // A connected Discord bot that is in no server never gets a message: the
  // invite step was skipped.
  if (status.guilds?.count === 0) {
    return {
      tone: "active",
      label: "Running, in no server",
      description:
        "The bot is connected but was not invited anywhere. Use the invite link in the setup steps.",
    };
  }
  let description: string | undefined;
  if (status.guilds) {
    const names = status.guilds.names.join(", ");
    const more = status.guilds.count - status.guilds.names.length;
    description = `In ${status.guilds.count} server${status.guilds.count === 1 ? "" : "s"}: ${names}${more > 0 ? ` and ${more} more` : ""}`;
  } else if (gateway) {
    description = `Gateway restarts: ${gateway.restarts}`;
  }
  return { tone: "success", label: "Running", description };
}

const WEBHOOK_LABEL: Record<ChatSdkAdapterName, string> = {
  telegram: "Webhook URL",
  slack: "Event Subscriptions request URL",
  discord: "Interactions endpoint URL",
  teams: "Messaging endpoint",
};

export interface AdapterPanelProps {
  def: ChatSdkAdapterDef;
  draft: AdapterDraft;
  storedEntry: JsonObject | undefined;
  /** Global config keys that exist (secret rows of a switched-off adapter are reused). */
  existingKeys: ReadonlySet<string>;
  status: ChatSdkAdapterStatus | undefined;
  statusError: string | undefined;
  /** The adapters come from the deployment env: the switch shows the running state, locked. */
  envOnly: boolean;
  configs: SwarmConfig[];
  docsUrl: string | undefined;
  onChange: (patch: (draft: AdapterDraft) => AdapterDraft) => void;
}

export function AdapterPanel({
  def,
  draft,
  storedEntry,
  existingKeys,
  status,
  statusError,
  envOnly,
  configs,
  docsUrl,
  onChange,
}: AdapterPanelProps) {
  const { copied, copy } = useCopyToClipboard();
  const view = healthView(status, draft.included, statusError);
  const envConfigured = envOnly && status?.configured === true;
  const showDetails = draft.included || envConfigured;
  const switchOn = envOnly ? envConfigured && status?.enabled !== false : draft.enabled;
  const savedMode = status?.mode;
  // The mode the panel shows: the draft while editing, else the running one.
  const mode = draft.included ? draft.values.mode : savedMode;
  const webhookUnused =
    (def.name === "telegram" && mode === "polling") || (def.name === "slack" && mode === "socket");
  const tunnelPort = status && !webhookUnused ? localTunnelPort(status.webhookUrl) : undefined;
  // Wait for the first status (or its error), so the default fits the health.
  const statusKnown = status !== undefined || statusError !== undefined;

  return (
    <OAuthSection
      title={
        <span className="inline-flex items-center gap-2">
          {def.label}
          {def.experimental && <BetaTag tooltip={def.experimental} side="top" />}
        </span>
      }
    >
      <OAuthStatusRow
        tone={view.tone}
        label={view.label}
        description={view.description}
        actions={
          <div className="flex items-center gap-3">
            {draft.included && !draft.enabled && !envOnly && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => onChange((prev) => ({ ...prev, included: false }))}
              >
                Remove configuration
              </Button>
            )}
            <Switch
              checked={switchOn}
              disabled={envOnly}
              // Off keeps the entry (`enabled: false`); on creates it when needed.
              onCheckedChange={(enabled) =>
                onChange((prev) => ({ ...prev, enabled, included: enabled || prev.included }))
              }
              aria-label={`Use ${def.label}`}
            />
          </div>
        }
      />
      {statusKnown && (
        <OAuthSectionRow>
          {/* Remounted when the switch flips: the steps unfold once the adapter is on. */}
          <ChatSdkSetup
            key={switchOn ? "on" : "off"}
            adapter={def.name}
            docsUrl={docsUrl}
            defaultOpen={switchOn}
            webhookUrl={status?.webhookUrl}
            inviteUrl={
              def.name === "discord"
                ? discordInviteUrl(
                    draft.values.applicationId ||
                      (typeof storedEntry?.applicationId === "string"
                        ? storedEntry.applicationId
                        : undefined),
                  )
                : undefined
            }
          />
        </OAuthSectionRow>
      )}
      {draft.included && (
        <OAuthSectionRow>
          <div className="grid gap-4 sm:grid-cols-2">
            {def.fields.map((field) => (
              <FieldInput
                key={field.key}
                adapter={def.name}
                field={field}
                draft={draft}
                storedValue={
                  field.kind === "secret"
                    ? effectiveSecretValue(def.name, field, storedEntry?.[field.key], existingKeys)
                    : storedEntry?.[field.key]
                }
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
          {tunnelPort && (
            <p className="text-xs text-muted-foreground">
              Behind localhost? Expose the API with a tunnel, for example{" "}
              <CodeChip>ngrok http {tunnelPort}</CodeChip>, set{" "}
              <CodeChip>PUBLIC_MCP_BASE_URL</CodeChip> to the tunnel URL, then register the webhook.
            </p>
          )}
        </OAuthSectionRow>
      )}
      {showDetails && def.name === "telegram" && (
        <TelegramWebhookRow
          configured={status?.configured === true}
          savedMode={savedMode}
          draftMode={mode}
        />
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
    const hints = field.optionHints;
    const helper: ReactNode = hints
      ? field.options?.map((option) => (
          <span key={option} className="block">
            <span className={cn(option === value && "font-medium text-foreground")}>{option}</span>:{" "}
            {hints[option]}
          </span>
        ))
      : field.hint;
    return (
      <SettingsRow label={field.label} htmlFor={id} helper={helper}>
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
  // An object value (a `$config` reference written in the raw JSON) is kept
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
