import type { Logger } from "chat";
import { scrubObject, scrubSecrets } from "@/utils/secret-scrubber";

/** Called for every warn/error line, already scrubbed. Feeds adapter health. */
export type ChatLogIssueSink = (level: "warn" | "error", message: string) => void;

/** Bound on the issue text handed to the sink (adapter health `lastWarning`). */
const MAX_ISSUE_CHARS = 300;

function scrubArg(arg: unknown): unknown {
  if (arg instanceof Error) return scrubSecrets(`${arg.name}: ${arg.message}`);
  return scrubObject(arg);
}

function describeCause(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

/**
 * The cause of a warn/error line: an `Error` argument, or the `error` / `err`
 * field of an object argument (adapters log `{ error: String(error) }`).
 */
function causeOf(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (arg instanceof Error) return describeCause(arg);
    if (arg && typeof arg === "object") {
      const record = arg as Record<string, unknown>;
      const value = record.error ?? record.err;
      if (value !== undefined && value !== null) return describeCause(value);
    }
  }
  return undefined;
}

/**
 * SDK `Logger` that scrubs every argument before it reaches the console. The
 * Chat SDK has no egress hook like `installSlackEgressScrub`, so the logger is
 * the scrub point for everything the SDK and its adapters print.
 */
export function createScrubbingLogger(prefix: string, onIssue?: ChatLogIssueSink): Logger {
  const tag = `[chat-sdk:${prefix}]`;
  const emit = (level: "info" | "warn" | "error", message: string, args: unknown[]): void => {
    const scrubbedMessage = scrubSecrets(message);
    const scrubbedArgs = args.map(scrubArg);
    if (onIssue && (level === "warn" || level === "error")) {
      const cause = causeOf(args);
      const issue = cause ? `${scrubbedMessage}: ${scrubSecrets(cause)}` : scrubbedMessage;
      onIssue(level, issue.slice(0, MAX_ISSUE_CHARS));
    }
    console[level](tag, scrubbedMessage, ...scrubbedArgs);
  };
  return {
    // Debug is dropped, matching the SDK's default ConsoleLogger("info") level.
    debug: () => {},
    info: (message, ...args) => emit("info", message, args),
    warn: (message, ...args) => emit("warn", message, args),
    error: (message, ...args) => emit("error", message, args),
    child: (childPrefix) => createScrubbingLogger(`${prefix}:${childPrefix}`, onIssue),
  };
}

/**
 * Drop `info` lines for which `keep(message)` is false. Warn and error lines
 * always pass. Child loggers keep the filter.
 */
export function withInfoFilter(logger: Logger, keep: (message: string) => boolean): Logger {
  return {
    debug: (message, ...args) => logger.debug(message, ...args),
    info: (message, ...args) => {
      if (keep(message)) logger.info(message, ...args);
    },
    warn: (message, ...args) => logger.warn(message, ...args),
    error: (message, ...args) => logger.error(message, ...args),
    child: (childPrefix) => withInfoFilter(logger.child(childPrefix), keep),
  };
}

/** Error text for logs and tool results, scrubbed. */
export function errorMessage(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err));
}
