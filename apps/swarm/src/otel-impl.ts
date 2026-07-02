import {
  type Counter,
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
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
import pkg from "../../../package.json";
import type { SwarmSpan } from "./otel";
import { scrubSecrets } from "./utils/secret-scrubber";

type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
type Attributes = Record<string, AttributeValue | undefined>;

const TRACER_NAME = "agent-swarm";
const METER_NAME = "agent-swarm";
const RAW_SPAN = Symbol("agent-swarm.raw-span");

let sdk: NodeSDK | undefined;
let costCounter: Counter | undefined;
let tokenCounter: Counter | undefined;

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

export async function boot(serviceRole: string): Promise<void> {
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
  await sdk?.shutdown();
  sdk = undefined;
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

export function startSpan(name: string, attributes?: Attributes): SwarmSpan {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, {
    attributes: cleanAttributes(attributes),
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
  for (const [token_type, n] of Object.entries(m.tokens)) {
    if (Number.isFinite(n) && n > 0) {
      tokenCounter!.add(n, { ...attrs, token_type });
    }
  }
}

export function _injectCountersForTests(
  cost: Counter | undefined,
  token: Counter | undefined,
): void {
  costCounter = cost;
  tokenCounter = token;
}
