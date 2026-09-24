import { Eye, EyeOff } from "lucide-react";
import { type ClipboardEvent, type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SaveIndicator, WithIndicator } from "./save-indicator";
import { useAutosave } from "./use-autosave";

interface SecretInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Id of the helper line under the field. */
  describedBy?: string;
  invalid?: boolean;
  onBlur?: () => void;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  /** Status icon inside the field, left of the eye toggle. */
  indicator?: ReactNode;
}

/** Password input with an eye toggle inside the field. */
export function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  describedBy,
  invalid,
  onBlur,
  onPaste,
  indicator,
}: SecretInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onPaste={onPaste}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className={cn("font-mono", indicator ? "pr-16" : "pr-10")}
      />
      <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1.5">
        {indicator}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
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

/**
 * How a secret proves it is complete before it autosaves. A half-typed key
 * must never be stored.
 *
 * - With `prefixes`: a value with a known prefix and at least `minLength`
 *   characters saves while typing. `strict` rejects any other prefix.
 *   Without `strict`, another prefix saves on blur or paste only.
 * - With `pattern`: the full value must match (PEM keys).
 * - Neither: the format is unknown, so the value saves on blur or paste only.
 */
export interface SecretRule {
  prefixes?: readonly string[];
  strict?: boolean;
  pattern?: RegExp;
  minLength?: number;
  /** Shown when the value cannot be right, e.g. "Starts with xoxb-". */
  hint?: string;
}

export interface SecretCheck {
  /** Complete: store after the debounce. */
  ready: boolean;
  /** Store on blur or paste. */
  readyOnCommit: boolean;
  /** Why the value cannot be stored. */
  problem: string | null;
  /** The problem is certain while typing (wrong prefix). Otherwise it shows after blur. */
  problemNow: boolean;
}

export function checkSecret(raw: string, rule: SecretRule = {}): SecretCheck {
  const value = raw.trim();
  if (!value) return { ready: false, readyOnCommit: false, problem: null, problemNow: false };
  if (rule.pattern) {
    const ok = rule.pattern.test(value);
    return {
      ready: ok,
      readyOnCommit: ok,
      problem: ok ? null : (rule.hint ?? null),
      problemNow: false,
    };
  }
  if (rule.prefixes?.length) {
    const minLength = rule.minLength ?? 20;
    const known = rule.prefixes.some((p) => value.startsWith(p));
    if (known) {
      const long = value.length >= minLength;
      return {
        ready: long,
        readyOnCommit: long,
        problem: long ? null : "Looks too short.",
        problemNow: false,
      };
    }
    if (!rule.strict)
      return { ready: false, readyOnCommit: true, problem: null, problemNow: false };
    // Report a wrong prefix only once the value is longer than every prefix.
    const longest = Math.max(...rule.prefixes.map((p) => p.length));
    const problem =
      value.length >= longest ? (rule.hint ?? `Starts with ${rule.prefixes.join(" or ")}`) : null;
    return { ready: false, readyOnCommit: false, problem, problemNow: true };
  }
  return {
    ready: false,
    readyOnCommit: value.length >= (rule.minLength ?? 1),
    problem: null,
    problemNow: false,
  };
}

/**
 * A paste is a whole value, so it saves without the debounce. `onPaste` fires
 * before the field changes, so the commit rides the change that follows.
 */
export function usePasteCommit(commit: () => void) {
  const pasted = useRef(false);
  return {
    onPaste: () => {
      pasted.current = true;
    },
    afterChange: () => {
      if (!pasted.current) return;
      pasted.current = false;
      commit();
    },
  };
}

interface SecretFieldProps {
  id: string;
  /** The server has a value for this key. */
  saved: boolean;
  /** Store the value (write-only). Throw to show the error state. */
  onSave: (value: string) => Promise<void>;
  rule?: SecretRule;
  placeholder?: string;
  disabled?: boolean;
  /** Id of the helper line under the field. */
  describedBy?: string;
  /** Textarea for multi-line secrets (PEM keys). No eye toggle. */
  multiline?: boolean;
}

/**
 * Write-only secret field for `/setup` that saves itself. A saved secret shows
 * as masked dots with a Replace action, and its value never comes back from
 * the API. A new value stores once it passes `rule` (after a short debounce),
 * or on blur or paste when its format is unknown. Then the field returns to
 * the masked view.
 */
export function SecretField({
  id,
  saved,
  onSave,
  rule,
  placeholder,
  disabled,
  describedBy,
  multiline,
}: SecretFieldProps) {
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [blurred, setBlurred] = useState(false);
  const value = draft.trim();
  const check = checkSecret(value, rule);

  const autosave = useAutosave({
    value,
    dirty: value.length > 0,
    ready: check.ready,
    readyOnCommit: check.readyOnCommit,
    save: async (next) => {
      await onSave(next);
      setDraft("");
      setReplacing(false);
      setBlurred(false);
    },
  });
  // A paste is a whole value: store it without waiting for the debounce.
  const paste = usePasteCommit(autosave.commit);
  const onChange = (next: string) => {
    setDraft(next);
    paste.afterChange();
  };
  const onBlur = () => {
    setBlurred(true);
    autosave.commit();
  };

  // A wrong prefix shows at once. Anything else waits for blur.
  const problem = check.problem && (blurred || check.problemNow) ? check.problem : null;
  const indicator = <SaveIndicator phase={autosave.phase} error={autosave.error} />;
  const problemId = `${id}-problem`;
  const described =
    [problem ? problemId : null, describedBy].filter(Boolean).join(" ") || undefined;

  if (saved && !replacing && !draft) {
    return (
      <div className="flex items-center gap-2">
        <WithIndicator indicator={indicator} className="min-w-0 flex-1">
          <Input
            id={id}
            readOnly
            value="••••••••••••"
            aria-describedby={describedBy}
            className="bg-muted/40 pr-8 font-mono text-muted-foreground"
          />
        </WithIndicator>
        <Button type="button" variant="outline" onClick={() => setReplacing(true)}>
          Replace
        </Button>
      </div>
    );
  }

  const field = multiline ? (
    <WithIndicator indicator={indicator} multiline>
      <Textarea
        id={id}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onPaste={paste.onPaste}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        aria-describedby={described}
        aria-invalid={problem ? true : undefined}
        className="min-h-24 pr-8 font-mono text-xs"
      />
    </WithIndicator>
  ) : (
    <SecretInput
      id={id}
      value={draft}
      onChange={onChange}
      onBlur={onBlur}
      onPaste={paste.onPaste}
      placeholder={placeholder}
      disabled={disabled}
      describedBy={described}
      invalid={Boolean(problem)}
      indicator={indicator}
    />
  );

  return (
    <div className="space-y-1">
      {field}
      {problem ? (
        <p id={problemId} className="text-xs text-status-error-strong">
          {problem}
        </p>
      ) : null}
      {saved ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={() => {
            setReplacing(false);
            setDraft("");
            setBlurred(false);
          }}
          className="h-auto px-0 text-muted-foreground hover:text-foreground"
        >
          Keep saved value
        </Button>
      ) : null}
    </div>
  );
}
