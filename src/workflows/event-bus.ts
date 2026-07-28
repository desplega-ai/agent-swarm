import { EventEmitter } from "node:events";
import { scrubSecrets } from "../utils/secret-scrubber";

export interface WorkflowEventBus {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
  /**
   * Tap invoked for every emit, regardless of event name. Used by the
   * subscriptions layer to persist events durably (src/subscriptions).
   */
  onAny(handler: (event: string, data: unknown) => void): void;
  offAny(handler: (event: string, data: unknown) => void): void;
}

export class InProcessEventBus implements WorkflowEventBus {
  private emitter = new EventEmitter();
  private anyHandlers: Array<(event: string, data: unknown) => void> = [];

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: string, data: unknown): void {
    // Snapshot: a tap that registers another tap during an emit would
    // otherwise be invoked for the CURRENT event (the live array iterator sees
    // newly-pushed entries), diverging from EventEmitter semantics.
    for (const handler of [...this.anyHandlers]) {
      try {
        handler(event, data);
      } catch (err) {
        // A failing tap must never break the emitting call site. Log only the
        // message, scrubbed: a raw error object dumps a stack, and a tap can
        // throw an error derived from the event payload.
        console.error(
          `[EventBus] onAny handler failed for '${event}': ${scrubSecrets(
            err instanceof Error ? err.message : String(err),
          )}`,
        );
      }
    }
    this.emitter.emit(event, data);
  }

  on(event: string, handler: (data: unknown) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    this.emitter.off(event, handler);
  }

  onAny(handler: (event: string, data: unknown) => void): void {
    this.anyHandlers.push(handler);
  }

  offAny(handler: (event: string, data: unknown) => void): void {
    // Remove ONE registration, mirroring EventEmitter.off — filtering dropped
    // every copy, so a handler intentionally registered twice lost both taps
    // on a single off call.
    const index = this.anyHandlers.indexOf(handler);
    if (index !== -1) this.anyHandlers.splice(index, 1);
  }
}

export const workflowEventBus: WorkflowEventBus = new InProcessEventBus();
