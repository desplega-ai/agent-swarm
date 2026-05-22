export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
export type Attributes = Record<string, AttributeValue | undefined>;

type SpanStatus = {
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

const enabled = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

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
let realStartSpan: ((name: string, attributes?: Attributes) => SwarmSpan) | undefined;
let realWithRemoteContext:
  | (<T>(carrier: Record<string, unknown>, fn: () => Promise<T> | T) => Promise<T>)
  | undefined;
let realWithSpanContext: (<T>(span: SwarmSpan, fn: () => T) => T) | undefined;
let realInjectTraceContext:
  | ((headers: Record<string, string>) => Record<string, string>)
  | undefined;
let realShutdown: (() => Promise<void>) | undefined;

export function isOtelEnabled(): boolean {
  return enabled;
}

export function isPollTracingEnabled(): boolean {
  const v = (process.env.OTEL_TRACE_POLL ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export async function initOtel(serviceRole = process.env.AGENT_ROLE || "api"): Promise<void> {
  if (!enabled || initialized) return;
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
  if (!enabled || !realWithSpan) {
    return fn(NOOP_SPAN);
  }
  return realWithSpan(name, fn, attributes);
}

export function startSpan(name: string, attributes?: Attributes): SwarmSpan {
  if (!enabled || !realStartSpan) {
    return NOOP_SPAN;
  }
  return realStartSpan(name, attributes);
}

export function withSpanContext<T>(span: SwarmSpan, fn: () => T): T {
  if (!enabled || !realWithSpanContext) {
    return fn();
  }
  return realWithSpanContext(span, fn);
}

export async function withRemoteContext<T>(
  carrier: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!enabled || !realWithRemoteContext) {
    return fn();
  }
  return realWithRemoteContext(carrier, fn);
}

export function injectTraceContext(headers: Record<string, string>): Record<string, string> {
  if (!enabled || !realInjectTraceContext) {
    return headers;
  }
  return realInjectTraceContext(headers);
}

export async function shutdownOtel(): Promise<void> {
  if (!realShutdown) return;
  await realShutdown();
}

export function _resetOtelForTests() {
  initialized = false;
  realWithSpan = undefined;
  realStartSpan = undefined;
  realWithRemoteContext = undefined;
  realWithSpanContext = undefined;
  realInjectTraceContext = undefined;
  realShutdown = undefined;
}
