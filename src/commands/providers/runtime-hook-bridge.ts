import type { ProviderRuntimeEvent } from "./types.ts";

export type HookEventName = "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop";

export function mapProviderEventToHookLifecycle(event: ProviderRuntimeEvent): HookEventName[] {
  switch (event.type) {
    case "session_init":
      return ["SessionStart"];
    case "stream_line":
      return [];
    case "result":
      return ["Stop"];
    case "stderr":
      return [];
    case "provider_error":
      return ["Stop"];
    case "process_exit":
      return ["Stop"];
    default: {
      const _never: never = event;
      return _never;
    }
  }
}
