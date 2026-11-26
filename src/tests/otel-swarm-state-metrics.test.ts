import { afterEach, describe, expect, test } from "bun:test";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import type { SwarmStateStats } from "../be/swarm-state-stats";
import { startSwarmStateMetrics, stopSwarmStateMetrics } from "../otel-impl";

class CollectingReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

async function points(reader: CollectingReader) {
  const { resourceMetrics } = await reader.collect();
  const out: Record<string, { value: unknown; attributes: unknown }[]> = {};
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      out[metric.descriptor.name] = metric.dataPoints.map((p) => ({
        value: p.value,
        attributes: p.attributes,
      }));
    }
  }
  return out;
}

const STATS: SwarmStateStats = {
  failedTasks1h: 3,
  pendingApprovals: 2,
  pendingApprovalMaxAgeSeconds: 120,
  overdueApprovals: 1,
  claimableTasks: 7,
  oldestClaimableAgeSeconds: 1900,
};

describe("swarm state gauges", () => {
  afterEach(() => stopSwarmStateMetrics());

  test("exports the six unlabeled gauges from one read", async () => {
    const reader = new CollectingReader();
    const provider = new MeterProvider({ readers: [reader] });
    let reads = 0;
    startSwarmStateMetrics(async () => {
      reads++;
      return STATS;
    }, provider.getMeter("test"));

    expect(await points(reader)).toEqual({
      "agentswarm.tasks.failed.1h": [{ value: 3, attributes: {} }],
      "agentswarm.approvals.pending": [{ value: 2, attributes: {} }],
      "agentswarm.approvals.pending.max_age": [{ value: 120, attributes: {} }],
      "agentswarm.approvals.overdue": [{ value: 1, attributes: {} }],
      "agentswarm.queue.claimable": [{ value: 7, attributes: {} }],
      "agentswarm.queue.oldest_age": [{ value: 1900, attributes: {} }],
    });
    expect(reads).toBe(1);
    await provider.shutdown();
  });

  test("a failed read exports nothing", async () => {
    const reader = new CollectingReader();
    const provider = new MeterProvider({ readers: [reader] });
    startSwarmStateMetrics(async () => {
      throw new Error("db down");
    }, provider.getMeter("test"));
    const out = await points(reader);
    expect(Object.values(out).flat()).toEqual([]);
    await provider.shutdown();
  });
});
