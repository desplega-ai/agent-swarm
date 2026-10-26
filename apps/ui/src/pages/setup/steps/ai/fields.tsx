import { Check, Copy } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { usePoolKeysSupport } from "@/api/hooks/use-pool-keys-support";
import { AutosaveSecretField } from "@/components/onboarding/autosave-secret-field";
import { PoolKeysList, type PoolKeysListProps } from "@/components/onboarding/pool-keys-list";
import { SaveIndicator, WithIndicator } from "@/components/onboarding/save-indicator";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAutosave } from "@/hooks/use-autosave";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/** Title classes of a step 3 disclosure (`CollapsibleSection`): sentence case, not small caps. */
export const DISCLOSURE_TITLE = "text-xs font-medium normal-case tracking-normal";

/** Shown under a field that takes a credential pool (`CREDENTIAL_POOL_VARS` on the API). */
const POOL_HINT = "You can add more than one: separate them with commas.";

/** Shown under a `PoolKeyField`: the list adds one key at a time. */
export const POOL_LIST_HINT = "Add one key at a time. Agents rotate across the keys.";

/** A human label with an optional brand mark. The info tip names the env key. */
function FieldLabel({
  htmlFor,
  label,
  envKey,
  logo,
  info,
}: {
  htmlFor: string;
  label: string;
  envKey: string;
  logo?: ReactNode;
  info?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor} className="gap-1.5 text-xs">
        {logo}
        {label}
      </Label>
      <InfoTip
        content={
          <span className="flex flex-col gap-1">
            {info ? <span>{info}</span> : null}
            <span>
              Saved as <code className="font-mono">{envKey}</code>.
            </span>
          </span>
        }
      />
    </div>
  );
}

/** Label, the control, then a short helper or error line: every step 3 field. */
function KeyField({
  id,
  label,
  envKey,
  logo,
  info,
  helper,
  error,
  children,
}: {
  id: string;
  label: string;
  envKey: string;
  logo?: ReactNode;
  info?: ReactNode;
  helper?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={id} label={label} envKey={envKey} logo={logo} info={info} />
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

/**
 * A step 3 secret: the autosaving `AutosaveSecretField` under its label.
 * `pool` fields take comma-separated keys and say so under the field, unless
 * `poolHint` is off because one line above a group of fields says it.
 */
export function SecretKeyField({
  label,
  envKey,
  logo,
  info,
  helper,
  poolHint = true,
  ...field
}: ComponentProps<typeof AutosaveSecretField> & {
  label: string;
  envKey: string;
  logo?: ReactNode;
  info?: ReactNode;
  helper?: ReactNode;
  poolHint?: boolean;
}) {
  const hint = field.pool && poolHint;
  const help =
    helper && hint ? (
      <>
        {helper} {POOL_HINT}
      </>
    ) : hint ? (
      POOL_HINT
    ) : (
      helper
    );
  return (
    <KeyField id={field.id} label={label} envKey={envKey} logo={logo} info={info} helper={help}>
      <AutosaveSecretField {...field} describedBy={help ? `${field.id}-help` : undefined} />
    </KeyField>
  );
}

/**
 * A step 3 credential pool: the saved keys and an add field (`PoolKeysList`)
 * under its label. The label focuses the add field. `poolHint` is off when
 * one line above a group of fields says it. An API older than
 * `POOL_KEYS_MIN_VERSION` gets the comma-separated `SecretKeyField` instead.
 */
export function PoolKeyField({
  label,
  envKey,
  logo,
  info,
  helper,
  poolHint = true,
  legacy,
  ...list
}: Omit<PoolKeysListProps, "envVar" | "label" | "describedBy"> & {
  label: string;
  envKey: string;
  logo?: ReactNode;
  info?: ReactNode;
  helper?: ReactNode;
  poolHint?: boolean;
  /** The comma-separated field for an older API: its saved state and its save. */
  legacy: { saved: boolean; onSave: (value: string) => Promise<void> };
}) {
  const support = usePoolKeysSupport();
  if (support === "legacy") {
    return (
      <SecretKeyField
        id={list.inputId}
        label={label}
        envKey={envKey}
        logo={logo}
        info={info}
        helper={helper}
        poolHint={poolHint}
        placeholder={list.placeholder}
        rule={list.rule}
        pool
        saved={legacy.saved}
        onSave={legacy.onSave}
      />
    );
  }
  if (support === "pending") {
    return (
      <KeyField id={list.inputId} label={label} envKey={envKey} logo={logo} info={info}>
        <Skeleton className="h-9 w-full" />
      </KeyField>
    );
  }
  const help =
    helper && poolHint ? (
      <>
        {helper} {POOL_LIST_HINT}
      </>
    ) : poolHint ? (
      POOL_LIST_HINT
    ) : (
      helper
    );
  return (
    <KeyField id={list.inputId} label={label} envKey={envKey} logo={logo} info={info} helper={help}>
      <PoolKeysList
        {...list}
        envVar={envKey}
        label={label}
        describedBy={help ? `${list.inputId}-help` : undefined}
      />
    </KeyField>
  );
}

/**
 * Plain (non-secret) config field for URLs and ids. Saves itself about
 * 800 ms after typing stops, or on blur, once `validate` passes.
 */
export function TextField({
  id,
  label,
  envKey,
  placeholder,
  baseline,
  validate,
  info,
  onSave,
}: {
  id: string;
  label: string;
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
    <KeyField id={id} label={label} envKey={envKey} info={info} error={error}>
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
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
