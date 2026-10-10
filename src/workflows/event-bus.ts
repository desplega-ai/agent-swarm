import { InProcessBus, realtimeBus } from "../realtime/bus";
import { scrubSecrets } from "../utils/secret-scrubber";

export type PrefixHandler = (event: string, data: unknown) => void;

export interface WorkflowEventBus {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
  /**
   * Subscribe to every event whose name starts with `prefix` (e.g. `"github."`).
   * For event families whose last segment is open-ended, such as
   * `github.pull_request.<action>`. The handler receives the full event name.
   */
  onPrefix(prefix: string, handler: PrefixHandler): void;
  offPrefix(prefix: string, handler: PrefixHandler): void;
}

export class InProcessEventBus implements WorkflowEventBus {
  private readonly prefixHandlers = new Map<string, Set<PrefixHandler>>();

  constructor(private readonly bus = new InProcessBus()) {}

  emit(event: string, rawData: unknown): void {
    // Backstop only: emitters still own scrubbing. Top-level strings, shallow
    // copy, so class instances and nested rows pass through untouched.
    const data = scrubTopLevelStrings(rawData);
    this.bus.publish(`workflow:${event}`, data);
    for (const [prefix, handlers] of this.prefixHandlers) {
      if (!event.startsWith(prefix)) continue;
      for (const handler of [...handlers]) handler(event, data);
    }
  }

  on(event: string, handler: (data: unknown) => void): void {
    this.bus.subscribe(`workflow:${event}`, handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    this.bus.unsubscribe(`workflow:${event}`, handler);
  }

  onPrefix(prefix: string, handler: PrefixHandler): void {
    const handlers = this.prefixHandlers.get(prefix) ?? new Set<PrefixHandler>();
    handlers.add(handler);
    this.prefixHandlers.set(prefix, handlers);
  }

  offPrefix(prefix: string, handler: PrefixHandler): void {
    const handlers = this.prefixHandlers.get(prefix);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.prefixHandlers.delete(prefix);
  }
}

function scrubTopLevelStrings(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  if (Object.getPrototypeOf(data) !== Object.prototype) return data;
  let copy: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") continue;
    const scrubbed = scrubSecrets(value);
    if (scrubbed === value) continue;
    copy ??= { ...(data as Record<string, unknown>) };
    copy[key] = scrubbed;
  }
  return copy ?? data;
}

export const workflowEventBus: WorkflowEventBus = new InProcessEventBus(realtimeBus);
