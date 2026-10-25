import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useAddPoolKeys, usePoolKeys, useRemovePoolKey } from "@/api/hooks/use-pool-keys";
import type { PoolKey, PoolKeyCheck, PoolKeysAddResponse, PoolKeysResponse } from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import {
  checkSecret,
  type SecretRule,
  usePasteCommit,
} from "@/components/onboarding/autosave-secret-field";
import { KeyStatusPill, type KeyStatusTone } from "@/components/shared/key-status-pill";
import { SecretInput } from "@/components/shared/secret-input";
import { StatusLine } from "@/components/shared/status-icon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useContinueHold } from "@/hooks/use-autosave";
import { cn, formatRelativeTime, parseUTCDate } from "@/lib/utils";

const CHECKING = "Checking the key…";
const ENV_ONLY = "These keys come from the deployment env. Change them there.";

export interface PoolKeysListProps {
  /** The pool env var, one of the API's `CREDENTIAL_POOL_VARS` (`ANTHROPIC_API_KEY`). */
  envVar: string;
  /** Id of the add input, so a `<Label htmlFor>` names it and a link can focus it. */
  inputId: string;
  /** What one key is called ("Anthropic API key"). Names the list for screen readers. */
  label: string;
  /** The per-provider format rule, checked before the request. Default: 16+ characters. */
  rule?: SecretRule;
  placeholder?: string;
  /** Id of a help line outside the component, read with the add input. */
  describedBy?: string;
  /** After an add stored keys: the new list and the check of each new key. */
  onAdded?: (result: PoolKeysAddResponse) => void;
  /** After a remove: the keys that are left. */
  onRemoved?: (result: PoolKeysResponse) => void;
  /** Base URL for the check only: null tests the provider default. Omit for the stored URL. */
  checkBaseUrl?: string | null;
}

interface ResultLine {
  tone: "success" | "warning" | "error";
  text: ReactNode;
}

/** Lines under the add field. `forDraft` lines explain the typed value and clear on the next edit. */
interface Result {
  lines: ResultLine[];
  forDraft: boolean;
}

const NO_RESULT: Result = { lines: [], forDraft: false };

function Suffix({ value }: { value: string }) {
  return <span className="font-mono">{value}</span>;
}

/** "HTTP 401: bad key." reads as "HTTP 401: bad key" in front of another clause. */
function clause(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

function checkLine(check: PoolKeyCheck): ResultLine {
  const suffix = <Suffix value={check.suffix} />;
  switch (check.result) {
    case "verified":
      return { tone: "success", text: <>The key ending {suffix} works.</> };
    case "rejected":
      return { tone: "error", text: <>The provider rejected the key ending {suffix}.</> };
    default:
      return {
        tone: "warning",
        text: (
          <>
            Saved. Could not check the key ending {suffix} now
            {check.error ? `: ${clause(check.error)}` : ""}. Agents check it within about 10
            seconds.
          </>
        ),
      };
  }
}

/** A clock time, with the date when it is not today. */
function clockTime(iso: string): string {
  const date = parseUTCDate(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const today = date.toDateString() === new Date().toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function keyState(key: PoolKey): { tone: KeyStatusTone; pill: string; meta: string | null } {
  switch (key.status) {
    case "ok":
      return { tone: "success", pill: "Verified", meta: null };
    case "rejected": {
      const reason = clause(key.error ?? "The provider rejected the key");
      const when = key.checkedAt ? `, ${formatRelativeTime(key.checkedAt)}` : "";
      return { tone: "error", pill: "Rejected", meta: `${reason}${when}.` };
    }
    case "rate_limited":
      return {
        tone: "warning",
        pill: "Rate limited",
        meta: key.rateLimitedUntil ? `Until ${clockTime(key.rateLimitedUntil)}.` : null,
      };
    default:
      return { tone: "neutral", pill: "Not checked yet", meta: null };
  }
}

/**
 * The keys of one credential pool, one row each: "Key ending abcde", its
 * status, and Remove. Under the rows, a masked field adds one key (or a few,
 * comma separated). The API checks each new key with the provider before it
 * stores anything: a rejected key saves nothing and keeps the input. An
 * env-only pool lists its keys read-only.
 */
export function PoolKeysList({
  envVar,
  inputId,
  label,
  rule = {},
  placeholder,
  describedBy,
  onAdded,
  onRemoved,
  checkBaseUrl,
}: PoolKeysListProps) {
  const query = usePoolKeys(envVar);
  const add = useAddPoolKeys(envVar);
  const remove = useRemovePoolKey(envVar);
  const [draft, setDraft] = useState("");
  // A paste is a whole key, so it adds at once, like the other setup fields.
  const latestDraft = useRef("");
  const paste = usePasteCommit(() => submit(latestDraft.current));
  const [result, setResult] = useState<Result>(NO_RESULT);
  const resultId = useId();
  // In `/setup`, Continue waits for the check. Outside a step this does nothing.
  useContinueHold(add.isPending ? CHECKING : null);

  const pool = query.data;
  const readOnly = pool?.readOnly === true;
  const draftError = result.forDraft && result.lines.length > 0;
  const removingIndex = remove.isPending ? remove.variables?.index : undefined;

  function change(value: string) {
    const previous = latestDraft.current;
    latestDraft.current = value;
    setDraft(value);
    if (result.forDraft) setResult(NO_RESULT);
    paste.afterChange(previous, value);
  }

  function submit(raw = draft) {
    const value = raw.trim();
    if (!value || add.isPending) return;
    const check = checkSecret(value, rule, true);
    if (!check.valid) {
      const problem = check.problem ?? rule.hint ?? "Looks too short.";
      setResult({ forDraft: true, lines: [{ tone: "error", text: problem }] });
      return;
    }
    setResult(NO_RESULT);
    add.mutate(
      { value, baseUrl: checkBaseUrl },
      {
        onSuccess: (response) => {
          latestDraft.current = "";
          setDraft("");
          setResult({ forDraft: false, lines: response.checks.map(checkLine) });
          onAdded?.(response);
        },
        // The server text names the key by its suffix ("... Nothing was saved."). The input stays.
        onError: (err) =>
          setResult({ forDraft: true, lines: [{ tone: "error", text: err.message }] }),
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  function removeKey(key: PoolKey) {
    remove.mutate(
      { index: key.index, suffix: key.suffix },
      {
        onSuccess: (response) => onRemoved?.(response),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  let rows: ReactNode;
  if (!pool) {
    rows = query.error ? (
      <p className="text-xs text-status-error-strong">{query.error.message}</p>
    ) : (
      <Skeleton className="h-11 w-full" />
    );
  } else if (pool.keys.length === 0) {
    rows = <p className="text-xs text-muted-foreground">No keys saved yet.</p>;
  } else {
    rows = (
      <ul
        aria-label={`${label}: saved keys`}
        className="divide-y divide-border-subtle rounded-md border border-border"
      >
        {pool.keys.map((key) => (
          <PoolKeyRow
            key={`${key.index}-${key.suffix}`}
            poolKey={key}
            canRemove={!readOnly}
            removing={removingIndex === key.index}
            disabled={remove.isPending}
            onRemove={() => removeKey(key)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-2">
      {rows}
      {readOnly ? (
        <p className="text-xs text-muted-foreground">{ENV_ONLY}</p>
      ) : (
        <div>
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1 basis-56">
              <SecretInput
                id={inputId}
                value={draft}
                onChange={change}
                onKeyDown={onKeyDown}
                onPaste={paste.onPaste}
                placeholder={placeholder}
                autoComplete="new-password"
                // Read-only, not disabled, while the check runs: focus stays in the field.
                readOnly={add.isPending}
                aria-busy={add.isPending || undefined}
                invalid={draftError}
                describedBy={
                  [result.lines.length > 0 ? resultId : null, describedBy]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => submit()}
              disabled={!draft.trim() || add.isPending}
            >
              {add.isPending ? (
                <>
                  <Spinner className="size-4" />
                  {CHECKING}
                </>
              ) : (
                "Add key"
              )}
            </Button>
          </div>
          {/* Always mounted: the live region announces each new result. */}
          <output id={resultId} className="mt-2 block space-y-1 empty:mt-0">
            {result.lines.map((line, i) => (
              <StatusLine
                key={i}
                tone={line.tone}
                className={cn(
                  "items-start text-xs",
                  line.tone === "error" && "text-status-error-strong",
                )}
              >
                {line.text}
              </StatusLine>
            ))}
          </output>
        </div>
      )}
    </div>
  );
}

function PoolKeyRow({
  poolKey,
  canRemove,
  removing,
  disabled,
  onRemove,
}: {
  poolKey: PoolKey;
  canRemove: boolean;
  removing: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  const state = keyState(poolKey);
  const suffix = <Suffix value={poolKey.suffix} />;
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm">Key ending {suffix}</span>
          <KeyStatusPill tone={state.tone}>{state.pill}</KeyStatusPill>
        </div>
        {state.meta ? (
          <p
            className={cn(
              "text-xs break-words",
              state.tone === "error" ? "text-status-error-strong" : "text-muted-foreground",
            )}
          >
            {state.meta}
          </p>
        ) : null}
      </div>
      {canRemove ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="destructive-outline"
              size="sm"
              className="shrink-0"
              disabled={disabled}
              aria-label={`${removing ? "Removing" : "Remove"} the key ending ${poolKey.suffix}`}
            >
              {removing ? "Removing…" : "Remove"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove the key ending {suffix}?</AlertDialogTitle>
              <AlertDialogDescription>
                Agents stop using it within about 10 seconds.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onRemove}>
                Remove key
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </li>
  );
}
