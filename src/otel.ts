export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
export type Attributes = Record<string, AttributeValue | undefined>;

export type SpanStatus = {
  code: number;
  message?: string;
};

export type SwarmSpan = {
  setAttribute: (key: string, value: AttributeValue) => SwarmSpan;
  setAttributes: (attributes: Attributes) => SwarmSpan;
  addEvent: (name: string, attributes?: Attributes) => SwarmSpan;
  recordException: (error: unknown) => void;
  setStatus: (status: SpanStatus) => SwarmSpan;
  end: () => void;
};

// Backend-agnostic mirror of OTel's `SpanKind`. Kept as a string union (not a
// value import of `@opentelemetry/api`) so this dependency-free module, loaded
// by every worker process, never eagerly pulls in the OTel API. `otel-impl.ts`
// maps this onto the real `SpanKind` only when OTLP is configured.
export type SwarmSpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export interface SpanOptions {
  kind?: SwarmSpanKind;
}

// eslint-disable-next-line import/no-duplicates -- type-only import, no side-effects
import type { SessionCostMetric } from "./otel-impl";
export type { SessionCostMetric };

export interface DbRetentionSweepMetric {
  table: string;
  dryRun: boolean;
  outcome: "converged" | "budget_exhausted" | "error";
  rowsDeleted: number;
  backlogRemaining: number;
  batches: number;
  tableDurationMs: number;
  slowestStatementMs: number;
  batchSize: number;
}

/**
 * Whether OTLP export is configured.
 *
 * Read DYNAMICALLY, not captured at module load: `src/http/index.ts` and
 * `src/commands/runner.ts` both import this module at the top of their graph,
 * which runs before `loadGlobalConfigsIntoEnv()` hydrates `swarm_config` into
 * `process.env`. A module-level const meant a DB-saved
 * `OTEL_EXPORTER_OTLP_ENDPOINT` could never enable tracing — not even after a
 * restart. `initOtel()` is invoked post-hydration, so a dynamic read makes the
 * setting genuinely effective on restart (and on reload, before init).
 */
function otelConfigured(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

const NOOP_SPAN: SwarmSpan = {
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  recordException: () => {},
  setStatus: () => NOOP_SPAN,
  end: () => {},
};

let initialized = false;
let realWithSpan:
  | (<T>(
      name: string,
      fn: (span: SwarmSpan) => Promise<T> | T,
      attributes?: Attributes,
    ) => Promise<T>)
  | undefined;
let realStartSpan:
  | ((name: string, attributes?: Attributes, options?: SpanOptions) => SwarmSpan)
  | undefined;
let realWithRemoteContext:
  | (<T>(carrier: Record<string, unknown>, fn: () => Promise<T> | T) => Promise<T>)
  | undefined;
let realWithSpanContext: (<T>(span: SwarmSpan, fn: () => T) => T) | undefined;
let realInjectTraceContext:
  | ((headers: Record<string, string>) => Record<string, string>)
  | undefined;
let realShutdown: (() => Promise<void>) | undefined;
let realRecordSessionCost: ((m: SessionCostMetric) => void) | undefined;
let realRecordDbRetentionSweep: ((m: DbRetentionSweepMetric) => void) | undefined;
let realRecordDbRetentionStatement:
  | ((table: string, dryRun: boolean, durationMs: number) => void)
  | undefined;

export function isOtelEnabled(): boolean {
  return otelConfigured();
}

export function isPollTracingEnabled(): boolean {
  const v = (process.env.OTEL_TRACE_POLL ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export async function initOtel(serviceRole = process.env.AGENT_ROLE || "api"): Promise<void> {
  if (!otelConfigured() || initialized) return;
  initialized = true;

  try {
    const impl = await import("./otel-impl");
    await impl.boot(serviceRole);
    realWithSpan = impl.withSpan;
    realStartSpan = impl.startSpan;
    realWithRemoteContext = impl.withRemoteContext;
    realWithSpanContext = impl.withSpanContext;
    realInjectTraceContext = impl.injectTraceContext;
    realShutdown = impl.shutdown;
    realRecordSessionCost = impl.recordSessionCost;
    realRecordDbRetentionSweep = impl.recordDbRetentionSweep;
    realRecordDbRetentionStatement = impl.recordDbRetentionStatement;
    console.log(`[OTel] enabled for ${impl.resolveServiceName(serviceRole)} (${serviceRole})`);
  } catch (error) {
    console.warn(`[OTel] disabled after initialization failure: ${error}`);
  }
}

export async function withSpan<T>(
  name: string,
  fn: (span: SwarmSpan) => Promise<T> | T,
  attributes?: Attributes,
): Promise<T> {
  if (!otelConfigured() || !realWithSpan) {
    return fn(NOOP_SPAN);
  }
  return realWithSpan(name, fn, attributes);
}

export function startSpan(name: string, attributes?: Attributes, options?: SpanOptions): SwarmSpan {
  if (!otelConfigured() || !realStartSpan) {
    return NOOP_SPAN;
  }
  return realStartSpan(name, attributes, options);
}

export function withSpanContext<T>(span: SwarmSpan, fn: () => T): T {
  if (!otelConfigured() || !realWithSpanContext) {
    return fn();
  }
  return realWithSpanContext(span, fn);
}

export async function withRemoteContext<T>(
  carrier: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!otelConfigured() || !realWithRemoteContext) {
    return fn();
  }
  return realWithRemoteContext(carrier, fn);
}

export function injectTraceContext(headers: Record<string, string>): Record<string, string> {
  if (!otelConfigured() || !realInjectTraceContext) {
    return headers;
  }
  return realInjectTraceContext(headers);
}

export async function shutdownOtel(): Promise<void> {
  if (!realShutdown) return;
  await realShutdown();
}

export function recordSessionCost(m: SessionCostMetric): void {
  if (!otelConfigured() || !realRecordSessionCost) return;
  realRecordSessionCost(m);
}

export function recordDbRetentionSweep(m: DbRetentionSweepMetric): void {
  if (!otelConfigured() || !realRecordDbRetentionSweep) return;
  realRecordDbRetentionSweep(m);
}

export function recordDbRetentionStatement(
  table: string,
  dryRun: boolean,
  durationMs: number,
): void {
  if (!otelConfigured() || !realRecordDbRetentionStatement) return;
  realRecordDbRetentionStatement(table, dryRun, durationMs);
}

export function _resetOtelForTests() {
  initialized = false;
  realWithSpan = undefined;
  realStartSpan = undefined;
  realWithRemoteContext = undefined;
  realWithSpanContext = undefined;
  realInjectTraceContext = undefined;
  realShutdown = undefined;
  realRecordSessionCost = undefined;
  realRecordDbRetentionSweep = undefined;
  realRecordDbRetentionStatement = undefined;
}
