import { mock } from "bun:test";
import type {
  ProviderEvent,
  ProviderResult,
  SteerDelivery,
  SteerDeliveryResult,
} from "../../providers/types";

// Exercise the real control reader while a provider waits to acknowledge a queue.
const completion = Promise.withResolvers<ProviderResult>();
const queued = Promise.withResolvers<SteerDeliveryResult>();
let emit: (event: ProviderEvent) => void = () => {};
mock.module("../../providers/codex-adapter", () => ({
  async createInProcessCodexSession() {
    return {
      onEvent(listener: typeof emit) {
        emit = listener;
      },
      async deliverSteering(delivery: SteerDelivery) {
        if (delivery.mode === "queue") {
          emit({ type: "message", role: "assistant", content: "queue pending" });
          return queued.promise;
        }
        return { delivered: true, mode: "steer" };
      },
      async abort(reason: string) {
        queued.resolve({ delivered: false, reason: "Queued turn never started" });
        completion.resolve({ exitCode: 130, isError: true, failureReason: reason });
      },
      waitForCompletion() {
        return completion.promise;
      },
    };
  },
}));
const { runCodexSessionRunner } = await import("../../commands/codex-session-runner");
await runCodexSessionRunner();
