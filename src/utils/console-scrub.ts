import { format } from "node:util";
import { scrubSecrets } from "./secret-scrubber";

/**
 * Process-wide console scrub: every `console.log/info/warn/error/debug` line
 * is formatted, scrubbed, and handed to the previous method as one string.
 *
 * Install it before anything else wraps the console (the OTel log bridge, the
 * Ink console patch), so every later wrapper sees only scrubbed text.
 */

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
type ConsoleMethod = (typeof METHODS)[number];

const SCRUB_FAILED = "[console-scrub] failed to scrub log line";

let restore: (() => void) | undefined;

export function installConsoleScrub(): void {
  if (restore) return;
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let scrubbing = false;
  for (const method of METHODS) {
    const original = console[method];
    originals.set(method, original);
    console[method] = (...args: unknown[]) => {
      // A scrubber that logs must not recurse into itself.
      if (args.length === 0 || scrubbing) return original.apply(console, args);
      scrubbing = true;
      let line: string;
      try {
        // `format` keeps %s/%d substitution, inspects objects and prints
        // Error stacks, so the scrub sees exactly what would be printed.
        line = scrubSecrets(format(...args));
      } catch {
        // Never fall back to the raw arguments.
        line = SCRUB_FAILED;
      } finally {
        scrubbing = false;
      }
      original.call(console, line);
    };
  }
  restore = () => {
    for (const [method, original] of originals) console[method] = original;
    restore = undefined;
  };
}

/** Restore the console methods captured at install time (tests only). */
export function uninstallConsoleScrub(): void {
  restore?.();
}
