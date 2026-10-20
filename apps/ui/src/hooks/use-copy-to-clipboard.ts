import { useCallback, useEffect, useRef, useState } from "react";

// Lightweight clipboard hook used by every "click to copy" button in the
// integrations OAuth sections, the workflows trigger-schema Copy buttons, and
// the codex-oauth / claude-managed CLI snippet panels. Encapsulates the
// `typeof navigator` SSR guard, the clipboard.writeText call, and the
// 1.5-second "Copied" → idle reset that every previous call site duplicated.
//
// Usage:
//   const { copied, copy } = useCopyToClipboard();
//   <Button onClick={() => copy(value)}>{copied ? "Copied" : "Copy"}</Button>
//
// Pass an optional `key` argument when one component needs to track which of
// several Copy buttons was last clicked (e.g. linear-oauth-section's
// redirect / webhook URLs):
//   const { copiedKey, copy } = useCopyToClipboard<"redirect" | "webhook">();
//   copy(value, "redirect");
//
// `copy` resolves to `false` when the clipboard is unavailable or denied, so a
// caller that must not fail silently can show feedback. An empty string is a
// real value (a JSON node `""`) and is written like any other.

export interface UseCopyToClipboardResult<K extends string = string> {
  /** Whether the most recent successful copy is still flashing. */
  copied: boolean;
  /** The `key` of the most recent successful copy (or null / idle). */
  copiedKey: K | null;
  /** Copy `value` to the clipboard; optionally tag it with `key`. Resolves to `true` on success. */
  copy: (value: string, key?: K) => Promise<boolean>;
}

const RESET_MS = 1500;

export function useCopyToClipboard<K extends string = string>(): UseCopyToClipboardResult<K> {
  const [copiedKey, setCopiedKey] = useState<K | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async (value: string, key?: K) => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) return false;
      await navigator.clipboard.writeText(value);
      const k = (key ?? ("default" as K)) as K;
      setCopiedKey(k);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setCopiedKey((prev) => (prev === k ? null : prev));
      }, RESET_MS);
      return true;
    } catch {
      // Clipboard unavailable or denied.
      return false;
    }
  }, []);

  return { copied: copiedKey !== null, copiedKey, copy };
}
