// @swarm/otel — OpenTelemetry facade + telemetry + error tracking.
// otel.ts is the public, no-op-guarded facade; otel-impl.ts is the dynamically-loaded
// real implementation and shares fn names (withSpan/startSpan/…) with the facade. We
// flatten the FACADE (what every consumer uses) and re-export only otel-impl's
// non-colliding, impl-only symbols explicitly.
export * from "./src/otel";
export { boot, resolveServiceName, scrubOtelException, scrubOtelStatus, shutdown } from "./src/otel-impl";
export * from "./src/telemetry";
export * from "./src/utils/error-tracker";
