import type { BusTopics } from "./topics";

export type BusDelivery = "durable" | "wake-up";
export interface Bus {
  publish<T extends keyof BusTopics>(topic: T, payload: BusTopics[T]): Promise<void>;
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
  prune(): Promise<number>;
}
