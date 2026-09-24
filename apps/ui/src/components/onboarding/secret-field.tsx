import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface SecretInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Id of the helper line under the field. */
  describedBy?: string;
}

/** Password input with an eye toggle inside the field. */
export function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  describedBy,
}: SecretInputProps) {
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
        aria-describedby={describedBy}
        className="pr-10 font-mono"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setShown((s) => !s)}
        disabled={disabled}
        aria-label={shown ? "Hide value" : "Show value"}
        className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
      >
        {shown ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

/**
 * Write-only secret field for `/setup`. A saved secret shows as masked dots
 * with a Replace action, and its value never comes back from the API. While
 * replacing, "Keep saved value" returns to the saved view. Key it on
 * `useSetupSave().version` so a save returns it to the saved view.
 */
export function SecretField({
  saved,
  multiline,
  ...input
}: SecretInputProps & {
  /** The server has a value for this key. */
  saved: boolean;
  /** Textarea for multi-line secrets (PEM keys). No eye toggle. */
  multiline?: boolean;
}) {
  const [replacing, setReplacing] = useState(false);

  if (saved && !replacing) {
    return (
      <div className="flex items-center gap-2">
        <Input
          id={input.id}
          readOnly
          value="••••••••••••"
          aria-describedby={input.describedBy}
          className="bg-muted/40 font-mono text-muted-foreground"
        />
        <Button type="button" variant="outline" onClick={() => setReplacing(true)}>
          Replace
        </Button>
      </div>
    );
  }

  const field = multiline ? (
    <Textarea
      id={input.id}
      value={input.value}
      onChange={(e) => input.onChange(e.target.value)}
      placeholder={input.placeholder}
      disabled={input.disabled}
      spellCheck={false}
      aria-describedby={input.describedBy}
      className="min-h-24 font-mono text-xs"
    />
  ) : (
    <SecretInput {...input} />
  );
  if (!saved) return field;
  return (
    <div className="space-y-1">
      {field}
      <Button
        type="button"
        variant="link"
        size="xs"
        onClick={() => {
          setReplacing(false);
          input.onChange("");
        }}
        className="h-auto px-0 text-muted-foreground hover:text-foreground"
      >
        Keep saved value
      </Button>
    </div>
  );
}
