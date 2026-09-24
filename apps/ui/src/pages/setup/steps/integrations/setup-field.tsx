import { Eye, EyeOff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { Textarea } from "@/components/ui/textarea";
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

/** Password input with an eye toggle inside the field. */
export function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className="pr-9 font-mono"
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        disabled={disabled}
        aria-label={shown ? "Hide value" : "Show value"}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/** One config key: catalog label + env key, and the saved-secret Replace flow. */
export function SetupField({ spec, form }: { spec: SetupFieldSpec; form: ConfigForm }) {
  const id = `setup-${spec.key}`;
  const replacing = form.isReplacing(spec.key);
  const showSaved = spec.secret && form.isSaved(spec.key) && !replacing;
  const placeholder =
    form.isEnvOnly(spec.key) && !spec.secret ? "Set on the server" : spec.placeholder;

  let control: ReactNode;
  if (showSaved) {
    control = (
      <div className="flex items-center gap-2">
        <Input id={id} readOnly value="••••••••" className="bg-muted/40 font-mono" />
        <Button type="button" variant="outline" onClick={() => form.setReplacing(spec.key, true)}>
          Replace
        </Button>
      </div>
    );
  } else if (spec.multiline) {
    control = (
      <Textarea
        id={id}
        value={form.value(spec.key)}
        onChange={(e) => form.setValue(spec.key, e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="min-h-24 font-mono text-xs"
      />
    );
  } else if (spec.secret) {
    control = (
      <SecretInput
        id={id}
        value={form.value(spec.key)}
        onChange={(v) => form.setValue(spec.key, v)}
        placeholder={placeholder}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        value={form.value(spec.key)}
        onChange={(e) => form.setValue(spec.key, e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="font-mono"
      />
    );
  }

  const helper =
    spec.hint || replacing ? (
      <>
        {spec.hint}
        {replacing ? (
          <button
            type="button"
            onClick={() => form.setReplacing(spec.key, false)}
            className={cn(
              "text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
              spec.hint && "ml-2",
            )}
          >
            Keep saved value
          </button>
        ) : null}
      </>
    ) : undefined;

  return (
    <SettingsRow
      htmlFor={id}
      required={spec.required}
      className={cn(spec.multiline && "sm:col-span-2")}
      label={fieldLabel(spec)}
      helper={helper}
    >
      {control}
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
