import type { ReactNode } from "react";
import { SecretField } from "@/components/onboarding/secret-field";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { cn } from "@/lib/utils";
import type { SetupFieldSpec } from "./catalog";
import type { ConfigForm } from "./use-config-form";

/** Human label plus the config key in mono, so operators can match the docs. */
export function fieldLabel(spec: Pick<SetupFieldSpec, "key" | "label">): ReactNode {
  return (
    <>
      <span>{spec.label}</span>
      <code className="font-mono text-[10px] font-normal text-muted-foreground">{spec.key}</code>
    </>
  );
}

/** One config key: catalog label + env key. Secrets use the shared write-only field. */
export function SetupField({ spec, form }: { spec: SetupFieldSpec; form: ConfigForm }) {
  const id = `setup-${spec.key}`;
  const placeholder =
    form.isEnvOnly(spec.key) && !spec.secret ? "Set on the server" : spec.placeholder;

  return (
    <SettingsRow
      htmlFor={id}
      required={spec.required}
      className={cn(spec.multiline && "sm:col-span-2")}
      label={fieldLabel(spec)}
      helper={spec.hint}
    >
      {spec.secret ? (
        <SecretField
          key={form.version}
          id={id}
          saved={form.isSaved(spec.key)}
          multiline={spec.multiline}
          value={form.value(spec.key)}
          onChange={(v) => form.setValue(spec.key, v)}
          placeholder={placeholder}
        />
      ) : (
        <Input
          id={id}
          value={form.value(spec.key)}
          onChange={(e) => form.setValue(spec.key, e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="font-mono"
        />
      )}
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
