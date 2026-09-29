import { afterEach, describe, expect, mock, test } from "bun:test";
import { type LogRecord, logs, SeverityNumber } from "@opentelemetry/api-logs";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import {
  installConsoleLogBridge,
  startEventLoopDelayMetrics,
  stopEventLoopDelayMetrics,
  uninstallConsoleLogBridge,
} from "../otel-impl";

class CollectingReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

async function gaugeValues(reader: CollectingReader): Promise<Record<string, number>> {
  const { resourceMetrics } = await reader.collect();
  const values: Record<string, number> = {};
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      const point = metric.dataPoints[0];
      if (point && typeof point.value === "number") values[metric.descriptor.name] = point.value;
    }
  }
  return values;
}

function blockLoop(ms: number): void {
  const startedAt = performance.now();
  while (performance.now() - startedAt < ms) {
    // Busy-wait: the synchronous stall the metric exists to expose.
  }
}

describe("event-loop delay metrics", () => {
  afterEach(() => {
    stopEventLoopDelayMetrics();
  });

  test("exports the worst stall since the last collection, then resets", async () => {
    const reader = new CollectingReader();
    const provider = new MeterProvider({ readers: [reader] });
    startEventLoopDelayMetrics(provider.getMeter("test"));

    // Let the histogram take baseline samples, then freeze the loop.
    await Bun.sleep(50);
    blockLoop(300);
    await Bun.sleep(30);

    const first = await gaugeValues(reader);
    expect(first["nodejs.eventloop.delay.max"]).toBeGreaterThan(0.25);
    expect(first["nodejs.eventloop.delay.p50"]).toBeLessThan(0.25);

    // The stall was reported once; the next interval starts clean.
    await Bun.sleep(50);
    const second = await gaugeValues(reader);
    expect(second["nodejs.eventloop.delay.max"]).toBeLessThan(0.25);

    await provider.shutdown();
  });
});

describe("console log bridge", () => {
  const emitted: LogRecord[] = [];
  const emit = mock((record: LogRecord) => {
    emitted.push(record);
  });

  afterEach(() => {
    uninstallConsoleLogBridge();
    logs.disable();
    emitted.length = 0;
    emit.mockClear();
  });

  test("mirrors console lines as scrubbed log records and still writes to the console", () => {
    logs.setGlobalLoggerProvider({ getLogger: () => ({ emit }) });
    const originalWarn = console.warn;
    const printed: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      printed.push(args);
    };
    try {
      installConsoleLogBridge();
      const secret = `sk-ant-api03-${"a".repeat(90)}`;
      console.warn("[db-client] slow statement %dms token=%s", 250, secret);

      expect(printed).toHaveLength(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.severityNumber).toBe(SeverityNumber.WARN);
      expect(emitted[0]?.severityText).toBe("WARN");
      expect(String(emitted[0]?.body)).toContain("slow statement 250ms");
      expect(String(emitted[0]?.body)).not.toContain(secret);
    } finally {
      uninstallConsoleLogBridge();
      console.warn = originalWarn;
    }
  });
});
