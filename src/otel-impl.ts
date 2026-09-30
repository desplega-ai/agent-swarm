import { monitorEventLoopDelay } from "node:perf_hooks";
import { format } from "node:util";
import {
  type BatchObservableResult,
  type Counter,
  context,
  type Gauge,
  type Histogram,
  type Meter,
  metrics,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  hostDetector,
  osDetector,
  processDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import pkg from "../package.json";
import type { DbRetentionSweepMetric, SpanOptions, SwarmSpan, SwarmSpanKind } from "./otel";
import { scrubSecrets } from "./utils/secret-scrubber";

type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
type Attributes = Record<string, AttributeValue | undefined>;

const TRACER_NAME = "agent-swarm";
const METER_NAME = "agent-swarm";
const RAW_SPAN = Symbol("agent-swarm.raw-span");

let sdk: NodeSDK | undefined;
let costCounter: Counter | undefined;
let tokenCounter: Counter | undefined;
let costDriftCounter: Counter | undefined;
let retentionSweepCounter: Counter | undefined;
let retentionRowsDeletedCounter: Counter | undefined;
let retentionBacklogGauge: Gauge | undefined;
let retentionBatchesCounter: Counter | undefined;
let retentionTableDurationHistogram: Histogram | undefined;
let retentionSlowestStatementGauge: Gauge | undefined;
let retentionStatementDurationHistogram: Histogram | undefined;
let retentionBatchSizeGauge: Gauge | undefined;
let slackReactionInvalidNameCounter: Counter | undefined;

function decodeResourceAttributeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseResourceAttributes(value = process.env.OTEL_RESOURCE_ATTRIBUTES): Attributes {
  if (!value) return {};
  const attributes: Attributes = {};
  for (const pair of value.split(",")) {
    const [rawKey, ...rawValueParts] = pair.split("=");
    const key = rawKey?.trim();
    if (!key) continue;
    const rawValue = rawValueParts.join("=").trim();
    if (!rawValue) continue;
    attributes[key] = decodeResourceAttributeValue(rawValue);
  }
  return attributes;
}

function cleanAttributes(attributes?: Attributes): Record<string, AttributeValue> | undefined {
  if (!attributes) return undefined;
  const cleaned: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

export function scrubOtelException(error: unknown): Error | string {
  if (!(error instanceof Error)) {
    return scrubSecrets(String(error));
  }

  const scrubbed = new Error(scrubSecrets(error.message));
  scrubbed.name = error.name;
  if (error.stack) {
    scrubbed.stack = scrubSecrets(error.stack);
  }
  return scrubbed;
}

export function scrubOtelStatus(status: { code: number; message?: string }) {
  return status.message === undefined
    ? status
    : {
        ...status,
        message: scrubSecrets(status.message),
      };
}

type AdaptedSwarmSpan = SwarmSpan & { [RAW_SPAN]: Span };

function spanAdapter(span: Span): AdaptedSwarmSpan {
  return {
    [RAW_SPAN]: span,
    setAttribute(key, value) {
      span.setAttribute(key, value);
      return this;
    },
    setAttributes(attributes) {
      const cleaned = cleanAttributes(attributes);
      if (cleaned) span.setAttributes(cleaned);
      return this;
    },
    addEvent(name, attributes) {
      const cleaned = cleanAttributes(attributes);
      span.addEvent(name, cleaned);
      return this;
    },
    recordException(error) {
      span.recordException(scrubOtelException(error));
    },
    setStatus(status) {
      span.setStatus(scrubOtelStatus(status));
      return this;
    },
    end() {
      span.end();
    },
  };
}

/**
 * Resolve the OTel `service.name` for a process, scoped by its role so the API
 * and worker processes are distinguishable in SigNoz:
 *
 * - `api`  → `agent-swarm-api`
 * - worker → `agent-swarm` (unchanged)
 *
 * `OTEL_SERVICE_NAME` (set identically across processes in our compose/deploy
 * env) is treated as the base name — the `-api` suffix is still appended for the
 * API role so a shared env var can't collapse both processes onto one name.
 */
export function resolveServiceName(serviceRole: string): string {
  const baseServiceName = process.env.OTEL_SERVICE_NAME || "agent-swarm";
  return serviceRole === "api" ? `${baseServiceName}-api` : baseServiceName;
}

export interface BootOptions {
  /** Mirror console output into OTel log records (API role only). */
  exportConsoleLogs?: boolean;
}

export async function boot(serviceRole: string, options: BootOptions = {}): Promise<void> {
  if (sdk) return;

  const configuredResourceAttributes = parseResourceAttributes();
  const deploymentEnvironment =
    configuredResourceAttributes["deployment.environment"] || process.env.NODE_ENV || "development";
  const serviceName = resolveServiceName(serviceRole);
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      ...configuredResourceAttributes,
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: pkg.version,
      "service.namespace": configuredResourceAttributes["service.namespace"] || "agent-swarm",
      "service.instance.id": process.env.AGENT_ID || crypto.randomUUID(),
      "deployment.environment": deploymentEnvironment,
      env: configuredResourceAttributes.env || deploymentEnvironment,
      "agentswarm.service.role": serviceRole,
    }),
    // NodeSDK's default resource detectors include `envDetector`, which reads
    // `OTEL_SERVICE_NAME` (and `OTEL_RESOURCE_ATTRIBUTES`) straight from the
    // process env — and NodeSDK merges detected attributes *over* the
    // configured resource, so a detected `service.name` overwrites the
    // per-role name computed by `resolveServiceName()`. Our deploy sets one
    // shared `OTEL_SERVICE_NAME` on every process, so that merge silently
    // collapsed the API and worker back onto a single `service.name`. Pin the
    // detector list to host/os/process and drop `envDetector`: the resource
    // configured above (service.name, service.instance.id, and the manually
    // parsed `OTEL_RESOURCE_ATTRIBUTES`) then stays authoritative.
    resourceDetectors: [hostDetector, osDetector, processDetector],
    traceExporter: new OTLPTraceExporter(),
    // Metrics: export on the same OTLP pipeline as traces so both signals share
    // the same resource (service.name, agentswarm.service.role, etc.). Temporality
    // is intentionally NOT hardcoded — operators should set
    // OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta for Datadog.
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 60_000,
    }),
  });

  sdk.start();

  if (serviceRole === "api") {
    startEventLoopDelayMetrics(metrics.getMeter(METER_NAME));
    // NodeSDK already registers a global LoggerProvider exporting over OTLP
    // to the same endpoint and resource as traces (OTEL_LOGS_EXPORTER
    // defaults to otlp); nothing feeds it until the bridge is installed.
    if (options.exportConsoleLogs) installConsoleLogBridge();
  }

  const shutdown = async () => {
    try {
      await sdk?.shutdown();
    } catch {
      // Best-effort flush during process shutdown.
    }
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export async function shutdown(): Promise<void> {
  // SDK first: its final flush still reads the event-loop gauges and drains
  // bridged log records.
  await sdk?.shutdown();
  sdk = undefined;
  stopEventLoopDelayMetrics();
  uninstallConsoleLogBridge();
}

let stopEventLoopDelay: (() => void) | undefined;

/**
 * Event-loop delay from `perf_hooks.monitorEventLoopDelay`, exported as the
 * semconv `nodejs.eventloop.delay.*` gauges (seconds). Each collection reads
 * the histogram and resets it, so `max` is the worst stall since the last
 * export. Server spans only start once the loop frees, so a stall never shows
 * in span durations: a request queued behind a 3s synchronous query still
 * reports a 14ms span. This metric is what sees the stall.
 */
export function startEventLoopDelayMetrics(meter: Meter): void {
  if (stopEventLoopDelay) return;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const gauges = {
    min: meter.createObservableGauge("nodejs.eventloop.delay.min", {
      description: "Minimum event loop delay since the last export",
      unit: "s",
    }),
    max: meter.createObservableGauge("nodejs.eventloop.delay.max", {
      description: "Maximum event loop delay since the last export: the longest stall",
      unit: "s",
    }),
    mean: meter.createObservableGauge("nodejs.eventloop.delay.mean", {
      description: "Mean event loop delay since the last export",
      unit: "s",
    }),
    p50: meter.createObservableGauge("nodejs.eventloop.delay.p50", {
      description: "50th percentile event loop delay since the last export",
      unit: "s",
    }),
    p90: meter.createObservableGauge("nodejs.eventloop.delay.p90", {
      description: "90th percentile event loop delay since the last export",
      unit: "s",
    }),
    p99: meter.createObservableGauge("nodejs.eventloop.delay.p99", {
      description: "99th percentile event loop delay since the last export",
      unit: "s",
    }),
  };
  const seconds = (ns: number) => ns / 1e9;
  const collect = (observer: BatchObservableResult) => {
    // No sample yet (first interval shorter than the resolution): the
    // histogram's min is a sentinel then, so report nothing.
    if (histogram.count === 0) return;
    observer.observe(gauges.min, seconds(histogram.min));
    observer.observe(gauges.max, seconds(histogram.max));
    observer.observe(gauges.mean, seconds(histogram.mean));
    observer.observe(gauges.p50, seconds(histogram.percentile(50)));
    observer.observe(gauges.p90, seconds(histogram.percentile(90)));
    observer.observe(gauges.p99, seconds(histogram.percentile(99)));
    histogram.reset();
  };
  const observables = Object.values(gauges);
  meter.addBatchObservableCallback(collect, observables);
  stopEventLoopDelay = () => {
    meter.removeBatchObservableCallback(collect, observables);
    histogram.disable();
    stopEventLoopDelay = undefined;
  };
}

export function stopEventLoopDelayMetrics(): void {
  stopEventLoopDelay?.();
}

const CONSOLE_LOG_BODY_MAX_CHARS = 16_384;
const CONSOLE_SEVERITY = {
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  log: { number: SeverityNumber.INFO, text: "INFO" },
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
} as const;
type ConsoleMethod = keyof typeof CONSOLE_SEVERITY;

let restoreConsole: (() => void) | undefined;

/**
 * Mirror console output into OTel log records (opt-in: OTEL_EXPORT_API_LOGS).
 * stdout/stderr stay the primary sink; each line is also emitted to the
 * global LoggerProvider, scrubbed at this egress point and correlated with
 * the active span.
 */
export function installConsoleLogBridge(): void {
  if (restoreConsole) return;
  const logger = logs.getLogger(METER_NAME);
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let emitting = false;
  for (const method of Object.keys(CONSOLE_SEVERITY) as ConsoleMethod[]) {
    const original = console[method].bind(console);
    originals.set(method, console[method]);
    console[method] = (...args: unknown[]) => {
      original(...args);
      // An exporter or scrubber that logs must not recurse into itself.
      if (emitting) return;
      emitting = true;
      try {
        // Scrub before truncating so a cut can never split a secret into an
        // unrecognizable fragment.
        const text = scrubSecrets(format(...args));
        const body =
          text.length > CONSOLE_LOG_BODY_MAX_CHARS
            ? `${text.slice(0, CONSOLE_LOG_BODY_MAX_CHARS)}…`
            : text;
        logger.emit({
          severityNumber: CONSOLE_SEVERITY[method].number,
          severityText: CONSOLE_SEVERITY[method].text,
          body,
          attributes: { "log.source": "console" },
        });
      } catch {
        // Log export is best-effort; never break the caller's console call.
      } finally {
        emitting = false;
      }
    };
  }
  restoreConsole = () => {
    for (const [method, original] of originals) console[method] = original;
    restoreConsole = undefined;
  };
}

export function uninstallConsoleLogBridge(): void {
  restoreConsole?.();
}

export async function withSpan<T>(
  name: string,
  fn: (span: SwarmSpan) => Promise<T> | T,
  attributes?: Attributes,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes: cleanAttributes(attributes) }, async (span) => {
    try {
      const result = await fn(spanAdapter(span));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(scrubOtelException(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: scrubSecrets(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

const SPAN_KIND_MAP: Record<SwarmSpanKind, SpanKind> = {
  internal: SpanKind.INTERNAL,
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
};

let tracerOverrideForTests: Tracer | undefined;

export function startSpan(name: string, attributes?: Attributes, options?: SpanOptions): SwarmSpan {
  const tracer = tracerOverrideForTests ?? trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan(name, {
    attributes: cleanAttributes(attributes),
    kind: options?.kind ? SPAN_KIND_MAP[options.kind] : undefined,
  });
  return spanAdapter(span);
}

export function withSpanContext<T>(span: SwarmSpan, fn: () => T): T {
  const rawSpan = (span as Partial<AdaptedSwarmSpan>)[RAW_SPAN];
  if (!rawSpan) return fn();
  return context.with(trace.setSpan(context.active(), rawSpan), fn);
}

export async function withRemoteContext<T>(
  carrier: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const remoteContext = propagation.extract(ROOT_CONTEXT, carrier);
  return context.with(remoteContext, fn);
}

export function injectTraceContext(headers: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}

export interface SessionCostMetric {
  totalCostUsd: number;
  harnessCostUsd?: number;
  harness: string;
  model: string;
  costSource: string;
  isError: boolean;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    thinking: number;
  };
}

function ensureInstruments(): void {
  if (costCounter) return;
  const meter = metrics.getMeter(METER_NAME);
  costCounter = meter.createCounter("agentswarm.cost.usd", {
    description: "USD cost per finalized cost record",
    unit: "{usd}",
  });
  tokenCounter = meter.createCounter("agentswarm.tokens", {
    description: "Tokens per finalized cost record",
    unit: "{token}",
  });
  costDriftCounter = meter.createCounter("agentswarm.cost.drift.usd", {
    description: "Absolute USD drift between stored and harness-reported session costs",
    unit: "{usd}",
  });
  retentionSweepCounter = meter.createCounter("agentswarm.db.retention.sweeps", {
    description: "One point per table attempt per tick, tagged with the terminal outcome",
    unit: "{sweep}",
  });
  retentionRowsDeletedCounter = meter.createCounter("agentswarm.db.retention.rows_deleted", {
    description: "Rows deleted per table per tick (always 0 in dry run)",
    unit: "{row}",
  });
  retentionBacklogGauge = meter.createGauge("agentswarm.db.retention.backlog", {
    description: "Rows still older than the horizon at the end of a table's slice",
    unit: "{row}",
  });
  retentionBatchesCounter = meter.createCounter("agentswarm.db.retention.batches", {
    description: "DELETE statements issued per table per tick",
    unit: "{batch}",
  });
  retentionTableDurationHistogram = meter.createHistogram(
    "agentswarm.db.retention.table_duration_ms",
    {
      description: "Wall clock of one table's slice",
      unit: "ms",
    },
  );
  retentionSlowestStatementGauge = meter.createGauge(
    "agentswarm.db.retention.slowest_statement_ms",
    {
      description: "Slowest single DELETE in a table's slice — the event-loop stall signal",
      unit: "ms",
    },
  );
  retentionStatementDurationHistogram = meter.createHistogram(
    "agentswarm.db.retention.statement_duration_ms",
    {
      description: "Distribution of individual DELETE statement durations",
      unit: "ms",
    },
  );
  retentionBatchSizeGauge = meter.createGauge("agentswarm.db.retention.batch_size", {
    description: "The adaptive batch size a table settled on for a tick",
    unit: "{row}",
  });
  slackReactionInvalidNameCounter = meter.createCounter("agentswarm.slack.reaction.invalid_name", {
    description: "Slack rejected a configured reaction shortcode with invalid_name",
    unit: "{reaction}",
  });
}

export function recordSessionCost(m: SessionCostMetric): void {
  ensureInstruments();
  // Scrub all free-form string attributes before they reach the OTLP exporter.
  // `model` comes from the /api/session-costs request body and may contain
  // arbitrary operator-supplied text; scrubbing prevents accidental secret egress.
  const attrs = {
    harness: scrubSecrets(m.harness || "unknown"),
    model: scrubSecrets(m.model || "unknown"),
    cost_source: scrubSecrets(m.costSource || "unknown"),
    is_error: m.isError,
  };
  if (Number.isFinite(m.totalCostUsd) && m.totalCostUsd > 0) {
    costCounter!.add(m.totalCostUsd, attrs);
  }
  // A harness-reported $0 is a valid claim, not a missing value: codex workers
  // deliberately report $0 when their local pricing snapshot doesn't know the
  // model (computeCodexCostUsd), and a positive server recompute against that
  // is exactly the stale-snapshot divergence this metric exists to surface.
  // Only absent/non-finite harness values are excluded.
  if (Number.isFinite(m.totalCostUsd) && Number.isFinite(m.harnessCostUsd)) {
    const drift = m.totalCostUsd - m.harnessCostUsd!;
    // Zero drift carries no signal — harness/unpriced rows echo the harness
    // number back verbatim, and recording them would flood the metric with
    // empty "under" points. Only genuine recompute divergence is emitted.
    if (drift !== 0) {
      costDriftCounter?.add(Math.abs(drift), {
        ...attrs,
        drift_sign: drift > 0 ? "over" : "under",
      });
    }
  }
  for (const [token_type, n] of Object.entries(m.tokens)) {
    if (Number.isFinite(n) && n > 0) {
      tokenCounter!.add(n, { ...attrs, token_type });
    }
  }
}

export function recordDbRetentionSweep(m: DbRetentionSweepMetric): void {
  ensureInstruments();
  // Table names are code literals from the closed descriptor list in
  // src/be/db-retention.ts, not operator input, so no scrubbing is needed.
  const outcomeAttrs = { table: m.table, dry_run: m.dryRun, outcome: m.outcome };
  const tableAttrs = { table: m.table, dry_run: m.dryRun };
  retentionSweepCounter!.add(1, outcomeAttrs);
  retentionRowsDeletedCounter!.add(m.rowsDeleted, tableAttrs);
  retentionBacklogGauge!.record(m.backlogRemaining, tableAttrs);
  retentionBatchesCounter!.add(m.batches, tableAttrs);
  retentionTableDurationHistogram!.record(m.tableDurationMs, outcomeAttrs);
  retentionSlowestStatementGauge!.record(m.slowestStatementMs, tableAttrs);
  retentionBatchSizeGauge!.record(m.batchSize, tableAttrs);
}

export function recordDbRetentionStatement(
  table: string,
  dryRun: boolean,
  durationMs: number,
): void {
  ensureInstruments();
  retentionStatementDurationHistogram!.record(durationMs, { table, dry_run: dryRun });
}

export function recordSlackReactionInvalidName(event: string): void {
  ensureInstruments();
  // `event` is one of the 6 known SlackReactionEvent literals or "unknown" —
  // bounded cardinality. The operator-configured shortcode that was rejected
  // must never become a metric label (unbounded) or reach this attribute set;
  // callers log it separately, through the secret scrubber.
  slackReactionInvalidNameCounter!.add(1, { event, verdict: "invalid_name" });
}

export function _injectCountersForTests(
  cost: Counter | undefined,
  token: Counter | undefined,
  drift?: Counter | undefined,
): void {
  costCounter = cost;
  tokenCounter = token;
  costDriftCounter = drift;
}

export function _injectRetentionInstrumentsForTests(instruments: {
  sweeps?: Counter;
  rowsDeleted?: Counter;
  backlog?: Gauge;
  batches?: Counter;
  tableDuration?: Histogram;
  slowestStatement?: Gauge;
  statementDuration?: Histogram;
  batchSize?: Gauge;
}): void {
  retentionSweepCounter = instruments.sweeps;
  retentionRowsDeletedCounter = instruments.rowsDeleted;
  retentionBacklogGauge = instruments.backlog;
  retentionBatchesCounter = instruments.batches;
  retentionTableDurationHistogram = instruments.tableDuration;
  retentionSlowestStatementGauge = instruments.slowestStatement;
  retentionStatementDurationHistogram = instruments.statementDuration;
  retentionBatchSizeGauge = instruments.batchSize;
}

export function _injectTracerForTests(tracer: Tracer | undefined): void {
  tracerOverrideForTests = tracer;
}
