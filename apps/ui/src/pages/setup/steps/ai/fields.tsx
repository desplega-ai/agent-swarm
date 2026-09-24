import { Check, Copy, Eye, EyeOff, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type UpsertConfigEntry, useUpsertConfigsBatch } from "@/api/hooks/use-config-api";
import type { EnvPresenceMap } from "@/api/hooks/use-integrations-meta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { SetupChip } from "../../components/setup-card";

/** Env key label in machine voice, with an optional brand mark and a trailing slot. */
function FieldLabel({
  htmlFor,
  envKey,
  logo,
  trailing,
}: {
  htmlFor: string;
  envKey: string;
  logo?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={htmlFor} className="gap-1.5 font-mono text-[11px] text-muted-foreground">
        {logo}
        {envKey}
      </Label>
      {trailing ? <span className="ml-auto">{trailing}</span> : null}
    </div>
  );
}

function Helper({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Write-only secret input. A saved key renders as "Saved" + masked dots with a
 * Replace action. The value is never read back from the API.
 */
export function SecretField({
  id,
  envKey,
  placeholder,
  saved,
  value,
  onChange,
  helper,
  logo,
}: {
  id: string;
  envKey: string;
  placeholder: string;
  saved: boolean;
  value: string;
  onChange: (value: string) => void;
  helper?: ReactNode;
  logo?: ReactNode;
}) {
  const [replacing, setReplacing] = useState(false);
  const [shown, setShown] = useState(false);
  const helpId = `${id}-help`;

  if (saved && !replacing) {
    return (
      <div className="space-y-1.5">
        <FieldLabel
          htmlFor={id}
          envKey={envKey}
          logo={logo}
          trailing={<SetupChip tone="success">Saved</SetupChip>}
        />
        <div className="flex items-center gap-2">
          <Input
            id={id}
            readOnly
            value="••••••••••••"
            aria-label={`${envKey} is saved`}
            className="bg-muted/40 font-mono text-muted-foreground"
          />
          <Button type="button" variant="outline" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        </div>
        <Helper id={helpId}>{helper}</Helper>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <FieldLabel
        htmlFor={id}
        envKey={envKey}
        logo={logo}
        trailing={
          saved ? (
            <button
              type="button"
              onClick={() => {
                setReplacing(false);
                onChange("");
              }}
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Keep the saved key
            </button>
          ) : null
        }
      />
      <div className="relative">
        <Input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={helper ? helpId : undefined}
          className="pr-10 font-mono"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? "Hide value" : "Show value"}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
        >
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      </div>
      <Helper id={helpId}>{helper}</Helper>
    </div>
  );
}

/** Plain (non-secret) config field, for URLs and ids. */
export function TextField({
  id,
  envKey,
  placeholder,
  value,
  onChange,
  helper,
  error,
}: {
  id: string;
  envKey: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  helper?: ReactNode;
  error?: string | null;
}) {
  const helpId = `${id}-help`;
  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={id} envKey={envKey} />
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={helper || error ? helpId : undefined}
        className="font-mono"
      />
      {error ? (
        <p id={helpId} className="text-xs text-status-error-strong">
          {error}
        </p>
      ) : (
        <Helper id={helpId}>{helper}</Helper>
      )}
    </div>
  );
}

export function CopyIconButton({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      onClick={() => void copy(value)}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <Check className="text-status-success-strong" /> : <Copy />}
    </Button>
  );
}

export function SaveButton({
  saving,
  disabled,
  onClick,
}: {
  saving: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button type="button" onClick={onClick} disabled={disabled || saving}>
      {saving ? <Loader2 className="animate-spin" /> : null}
      {saving ? "Saving" : "Save and verify"}
    </Button>
  );
}

/**
 * Save global config rows for one card. Tracks keys saved in this session so
 * the card flips to its waiting state before the API env reload lands, and
 * bumps `version` so secret fields reset to their saved view.
 */
export function useSaveKeys(presence: EnvPresenceMap) {
  const batch = useUpsertConfigsBatch();
  const [savedNow, setSavedNow] = useState<ReadonlySet<string>>(() => new Set());
  const [version, setVersion] = useState(0);

  async function save(entries: UpsertConfigEntry[]): Promise<boolean> {
    const result = await batch.mutateAsync(entries).catch(() => null);
    if (!result) return false;
    const failed = new Set(result.errors.map((e) => e.key));
    const written = entries.filter((e) => e.value !== "" && !failed.has(e.key));
    setSavedNow((prev) => new Set([...prev, ...written.map((e) => e.key)]));
    if (result.failureCount > 0) return false;
    setVersion((v) => v + 1);
    return true;
  }

  return {
    isSaved: (key: string) => Boolean(presence[key]) || savedNow.has(key),
    save,
    saving: batch.isPending,
    version,
  };
}
