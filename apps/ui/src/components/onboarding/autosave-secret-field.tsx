import { type FocusEvent, useLayoutEffect, useRef, useState } from "react";
import { SaveIndicator, WithIndicator } from "@/components/onboarding/save-indicator";
import { SecretInput } from "@/components/shared/secret-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAutosave } from "@/hooks/use-autosave";

/**
 * How a secret proves it is complete before it is stored. A half-typed key
 * must never be stored, so secrets store only on a paste or a blur, and only
 * when they pass their rule:
 *
 * - `pattern`: the full value must match (PEM keys).
 * - `prefixes`: a value with a known prefix needs `minLength` characters.
 *   `strict` rejects every other prefix. Without `strict`, another format
 *   needs 16 characters, and a value that is only the start of a known
 *   prefix ("gh", "gl") is still being typed.
 * - Neither: the format is unknown and needs 16 characters.
 *
 * Without `pattern`, a space or a line break inside the value fails at once.
 */
export interface SecretRule {
  prefixes?: readonly string[];
  strict?: boolean;
  pattern?: RegExp;
  /** Minimum length of a value with a known prefix. */
  minLength?: number;
  /** Shown when the value cannot be right, e.g. "Starts with xoxb-". */
  hint?: string;
}

/** Minimum length of a secret in an unknown format. */
const OTHER_FORMAT_MIN = 16;

/**
 * Realistic key shapes per provider: the prefix and the shortest real key.
 * Shared by every field that stores one of these keys.
 */
export const KEY_RULES = {
  claudeToken: {
    prefixes: ["sk-ant-oat01-"],
    strict: true,
    minLength: 100,
    hint: "Starts with sk-ant-oat01-",
  },
  anthropicKey: {
    prefixes: ["sk-ant-api03-"],
    strict: true,
    minLength: 100,
    hint: "Starts with sk-ant-api03-",
  },
  openRouter: {
    prefixes: ["sk-or-v1-"],
    strict: true,
    minLength: 73,
    hint: "Starts with sk-or-v1-",
  },
  openAi: { prefixes: ["sk-"], strict: true, minLength: 40, hint: "Starts with sk-" },
  deepSeek: { prefixes: ["sk-"], strict: true, minLength: 30, hint: "Starts with sk-" },
  slackBot: { prefixes: ["xoxb-"], strict: true, minLength: 50, hint: "Starts with xoxb-" },
  slackApp: { prefixes: ["xapp-"], strict: true, minLength: 80, hint: "Starts with xapp-" },
  // Classic tokens without a prefix are another format (16+ characters).
  github: { prefixes: ["ghp_", "github_pat_", "gho_", "ghu_", "ghs_"], minLength: 40 },
  // Self-managed GitLab can change the prefix.
  gitlab: { prefixes: ["glpat-"], minLength: 26 },
  // Atlassian API tokens start ATATT, workspace access tokens ATCTT.
  bitbucket: { prefixes: ["ATATT", "ATCTT"], minLength: 40 },
  // Service user keys and personal tokens use different prefixes.
  devin: { prefixes: ["cog_", "apk_"], minLength: 30 },
  vercel: { prefixes: ["vck_"], minLength: 30 },
} satisfies Record<string, SecretRule>;

export interface SecretCheck {
  /** Complete: a paste or a blur stores it. */
  valid: boolean;
  /** Why the value cannot be stored. */
  problem: string | null;
  /** The problem is certain while typing (wrong prefix). Otherwise it shows after blur. */
  problemNow: boolean;
}

/** A key never has a space or a line break inside. The field is masked, so the user cannot see one. */
const SPACE_PROBLEM = "Remove the space or line break from the key.";

/** The keys of a credential pool, as the server splits it: on commas, trimmed, blanks dropped. */
function poolKeys(value: string): string[] {
  return value
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

/**
 * Check a secret against its rule. `pool`: the value is a comma-separated
 * credential pool, and every key in it must pass the rule.
 */
export function checkSecret(raw: string, rule: SecretRule = {}, pool = false): SecretCheck {
  const keys = pool && !rule.pattern ? poolKeys(raw) : [];
  if (keys.length < 2) return checkOneSecret(keys[0] ?? raw, rule);
  for (const [index, key] of keys.entries()) {
    const check = checkOneSecret(key, rule);
    if (check.valid) continue;
    // Only the last key can still be typed. A key before a comma is finished.
    const last = index === keys.length - 1;
    const problem = check.problem ?? (last ? null : (rule.hint ?? "Looks too short."));
    return {
      valid: false,
      problem: problem && `Key ${index + 1}: ${problem}`,
      problemNow: check.problemNow || !last,
    };
  }
  return { valid: true, problem: null, problemNow: false };
}

function checkOneSecret(raw: string, rule: SecretRule): SecretCheck {
  const value = raw.trim();
  if (!value) return { valid: false, problem: null, problemNow: false };
  if (rule.pattern) {
    // Multi-line formats (PEM keys) have line breaks inside.
    const ok = rule.pattern.test(value);
    return { valid: ok, problem: ok ? null : (rule.hint ?? null), problemNow: false };
  }
  if (/\s/.test(value)) return { valid: false, problem: SPACE_PROBLEM, problemNow: true };
  const prefixes = rule.prefixes ?? [];
  if (prefixes.some((p) => value.startsWith(p))) {
    const long = value.length >= (rule.minLength ?? OTHER_FORMAT_MIN);
    return { valid: long, problem: long ? null : "Looks too short.", problemNow: false };
  }
  // The start of a known prefix ("xo", "gh"): still typing it.
  const typingPrefix = prefixes.some((p) => p.startsWith(value));
  if (rule.strict) {
    const problem = typingPrefix ? null : (rule.hint ?? `Starts with ${prefixes.join(" or ")}`);
    return { valid: false, problem, problemNow: !typingPrefix };
  }
  const long = value.length >= OTHER_FORMAT_MIN;
  return {
    valid: long && !typingPrefix,
    problem: long ? null : "Looks too short.",
    problemNow: false,
  };
}

/**
 * A paste is a whole value, so it stores without waiting for a blur. `onPaste`
 * fires before the field changes, so the commit rides the change that
 * follows, and only when the paste changed the value.
 */
export function usePasteCommit(commit: () => void) {
  const pasted = useRef(false);
  return {
    onPaste: () => {
      pasted.current = true;
      // A paste that inserts nothing fires no change: drop the flag after this task.
      window.setTimeout(() => {
        pasted.current = false;
      }, 0);
    },
    /** Call from `onChange` with the value before and after. */
    afterChange: (previous: string, next: string) => {
      if (!pasted.current) return;
      pasted.current = false;
      if (next.trim() !== previous.trim()) commit();
    },
  };
}

interface AutosaveSecretFieldProps {
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
  /** A credential pool: comma-separated keys, each checked against `rule`. */
  pool?: boolean;
}

/**
 * Write-only secret field that saves itself (autosave, no Save button). A
 * saved secret shows as masked dots with a Replace action, and its value
 * never comes back from the API. A new value stores on a paste, or when focus
 * leaves the whole field (input, eye toggle, "Keep saved value"), once it
 * passes `rule` (see `SecretRule`), never while typing. The masked view comes
 * back on blur, never under a focused field.
 */
export function AutosaveSecretField({
  id,
  saved,
  onSave,
  rule,
  placeholder,
  disabled,
  describedBy,
  multiline,
  pool,
}: AutosaveSecretFieldProps) {
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [blurred, setBlurred] = useState(false);
  // Keys in the pool this field stored. The API never returns the value, so
  // the count is known only after a save in this view.
  const [savedKeys, setSavedKeys] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  // Where focus goes after the next render, so switching views never drops it.
  const focusNext = useRef<"field" | "replace" | null>(null);
  const value = draft.trim();
  const check = checkSecret(value, rule, pool);

  const autosave = useAutosave({
    value,
    dirty: value.length > 0,
    // Never while typing: only a paste or a blur stores a secret.
    ready: false,
    readyOnCommit: check.valid,
    save: async (next) => {
      await onSave(next);
      if (pool) setSavedKeys(poolKeys(next).length);
      // Typing that came after this value stays in the field.
      setDraft((current) => (current.trim() === next ? "" : current));
      setReplacing(false);
      setBlurred(false);
    },
  });
  const paste = usePasteCommit(autosave.commit);

  useLayoutEffect(() => {
    if (!focusNext.current) return;
    if (focusNext.current === "replace") replaceRef.current?.focus();
    else (multiline ? textareaRef.current : inputRef.current)?.focus();
    focusNext.current = null;
  });

  const onChange = (next: string) => {
    paste.afterChange(draft, next);
    setDraft(next);
  };
  // Focus that moves to the eye toggle or "Keep saved value" stays in the
  // field: only focus that leaves the whole group commits the draft.
  const onGroupBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      return;
    setFocused(false);
    setBlurred(true);
    autosave.commit();
  };

  // A wrong prefix shows at once. Anything else waits for blur.
  const problem = check.problem && (blurred || check.problemNow) ? check.problem : null;
  const indicator = <SaveIndicator phase={autosave.phase} error={autosave.error} />;
  const problemId = `${id}-problem`;
  const described =
    [problem ? problemId : null, describedBy].filter(Boolean).join(" ") || undefined;

  if (saved && !replacing && !draft && !focused) {
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
        {savedKeys > 1 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{savedKeys}</span> keys
          </span>
        ) : null}
        <Button
          ref={replaceRef}
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            focusNext.current = "field";
            setReplacing(true);
          }}
        >
          Replace
        </Button>
      </div>
    );
  }

  const field = multiline ? (
    <WithIndicator indicator={indicator} multiline>
      <Textarea
        id={id}
        ref={textareaRef}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
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
      ref={inputRef}
      value={draft}
      onChange={onChange}
      onPaste={paste.onPaste}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete="new-password"
      describedBy={described}
      invalid={Boolean(problem)}
      indicator={indicator}
    />
  );

  return (
    <div className="space-y-1" onFocus={() => setFocused(true)} onBlur={onGroupBlur}>
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
          // A pointer click must not blur the field first: that would store the draft.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            focusNext.current = "replace";
            setDraft("");
            setReplacing(false);
            setFocused(false);
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
