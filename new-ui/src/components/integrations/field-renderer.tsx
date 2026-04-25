import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { SwarmConfig } from "@/api/types";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  const [copied, setCopied] = useState(false);
  const inputId = `field-${field.key}`;

  async function handleCopyKey() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(field.key);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — degrade silently.
    }
  }

  // Secrets (tokens, API keys, webhook secrets): show masked read-only + Replace
  // until the user opts in. Non-secret values (emails, channel names, flags)
  // are shown in plaintext and edited in place — they're not sensitive.
  const existingMasked = field.isSecret === true && existingConfig !== undefined;
  const showMaskedReadOnly = existingMasked && !markedForReplace;

  const poolSize =
    field.credentialPool && value.includes(",")
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean).length
      : 0;

  // Skip warnings while showing the server-side mask sentinel — that value
  // isn't a real user input and would always fail prefix checks.
  const warningText =
    value && value !== SECRET_MASK_SENTINEL ? (FORMAT_WARNINGS[field.key]?.(value) ?? null) : null;

  // Source chip: distinguishes "set via deployment env only" from "persisted in
  // swarm_config". When both are true the DB row was already loaded into env at
  // boot (or env set and DB row match) — either way it's live.
  const inDb = existingConfig !== undefined;
  const sourceChip: { label: string; className: string; title: string } | null = inDb
    ? inEnv
      ? {
          label: "db+env",
          className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
          title: "Set in DB and loaded into process.env. Live on the server.",
        }
      : {
          label: "db (pending reload)",
          className: "bg-amber-500/10 text-amber-400 border-amber-500/30",
          title: "Saved to DB but not yet in process.env — reload or restart the API to apply.",
        }
    : inEnv
      ? {
          label: "env (deploy)",
          className: "bg-sky-500/10 text-sky-400 border-sky-500/30",
          title:
            "Set via deployment env (.env / docker). No DB row — save here to persist across DB reloads.",
        }
      : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="flex items-center gap-1">
          <span>{field.label}</span>
          {field.required && <span className="text-red-400 text-xs">*</span>}
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
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
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

      {showMaskedReadOnly ? (
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
            <Button
              type="button"
              size="sm"
              variant="destructive-outline"
              onClick={onClearExisting}
              className="hover:text-red-300"
            >
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
                Cancel — keep existing value
              </button>
            )}
            {!field.isSecret && existingConfig && onClearExisting && (
              <button
                type="button"
                onClick={onClearExisting}
                className="text-xs text-red-400/80 underline hover:text-red-300"
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

      {warningText && <p className="text-xs text-amber-500/90">{warningText}</p>}

      {field.helpText && (
        <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
          {field.helpText}
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
        <Input
          id={inputId}
          type="password"
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          aria-describedby={field.helpText ? `${inputId}-help` : undefined}
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
