import type { Logger } from "chat";
import { scrubObject, scrubSecrets } from "@/utils/secret-scrubber";

/** Called for every warn/error line, already scrubbed. Feeds adapter health. */
export type ChatLogIssueSink = (level: "warn" | "error", message: string) => void;

function scrubArg(arg: unknown): unknown {
  if (arg instanceof Error) return scrubSecrets(`${arg.name}: ${arg.message}`);
  return scrubObject(arg);
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
    if (level === "warn" || level === "error") onIssue?.(level, scrubbedMessage);
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
