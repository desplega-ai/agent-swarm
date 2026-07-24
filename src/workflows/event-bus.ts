import { EventEmitter } from "node:events";

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
    for (const handler of this.anyHandlers) {
      try {
        handler(event, data);
      } catch (err) {
        // A failing tap must never break the emitting call site.
        console.error(`[EventBus] onAny handler failed for '${event}':`, err);
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
    this.anyHandlers = this.anyHandlers.filter((h) => h !== handler);
  }
}

export const workflowEventBus: WorkflowEventBus = new InProcessEventBus();
