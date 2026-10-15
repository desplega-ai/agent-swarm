import { errorMessage } from "./logger";
import { getChatInstance, isChatSdkStopping } from "./runtime";
import { assertTrustedChatTarget } from "./teams-origin";
import { getChatSdkTestHooks } from "./test-hooks";

/** Telegram shows one typing action for about 5 s, so renew it before that. */
const TYPING_INTERVAL_MS = 4_000;
/** Hard cap: a task that never relays must not show typing forever. */
const TYPING_MAX_MS = 15 * 60 * 1000;

const keepalives = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Show the typing indicator in `threadId` until `stopTypingKeepalive`, the
 * hard cap, or the adapter stops. Idempotent per thread id. Adapters without
 * `startTyping` and untrusted Teams service URLs are skipped.
 */
export function startTypingKeepalive(adapter: string, threadId: string): void {
  if (keepalives.has(threadId)) return;
  // A shutdown flush creates tasks too; no indicator for a reply that comes after a restart.
  if (isChatSdkStopping()) return;
  // Typing sends the Teams bot token to the service URL in the thread id.
  try {
    assertTrustedChatTarget(threadId);
  } catch {
    return;
  }
  if (typeof getChatInstance(adapter)?.getAdapter(adapter)?.startTyping !== "function") return;

  const hooks = getChatSdkTestHooks();
  const maxMs = hooks.typingMaxMs ?? TYPING_MAX_MS;
  const startedAt = Date.now();
  let warned = false;
  const sendTyping = async (): Promise<void> => {
    const target = getChatInstance(adapter)?.getAdapter(adapter);
    if (Date.now() - startedAt >= maxMs || typeof target?.startTyping !== "function") {
      stopTypingKeepalive(threadId);
      return;
    }
    try {
      await target.startTyping(threadId);
    } catch (error) {
      if (warned) return;
      warned = true;
      console.warn(`[chat-sdk] Typing indicator failed for ${threadId}: ${errorMessage(error)}`);
    }
  };
  const timer = setInterval(() => void sendTyping(), hooks.typingIntervalMs ?? TYPING_INTERVAL_MS);
  timer.unref();
  keepalives.set(threadId, timer);
  void sendTyping();
}

export function stopTypingKeepalive(threadId: string): void {
  const timer = keepalives.get(threadId);
  if (!timer) return;
  clearInterval(timer);
  keepalives.delete(threadId);
}

/** Stop every keepalive. For `stopChatSdk`. */
export function stopAllTypingKeepalives(): void {
  for (const timer of keepalives.values()) clearInterval(timer);
  keepalives.clear();
}
