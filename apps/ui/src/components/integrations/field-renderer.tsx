import { Check, Copy } from "lucide-react";
import { usePoolKeysSupport } from "@/api/hooks/use-pool-keys-support";
import type { SwarmConfig } from "@/api/types";
import { KEY_RULES, type SecretRule } from "@/components/onboarding/autosave-secret-field";
import { PoolKeysList } from "@/components/onboarding/pool-keys-list";
import { SecretInput } from "@/components/shared/secret-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type { IntegrationField } from "@/lib/integrations-catalog";
import { cn } from "@/lib/utils";

// The server returns "********" for secret values unless ?includeSecrets=true.
// We use this sentinel to decide when to show the masked read-only view vs a
// live editable input. Matches the mask used by `src/be/db.ts`.
const SECRET_MASK_SENTINEL = "********";

// Inline, non-blocking format warnings keyed by swarm_config key. Returning
// null means "no warning"; returning a string renders a muted hint beneath
// the input. Save is never gated on these.
const FORMAT_WARNINGS: Record<string, (v: string) => string | null> = {
  SLACK_BOT_TOKEN: (v) => (v && !v.startsWith("xoxb-") ? "Expected format: xoxb-..." : null),
  SLACK_APP_TOKEN: (v) => (v && !v.startsWith("xapp-") ? "Expected format: xapp-..." : null),
  GITHUB_APP_PRIVATE_KEY: (v) =>
    v && !v.includes("BEGIN RSA PRIVATE KEY") && !v.includes("BEGIN PRIVATE KEY")
      ? "Expected a PEM block containing 'BEGIN RSA PRIVATE KEY' or 'BEGIN PRIVATE KEY'."
      : null,
};

// Format rules of credential pool fields, checked before the add request.
// Other pools take any value of 16+ characters: an OpenRouter key can be a
// gateway key, and registry providers have no fixed prefix.
const POOL_RULES: Record<string, SecretRule> = {
  CLAUDE_CODE_OAUTH_TOKEN: KEY_RULES.claudeToken,
  ANTHROPIC_API_KEY: KEY_RULES.anthropicKey,
};

// An API older than `POOL_KEYS_MIN_VERSION` keeps the comma-separated field.
// A key never has a space or a line break inside. Each key of a credential
// pool is checked on its own: the server splits on commas and trims each key.
function poolSpaceWarning(v: string): string | null {
  const keys = v.split(",").map((s) => s.trim());
  return keys.some((key) => /\s/.test(key))
    ? "Remove the space or line break from the key. Separate keys with commas."
    : null;
}

interface FieldRendererProps {
  field: IntegrationField;
  existingConfig?: SwarmConfig;
  /** Whether the server currently has this key set in process.env (any source). */
  inEnv?: boolean;
  value: string;
  markedForReplace: boolean;
  onChange: (value: string) => void;
  onMarkForReplace: () => void;
  onUnmarkForReplace: () => void;
  /** If provided, shows a "Clear" affordance that deletes the DB row. */
  onClearExisting?: () => void;
}

export function FieldRenderer({
  field,
  existingConfig,
  inEnv = false,
  value,
  markedForReplace,
  onChange,
  onMarkForReplace,
  onUnmarkForReplace,
  onClearExisting,
}: FieldRendererProps) {
  const { copied, copy } = useCopyToClipboard();
  const poolSupport = usePoolKeysSupport();
  const poolList = field.credentialPool === true && poolSupport !== "legacy";
  const legacyPool = field.credentialPool === true && poolSupport === "legacy";
  const inputId = `field-${field.key}`;
  const handleCopyKey = () => copy(field.key);

  // Secrets (tokens, API keys, webhook secrets): show masked read-only + Replace
  // until the user opts in. Non-secret values (emails, channel names, flags)
  // are shown in plaintext and edited in place (they're not sensitive).
  const writeOnlyValuePresent = field.writeOnly === true && inEnv;
  const existingMasked =
    field.isSecret === true && (existingConfig !== undefined || writeOnlyValuePresent);
  const showMaskedReadOnly = existingMasked && !markedForReplace;

  const poolSize =
    legacyPool && value.includes(",")
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean).length
      : 0;

  // Skip warnings while showing the server-side mask sentinel: that value
  // isn't a real user input and would always fail prefix checks.
  const warningText =
    value && value !== SECRET_MASK_SENTINEL
      ? (FORMAT_WARNINGS[field.key]?.(value) ?? (legacyPool ? poolSpaceWarning(value) : null))
      : null;

  // Source chip: distinguishes "set via deployment env only" from "persisted in
  // swarm_config". When both are true the DB row was already loaded into env at
  // boot (or env set and DB row match). Either way it's live.
  const inDb = existingConfig !== undefined;
  const sourceChip: { label: string; className: string; title: string } | null =
    writeOnlyValuePresent
      ? {
          label: "api-managed",
          className: "bg-status-success/10 text-status-success-strong border-status-success/30",
          title: "Set on the API server. The value is write-only; use Replace to rotate it.",
        }
      : inDb
        ? inEnv
          ? {
              label: "db+env",
              className: "bg-status-success/10 text-status-success-strong border-status-success/30",
              title: "Set in DB and loaded into process.env. Live on the server.",
            }
          : {
              label: "db (pending reload)",
              className: "bg-status-active/10 text-status-active-strong border-status-active/30",
              title: "Saved to DB but not yet in process.env. Reload or restart the API to apply.",
            }
        : inEnv
          ? {
              label: "env (deploy)",
              className: "bg-status-info/10 text-status-info-strong border-status-info/30",
              title:
                "Set via deployment env (.env / docker). No DB row: save here to persist across DB reloads.",
            }
          : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="flex items-center gap-1">
          <span>{field.label}</span>
          {field.required && <span className="text-status-error-strong text-xs">*</span>}
        </Label>
        <code
          className="text-[10px] font-mono text-muted-foreground select-text"
          title={`Config key ${field.key}`}
        >
          {field.key}
        </code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-5 w-5"
          onClick={handleCopyKey}
          aria-label={`Copy key ${field.key}`}
          title={`Copy ${field.key}`}
        >
          {copied ? (
            <Check className="h-3 w-3 text-status-success-strong" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
        {sourceChip && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`ml-auto text-[9px] uppercase tracking-wide px-1.5 py-0 h-5 inline-flex items-center rounded-md border font-medium leading-none cursor-help ${sourceChip.className}`}
              >
                {sourceChip.label}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{sourceChip.title}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {poolList ? (
        // A pool adds and removes one key at a time, on its own routes: it is
        // not part of the page Save, and it has no Clear.
        poolSupport === "supported" ? (
          <PoolKeysList
            envVar={field.key}
            inputId={inputId}
            label={field.label}
            rule={POOL_RULES[field.key]}
            placeholder={field.placeholder}
            describedBy={`${inputId}-help`}
          />
        ) : (
          <Skeleton className="h-9 w-full" />
        )
      ) : showMaskedReadOnly ? (
        <div className="flex gap-2 items-center">
          <Input
            id={inputId}
            readOnly
            value="••••••"
            className="font-mono bg-muted/40"
            aria-describedby={field.helpText ? `${inputId}-help` : undefined}
          />
          <Button type="button" size="sm" variant="outline" onClick={onMarkForReplace}>
            Replace
          </Button>
          {existingConfig && onClearExisting && (
            <Button type="button" size="sm" variant="destructive-outline" onClick={onClearExisting}>
              Clear
            </Button>
          )}
        </div>
      ) : (
        <>
          {renderInput({ field, inputId, value, onChange })}
          <div className="flex items-center gap-3">
            {markedForReplace && existingMasked && (
              <button
                type="button"
                onClick={onUnmarkForReplace}
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                Keep existing value
              </button>
            )}
            {!field.isSecret && existingConfig && onClearExisting && (
              <button
                type="button"
                onClick={onClearExisting}
                className="text-xs text-status-error-strong/80 underline hover:text-status-error-strong"
              >
                Clear value
              </button>
            )}
          </div>
        </>
      )}

      {poolSize > 1 && (
        <div className="text-[10px] text-muted-foreground">
          <span className="inline-flex items-center rounded-md bg-muted/60 px-1.5 py-0.5 font-medium">
            {poolSize} keys in pool
          </span>
        </div>
      )}

      {warningText && <p className="text-xs text-status-active-strong/90">{warningText}</p>}

      {(field.helpText || field.credentialPool) && (
        <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
          {[
            field.helpText,
            field.credentialPool
              ? legacyPool
                ? "Separate them with commas."
                : "Add one at a time."
              : null,
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
    </div>
  );
}

function renderInput({
  field,
  inputId,
  value,
  onChange,
}: {
  field: IntegrationField;
  inputId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          id={inputId}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn("font-mono text-xs min-h-[120px]")}
          aria-describedby={field.helpText ? `${inputId}-help` : undefined}
        />
      );
    case "select":
      return (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={inputId}>
            <SelectValue placeholder={field.placeholder ?? "Select..."} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "boolean":
      return (
        <div className="flex items-center gap-2">
          <Switch
            id={inputId}
            checked={value === "true"}
            onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
          />
          <Label htmlFor={inputId} className="text-xs text-muted-foreground">
            {value === "true" ? "Enabled" : "Disabled"}
          </Label>
        </div>
      );
    case "password":
      return (
        <SecretInput
          id={inputId}
          placeholder={field.placeholder}
          value={value}
          onChange={onChange}
          autoComplete="new-password"
          describedBy={field.helpText ? `${inputId}-help` : undefined}
        />
      );
    default:
      return (
        <Input
          id={inputId}
          type="text"
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={field.helpText ? `${inputId}-help` : undefined}
        />
      );
  }
}
