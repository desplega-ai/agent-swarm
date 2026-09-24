import { Check, Copy } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { SaveIndicator, WithIndicator } from "@/components/onboarding/save-indicator";
import { SecretField } from "@/components/onboarding/secret-field";
import { useAutosave } from "@/components/onboarding/use-autosave";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/** Env key label in machine voice, with an optional brand mark and info tip. */
function FieldLabel({
  htmlFor,
  envKey,
  logo,
  info,
}: {
  htmlFor: string;
  envKey: string;
  logo?: ReactNode;
  info?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor} className="gap-1.5 font-mono text-[11px] text-muted-foreground">
        {logo}
        {envKey}
      </Label>
      {info ? <InfoTip content={info} /> : null}
    </div>
  );
}

/** Env key label, the control, then a short helper or error line: every step 3 field. */
function KeyField({
  id,
  envKey,
  logo,
  info,
  helper,
  error,
  children,
}: {
  id: string;
  envKey: string;
  logo?: ReactNode;
  info?: ReactNode;
  helper?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={id} envKey={envKey} logo={logo} info={info} />
      {children}
      {error ? (
        <p id={`${id}-help`} className="text-xs text-status-error-strong">
          {error}
        </p>
      ) : helper ? (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

/** A step 3 secret: the shared autosaving `SecretField` under its env key. */
export function SecretKeyField({
  envKey,
  logo,
  info,
  helper,
  ...field
}: ComponentProps<typeof SecretField> & {
  envKey: string;
  logo?: ReactNode;
  info?: ReactNode;
  helper?: ReactNode;
}) {
  return (
    <KeyField id={field.id} envKey={envKey} logo={logo} info={info} helper={helper}>
      <SecretField {...field} describedBy={helper ? `${field.id}-help` : undefined} />
    </KeyField>
  );
}

/**
 * Plain (non-secret) config field for URLs and ids. Saves itself about
 * 800 ms after typing stops, or on blur, once `validate` passes.
 */
export function TextField({
  id,
  envKey,
  placeholder,
  baseline,
  validate,
  info,
  onSave,
}: {
  id: string;
  envKey: string;
  placeholder: string;
  /** The stored value, shown until the operator types. */
  baseline?: string;
  /** An error message, or null when the value can be stored. */
  validate?: (value: string) => string | null;
  info?: ReactNode;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = (draft ?? baseline ?? "").trim();
  const error = value ? (validate?.(value) ?? null) : null;
  const autosave = useAutosave({
    value,
    dirty: draft !== null && value !== (baseline ?? ""),
    // Blank never saves: it would clear a stored value by accident.
    ready: value.length > 0 && !error,
    save: onSave,
  });
  return (
    <KeyField id={id} envKey={envKey} info={info} error={error}>
      <WithIndicator indicator={<SaveIndicator phase={autosave.phase} error={autosave.error} />}>
        <Input
          id={id}
          value={draft ?? baseline ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={autosave.commit}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-help` : undefined}
          className="pr-8 font-mono"
        />
      </WithIndicator>
    </KeyField>
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
