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
const NESTED_SUPPRESSED = "[console-scrub] suppressed a log line written while formatting another";

let restore: (() => void) | undefined;

export function installConsoleScrub(): void {
  if (restore) return;
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let scrubbing = false;
  for (const method of METHODS) {
    const original = console[method];
    originals.set(method, original);
    console[method] = (...args: unknown[]) => {
      if (args.length === 0) return original.call(console);
      // `format` runs custom inspectors synchronously, and one that logs lands
      // here mid-scrub. Its arguments are unscrubbed and formatting them again
      // could recurse, so fail closed with a fixed line instead.
      if (scrubbing) return original.call(console, NESTED_SUPPRESSED);
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
