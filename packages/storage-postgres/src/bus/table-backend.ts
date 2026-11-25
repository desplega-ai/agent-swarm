import {
  BUS_DURABLE_GROUPS,
  BUS_TOPICS,
  type BusDelivery,
  type BusTopics,
  type DbClient,
  type ManagedBus,
} from "@desplega/storage";
import { PostgresBusRepository } from "../repositories/bus";

type Subscription = {
  topic: keyof BusTopics;
  group: string;
  delivery: BusDelivery;
  handler: (payload: never) => Promise<void>;
};

export class PostgresTableBus implements ManagedBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly repo: PostgresBusRepository;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = true;
  private requested = false;
  private lastPrune = 0;

  constructor(
    private readonly client: DbClient,
    private readonly options: {
      leaseMs?: number;
      sweepMs?: number;
      retentionMs?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    this.repo = new PostgresBusRepository(client);
  }

  subscribe<T extends keyof BusTopics>(
    topic: T,
    group: string,
    handler: (payload: BusTopics[T]) => Promise<void>,
    options: { delivery: BusDelivery },
  ): () => void {
    if ([...this.subscriptions].some((s) => s.topic === topic && s.group === group)) {
      throw new Error("Bus group already has a local subscription");
    }
    if (BUS_TOPICS[topic] === "ephemeral" && options.delivery === "durable") {
      throw new Error("Ephemeral topics cannot have durable subscriptions");
    }
    const subscription: Subscription = { topic, group, handler, ...options };
    this.subscriptions.add(subscription);
    this.wake();
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  async publish<T extends keyof BusTopics>(topic: T, payload: BusTopics[T]): Promise<void> {
    const subscribers = [...this.subscriptions].filter((s) => s.topic === topic);
    await this.client.transaction(async () => {
      if (BUS_TOPICS[topic] === "durable") {
        await this.repo.publish(crypto.randomUUID(), topic, payload, [
          ...new Set([
            ...BUS_DURABLE_GROUPS[topic],
            ...subscribers.filter((s) => s.delivery === "durable").map((s) => s.group),
          ]),
        ]);
      }
      this.client.afterCommit(async () => {
        this.wake();
        await Promise.all(
          subscribers
            .filter((s) => s.delivery === "wake-up")
            .map(async (s) => {
              if (!this.subscriptions.has(s)) return;
              try {
                await s.handler(payload as never);
              } catch (error) {
                this.reportError(error);
              }
            }),
        );
      });
    });
  }

  private reportError(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else console.error("Execution bus delivery failed. The sweep will retry.");
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), this.options.sweepMs ?? 15_000);
    this.timer.unref?.();
    this.wake();
  }

  private wake(): void {
    if (this.stopped) return;
    this.requested = true;
    if (this.active) return;
    this.active = this.pump()
      .catch((error) => this.reportError(error))
      .finally(() => {
        this.active = undefined;
        if (this.requested && !this.stopped) this.wake();
      });
  }

  private async pump(): Promise<void> {
    do {
      this.requested = false;
      for (const subscription of this.subscriptions) {
        if (subscription.delivery !== "durable") continue;
        for (let i = 0; i < 100 && !this.stopped && this.subscriptions.has(subscription); i++) {
          const claim = await this.repo.claim(
            subscription.topic,
            subscription.group,
            this.options.leaseMs ?? 60_000,
          );
          if (!claim) break;
          let success = false;
          try {
            await subscription.handler(claim.payload as never);
            success = true;
          } catch (error) {
            this.reportError(error);
          }
          await this.repo.settle(
            claim,
            subscription.group,
            success,
            this.options.sweepMs ?? 15_000,
          );
          if (i === 99) this.requested = true;
        }
      }
      if (Date.now() - this.lastPrune > 3_600_000) {
        await this.prune();
        this.lastPrune = Date.now();
      }
    } while (this.requested && !this.stopped);
  }

  async drain(): Promise<void> {
    this.wake();
    await this.active;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
  async prune(): Promise<number> {
    return this.repo.prune(Date.now() - (this.options.retentionMs ?? 7 * 86_400_000));
  }
}
