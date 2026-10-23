import type { Attachment } from "chat";
import { type AdditiveBuffer, createAdditiveBuffer } from "@/tasks/additive-buffer";
import { trackBackground } from "./background";
import type { ChatAddressedReason, ChatMessageFacts } from "./facts";
import { flushChatThread } from "./inbound";
import { stopTypingKeepalive } from "./typing";

/** One inbound message waiting in its thread's buffer. */
export interface ChatBufferedMessage {
  messageId: string;
  channelId: string;
  /** Mention-stripped text. */
  text: string;
  userId: string;
  userName?: string;
  botMentioned: boolean;
  isDirectMessage: boolean;
  /** Why the message was taken; `none` when it is unaddressed. */
  addressed: ChatAddressedReason;
  /** The message got the `accepted` reaction when it was buffered. */
  reacted?: boolean;
  facts: ChatMessageFacts;
  attachments: Attachment[];
}

const DEFAULT_BUFFER_MS = 10_000;

function configuredBufferMs(): number {
  const value = Number(process.env.CHAT_SDK_BUFFER_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BUFFER_MS;
}

let buffer: AdditiveBuffer<ChatBufferedMessage> | undefined;
let bufferMs = 0;
/** Set while shutdown flushes every waiting thread; those flushes keep `dependsOn`. */
let draining = false;
/**
 * Tail of each thread's flush chain. The additive buffer clears a key before
 * it awaits `onFlush`, so a second flush of one thread can start while the
 * first still routes, downloads files or creates its task. Chaining keeps the
 * task order (and `dependsOn`) of one thread; different threads run in parallel.
 */
const flushChains = new Map<string, Promise<void>>();

/** Run `work` after every earlier flush of `threadId`. A failed flush does not block the next one. */
function runInThreadOrder(threadId: string, work: () => Promise<void>): Promise<void> {
  const previous = flushChains.get(threadId) ?? Promise.resolve();
  const run = previous.then(work);
  const tail = run.catch(() => {});
  flushChains.set(threadId, tail);
  void tail.then(() => {
    if (flushChains.get(threadId) === tail) flushChains.delete(threadId);
  });
  return run;
}

/**
 * Keyed by the raw SDK `thread.id` (`<adapter>:<platform id>`, colons
 * included); the key is never split. A changed `CHAT_SDK_BUFFER_MS` applies
 * once no thread is waiting on the old timer.
 */
function getBuffer(): AdditiveBuffer<ChatBufferedMessage> {
  const ms = configuredBufferMs();
  if (!buffer || (ms !== bufferMs && buffer.keys().length === 0)) {
    bufferMs = ms;
    buffer = createAdditiveBuffer<ChatBufferedMessage>({
      timeoutMs: ms,
      label: "chat",
      onFlush: async (items, threadId, reason) => {
        // Read now: `draining` can change while this flush waits in the chain.
        const immediate = reason === "manual" && !draining;
        // Tracked so shutdown drains timer-driven flushes before the DB closes.
        const work = runInThreadOrder(threadId, () => flushChatThread(threadId, items, immediate));
        trackBackground(work);
        // A failed flush created no task, so no relay will stop the indicator.
        await work.catch(() => stopTypingKeepalive(threadId));
      },
    });
  }
  return buffer;
}

/** Add a message to its thread's buffer and reset the debounce timer. */
export function bufferChatMessage(threadId: string, item: ChatBufferedMessage): void {
  getBuffer().enqueue(threadId, item);
}

/** Flush now with no `dependsOn` (the `!now` command). */
export async function instantFlushChat(threadId: string): Promise<void> {
  await getBuffer().instantFlush(threadId);
}

export function isChatThreadBuffered(threadId: string): boolean {
  return buffer?.isBuffered(threadId) ?? false;
}

/** Shutdown: turn every waiting thread into its task instead of dropping it. */
export async function flushAllChatBuffers(): Promise<void> {
  if (!buffer) return;
  draining = true;
  try {
    for (const threadId of buffer.keys()) await buffer.instantFlush(threadId);
  } finally {
    draining = false;
  }
}
