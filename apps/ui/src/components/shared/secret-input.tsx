import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Every `Input` prop passes through to the `<input>` (`id`, `ref`, `name`,
 * `required`, `placeholder`, `disabled`, `aria-*`, focus and paste handlers),
 * except the ones this component owns: `type` (the eye toggle), `value` (a
 * string), `onChange` (takes the new value), and `className`.
 */
interface SecretInputProps
  extends Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange" | "className"> {
  value: string;
  onChange: (value: string) => void;
  /** Id of the helper line under the field. Wins over `aria-describedby`. */
  describedBy?: string;
  invalid?: boolean;
  /** Status icon inside the field, left of the eye toggle. */
  indicator?: ReactNode;
}

/**
 * Password input with an eye toggle inside the field. `autoComplete` defaults
 * to `"off"`. Pass `"new-password"` on forms that store a credential, so the
 * browser does not fill a saved login.
 */
export function SecretInput({
  value,
  onChange,
  disabled,
  describedBy,
  invalid,
  indicator,
  autoComplete = "off",
  ...inputProps
}: SecretInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        spellCheck={false}
        {...inputProps}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete={autoComplete}
        aria-describedby={describedBy ?? inputProps["aria-describedby"]}
        aria-invalid={invalid || inputProps["aria-invalid"] || undefined}
        className={cn("font-mono", indicator ? "pr-16" : "pr-10")}
      />
      <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1.5">
        {indicator}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          // A pointer click keeps focus in the field: peeking is not a blur (no save).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShown((s) => !s)}
          disabled={disabled}
          aria-label={shown ? "Hide value" : "Show value"}
          className="text-muted-foreground"
        >
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      </span>
    </div>
  );
}
