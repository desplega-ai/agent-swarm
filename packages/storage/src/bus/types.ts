import type { BusTopics } from "./topics";

export type BusDelivery = "durable" | "wake-up";
export type BusErrorContext = {
  operation: "publish" | "claim" | "handler" | "settle" | "prune";
  topic?: keyof BusTopics;
  group?: string;
  eventId?: string;
};
export interface Bus {
  /** Publication creates a delivery for every declared durable group, even without a subscriber. */
  publish<T extends keyof BusTopics>(topic: T, payload: BusTopics[T]): Promise<void>;
  /** Durable groups must exist in the shared catalog supplied to the backend. */
  subscribe<T extends keyof BusTopics>(
    topic: T,
    group: string,
    handler: (payload: BusTopics[T]) => Promise<void>,
    options: { delivery: BusDelivery },
  ): () => void;
}

/** API-owned lifecycle. A handler must tolerate repeated delivery. */
export interface ManagedBus extends Bus {
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
  /** Delete one bounded batch of expired events whose groups all completed delivery. */
  prune(): Promise<number>;
}
