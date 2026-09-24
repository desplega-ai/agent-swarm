import { Check, Copy, Loader2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { SecretField } from "@/components/onboarding/secret-field";
import { SetupChip } from "@/components/onboarding/setup-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

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

/** Env key label, the control, then a helper or error line: every step 3 field. */
function KeyField({
  id,
  envKey,
  logo,
  saved,
  helper,
  error,
  children,
}: {
  id: string;
  envKey: string;
  logo?: ReactNode;
  saved?: boolean;
  helper?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  const helpId = `${id}-help`;
  return (
    <div className="space-y-1.5">
      <FieldLabel
        htmlFor={id}
        envKey={envKey}
        logo={logo}
        trailing={saved ? <SetupChip tone="success">Saved</SetupChip> : null}
      />
      {children}
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

/** A step 3 secret: the shared write-only `SecretField` under its env key. */
export function SecretKeyField({
  envKey,
  logo,
  helper,
  ...field
}: ComponentProps<typeof SecretField> & {
  envKey: string;
  logo?: ReactNode;
  helper?: ReactNode;
}) {
  return (
    <KeyField id={field.id} envKey={envKey} logo={logo} saved={field.saved} helper={helper}>
      <SecretField {...field} describedBy={helper ? `${field.id}-help` : undefined} />
    </KeyField>
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
  return (
    <KeyField id={id} envKey={envKey} helper={helper} error={error}>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={helper || error ? `${id}-help` : undefined}
        className="font-mono"
      />
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
