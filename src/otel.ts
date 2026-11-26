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

import type { PostgresStats } from "@desplega/storage";
import type { SwarmStateStats } from "./be/swarm-state-stats";
// eslint-disable-next-line import/no-duplicates -- type-only import, no side-effects
import type { SessionCostMetric } from "./otel-impl";
export type { SessionCostMetric };

export type DbSystem = "sqlite" | "postgresql";

export interface DbStatementMetric {
  system: DbSystem;
  sql: string;
  durationMs: number;
}

export interface DbTransactionMetric {
  system: DbSystem;
  attempts: number;
  retries: readonly string[];
  outcome: "commit" | "rollback" | "exhausted";
}

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
let realRecordSlackReactionInvalidName: ((event: string) => void) | undefined;
let realRecordDbStatement: ((m: DbStatementMetric) => void) | undefined;
let realRecordDbTransaction: ((m: DbTransactionMetric) => void) | undefined;
let realStartPostgresStatsMetrics:
  | ((read: () => Promise<PostgresStats | null>) => void)
  | undefined;
let realStartSwarmStateMetrics: ((read: () => Promise<SwarmStateStats>) => void) | undefined;

export function isOtelEnabled(): boolean {
  return otelConfigured();
}

function envFlagEnabled(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isPollTracingEnabled(): boolean {
  return envFlagEnabled("OTEL_TRACE_POLL");
}

/** A span per database statement under the request span. Off by default: high volume. */
export function isDbStatementTracingEnabled(): boolean {
  return envFlagEnabled("OTEL_TRACE_DB_STATEMENTS");
}

/** Mirror the API's console output to the OTLP collector as log records. Off by default. */
export function isApiLogExportEnabled(): boolean {
  return envFlagEnabled("OTEL_EXPORT_API_LOGS");
}

/**
 * The API's Postgres `pg_stat_*` gauges. On by default: only `OTEL_PG_METRICS`
 * set to false, 0, no or off turns them off. A no-op on SQLite either way.
 */
export function isPgMetricsEnabled(): boolean {
  const v = (process.env.OTEL_PG_METRICS ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * The API's swarm state gauges (failed tasks, approvals, queue). On by default:
 * only `OTEL_SWARM_METRICS` set to false, 0, no or off turns them off.
 */
export function isSwarmMetricsEnabled(): boolean {
  const v = (process.env.OTEL_SWARM_METRICS ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

export async function initOtel(serviceRole = process.env.AGENT_ROLE || "api"): Promise<void> {
  if (!otelConfigured() || initialized) return;
  initialized = true;

  try {
    const impl = await import("./otel-impl");
    await impl.boot(serviceRole, {
      exportConsoleLogs: serviceRole === "api" && isApiLogExportEnabled(),
    });
    realWithSpan = impl.withSpan;
    realStartSpan = impl.startSpan;
    realWithRemoteContext = impl.withRemoteContext;
    realWithSpanContext = impl.withSpanContext;
    realInjectTraceContext = impl.injectTraceContext;
    realShutdown = impl.shutdown;
    realRecordSessionCost = impl.recordSessionCost;
    realRecordDbRetentionSweep = impl.recordDbRetentionSweep;
    realRecordDbRetentionStatement = impl.recordDbRetentionStatement;
    realRecordSlackReactionInvalidName = impl.recordSlackReactionInvalidName;
    realRecordDbStatement = impl.recordDbStatement;
    realRecordDbTransaction = impl.recordDbTransaction;
    realStartPostgresStatsMetrics = impl.startPostgresStatsMetrics;
    realStartSwarmStateMetrics = impl.startSwarmStateMetrics;
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

export function recordSlackReactionInvalidName(event: string): void {
  if (!otelConfigured() || !realRecordSlackReactionInvalidName) return;
  realRecordSlackReactionInvalidName(event);
}

/**
 * Called after every database statement, so the disabled path is one variable
 * check: no env read, no SQL parsing, no object allocation by the caller.
 */
export function recordDbStatement(system: DbSystem, sql: string, durationMs: number): void {
  if (!realRecordDbStatement || !otelConfigured()) return;
  realRecordDbStatement({ system, sql, durationMs });
}

export function recordDbTransaction(m: DbTransactionMetric): void {
  if (!realRecordDbTransaction || !otelConfigured()) return;
  realRecordDbTransaction(m);
}

/** Register the Postgres gauges over `read` (called once per metric export). No-op without OTLP. */
export function startPostgresStatsMetrics(read: () => Promise<PostgresStats | null>): void {
  if (!realStartPostgresStatsMetrics || !otelConfigured()) return;
  realStartPostgresStatsMetrics(read);
}

/** Register the swarm state gauges over `read` (called once per metric export). No-op without OTLP. */
export function startSwarmStateMetrics(read: () => Promise<SwarmStateStats>): void {
  if (!realStartSwarmStateMetrics || !otelConfigured()) return;
  realStartSwarmStateMetrics(read);
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
  realRecordSlackReactionInvalidName = undefined;
  realRecordDbStatement = undefined;
  realRecordDbTransaction = undefined;
  realStartPostgresStatsMetrics = undefined;
  realStartSwarmStateMetrics = undefined;
}
