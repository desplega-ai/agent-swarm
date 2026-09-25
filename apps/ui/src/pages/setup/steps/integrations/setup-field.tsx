import { type ReactNode, useState } from "react";
import { AutosaveSecretField } from "@/components/onboarding/autosave-secret-field";
import { SaveIndicator, WithIndicator } from "@/components/onboarding/save-indicator";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { useAutosave } from "@/hooks/use-autosave";
import { cn } from "@/lib/utils";
import type { SetupFieldSpec } from "./catalog";
import type { ConfigForm } from "./use-config-form";

/** Human label, the config key in mono (to match the docs), and the hint as a tooltip. */
export function fieldLabel(spec: Pick<SetupFieldSpec, "key" | "label" | "hint">): ReactNode {
  return (
    <>
      <span>{spec.label}</span>
      <code className="font-mono text-[10px] font-normal text-muted-foreground">{spec.key}</code>
      {spec.hint ? <InfoTip content={spec.hint} /> : null}
    </>
  );
}

/**
 * One config key that saves itself. Secrets use the shared write-only field
 * and store once complete (see `SecretRule`). Other values store about
 * 800 ms after typing stops, or on blur, once they validate.
 */
export function SetupField({ spec, form }: { spec: SetupFieldSpec; form: ConfigForm }) {
  const id = `setup-${spec.key}`;
  if (!spec.secret) return <TextSetupField id={id} spec={spec} form={form} />;
  return (
    <SettingsRow
      htmlFor={id}
      required={spec.required}
      className={cn(spec.multiline && "sm:col-span-2")}
      label={fieldLabel(spec)}
    >
      <AutosaveSecretField
        id={id}
        saved={form.isSaved(spec.key)}
        multiline={spec.multiline}
        rule={spec.secretRule}
        placeholder={spec.placeholder}
        onSave={(value) => form.saveField(spec, value)}
      />
    </SettingsRow>
  );
}

function TextSetupField({
  id,
  spec,
  form,
}: {
  id: string;
  spec: SetupFieldSpec;
  form: ConfigForm;
}) {
  // `null` = untouched: follow the stored value.
  const [draft, setDraft] = useState<string | null>(null);
  const baseline = form.baseline(spec);
  const value = (draft ?? baseline).trim();
  const error = value ? (spec.validate?.(value) ?? null) : null;
  const autosave = useAutosave({
    value,
    dirty: draft !== null && value !== baseline.trim(),
    // Blank clears an optional value. A required one never saves blank.
    ready: !error && (!spec.required || value.length > 0),
    save: (next) => form.saveField(spec, next),
  });
  const placeholder = form.isEnvOnly(spec.key) ? "Set on the server" : spec.placeholder;

  return (
    <SettingsRow
      htmlFor={id}
      required={spec.required}
      label={fieldLabel(spec)}
      helper={error ? <span className="text-status-error-strong">{error}</span> : undefined}
    >
      <WithIndicator indicator={<SaveIndicator phase={autosave.phase} error={autosave.error} />}>
        <Input
          id={id}
          value={draft ?? baseline}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={autosave.commit}
          placeholder={placeholder}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          className="pr-8 font-mono"
        />
      </WithIndicator>
    </SettingsRow>
  );
}

/** Two-column grid of fields (one column under 640px). */
export function FieldGrid({ specs, form }: { specs: SetupFieldSpec[]; form: ConfigForm }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {specs.map((spec) => (
        <SetupField key={spec.key} spec={spec} form={form} />
      ))}
    </div>
  );
}
