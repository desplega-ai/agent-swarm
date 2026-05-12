import { useCallback, useState } from "react";

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

export interface UseCopyToClipboardResult<K extends string = string> {
  /** Whether the most recent successful copy is still flashing. */
  copied: boolean;
  /** The `key` of the most recent successful copy (or null / idle). */
  copiedKey: K | null;
  /** Copy `value` to the clipboard; optionally tag it with `key`. */
  copy: (value: string, key?: K) => Promise<void>;
}

const RESET_MS = 1500;

export function useCopyToClipboard<K extends string = string>(): UseCopyToClipboardResult<K> {
  const [copiedKey, setCopiedKey] = useState<K | null>(null);

  const copy = useCallback(async (value: string, key?: K) => {
    if (!value) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        const k = (key ?? ("default" as K)) as K;
        setCopiedKey(k);
        setTimeout(() => {
          setCopiedKey((prev) => (prev === k ? null : prev));
        }, RESET_MS);
      }
    } catch {
      // Clipboard unavailable — silent.
    }
  }, []);

  return { copied: copiedKey !== null, copiedKey, copy };
}
