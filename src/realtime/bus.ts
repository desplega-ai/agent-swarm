import { EventEmitter } from "node:events";

type Handler = (payload: unknown) => void;

// Delivery is synchronous and ephemeral. Rooms recover through CRDT sync.
export class InProcessBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(topic: string, payload: unknown): void {
    this.emitter.emit(topic, payload);
  }

  subscribe(topic: string, handler: Handler): () => void {
    this.emitter.on(topic, handler);
    return () => this.unsubscribe(topic, handler);
  }

  unsubscribe(topic: string, handler: Handler): void {
    this.emitter.off(topic, handler);
  }

  subscriberCount(topic: string): number {
    return this.emitter.listenerCount(topic);
  }
}

const state = globalThis as typeof globalThis & { __realtimeBus?: InProcessBus };
state.__realtimeBus ??= new InProcessBus();
export const realtimeBus = state.__realtimeBus;
