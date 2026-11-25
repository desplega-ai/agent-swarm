import {
  BUS_DURABLE_GROUPS,
  BUS_TOPICS,
  type BusDelivery,
  type BusDurableGroups,
  type BusErrorContext,
  type BusTopics,
  type DbClient,
  type ManagedBus,
} from "@desplega/storage";
import { BUS_PRUNE_BATCH_SIZE, PostgresBusRepository } from "../repositories/bus";

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
  private generation = 0;

  constructor(
    private readonly client: DbClient,
    private readonly options: {
      leaseMs?: number;
      sweepMs?: number;
      retentionMs?: number;
      durableGroups?: BusDurableGroups;
      onError?: (error: unknown, context: BusErrorContext) => void;
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
    if (
      options.delivery === "durable" &&
      !(this.options.durableGroups ?? BUS_DURABLE_GROUPS)[topic].includes(group)
    ) {
      throw new Error("Durable bus group is absent from the shared catalog");
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
    const eventId = crypto.randomUUID();
    const generation = this.generation;
    try {
      await this.client.transaction(async () => {
        if (BUS_TOPICS[topic] === "durable") {
          await this.repo.publish(eventId, topic, payload, [
            ...new Set((this.options.durableGroups ?? BUS_DURABLE_GROUPS)[topic]),
          ]);
        }
        this.client.afterCommit(async () => {
          if (this.stopped || this.generation !== generation) return;
          this.wake();
          await Promise.all(
            subscribers
              .filter((s) => s.delivery === "wake-up")
              .map(async (s) => {
                if (this.stopped || this.generation !== generation || !this.subscriptions.has(s))
                  return;
                try {
                  await s.handler(payload as never);
                } catch (error) {
                  this.reportError(error, { operation: "handler", topic, group: s.group, eventId });
                }
              }),
          );
        });
      });
    } catch (error) {
      this.reportError(error, { operation: "publish", topic, eventId });
      throw error;
    }
  }

  private reportError(error: unknown, context: BusErrorContext): void {
    if (this.options.onError) this.options.onError(error, context);
    else console.error(`Execution bus ${context.operation} failed.`);
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
    this.active = this.pump().finally(() => {
      this.active = undefined;
      if (this.requested && !this.stopped) this.wake();
    });
  }

  private async pump(): Promise<void> {
    let context: BusErrorContext = { operation: "prune" };
    try {
      do {
        this.requested = false;
        for (const subscription of this.subscriptions) {
          if (subscription.delivery !== "durable") continue;
          for (let i = 0; i < 100 && !this.stopped && this.subscriptions.has(subscription); i++) {
            context = { operation: "claim", topic: subscription.topic, group: subscription.group };
            const claim = await this.repo.claim(
              subscription.topic,
              subscription.group,
              this.options.leaseMs ?? 60_000,
            );
            if (!claim) break;
            context = { ...context, eventId: claim.eventId, operation: "handler" };
            let success = false;
            try {
              await subscription.handler(claim.payload as never);
              success = true;
            } catch (error) {
              this.reportError(error, context);
            }
            context = { ...context, operation: "settle" };
            await this.repo.settle(
              claim,
              subscription.group,
              success,
              Math.min(
                300_000,
                (this.options.sweepMs ?? 15_000) * 2 ** Math.min(claim.attempts - 1, 20),
              ),
            );
            if (i === 99) this.requested = true;
          }
        }
        if (Date.now() - this.lastPrune > 3_600_000) {
          context = { operation: "prune" };
          const removed = await this.prune();
          // A full batch leaves retention due for the next wake or sweep.
          this.lastPrune = removed === BUS_PRUNE_BATCH_SIZE ? 0 : Date.now();
        }
      } while (this.requested && !this.stopped);
    } catch (error) {
      this.reportError(error, context);
    }
  }

  async drain(): Promise<void> {
    this.wake();
    await this.active;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
  async prune(): Promise<number> {
    return this.repo.prune(Date.now() - (this.options.retentionMs ?? 7 * 86_400_000));
  }
}
