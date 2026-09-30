/**
 * Typed view of the telemetry event catalog (`desplega-ai/proxy`).
 *
 * `types.gen.ts`, `catalog.json` and `EVENTS.md` are vendored verbatim from the
 * proxy at the commit pinned in `../SOURCE.json`. Never hand-edit them: change
 * the catalog in the proxy, merge it, then run
 * `bun run sync:telemetry-contract <commit-sha>`. `bun run check:telemetry-contract`
 * verifies the copies offline.
 */
import type { components } from "./types.gen.ts";

type Schemas = components["schemas"];

/** Every catalogued event of every product, discriminated by `product` + `event`. */
export type CatalogEvent = Schemas["CatalogEvent"];

/** A product that has catalogued events (`agent-swarm`, `agent-fs`). */
export type TelemetryProduct = CatalogEvent["product"];

/** Catalogued event names of one product, such as `task.created`. */
export type TelemetryEventName<P extends TelemetryProduct> = Extract<
  CatalogEvent,
  { product: P }
>["event"];

/**
 * The `properties` an event accepts. An unknown property fails to compile.
 * Both products emit a `server.started`, so the product picks which one.
 */
export type PropsFor<
  E extends TelemetryEventName<P>,
  P extends TelemetryProduct = "agent-swarm",
> = Extract<CatalogEvent, { product: P; event: E }>["properties"];

/** The v2 identity envelope carried in the top-level `context` field. */
export type EventContext = Schemas["EventContext"];

/** The surface that started a chain of work (`slack`, `ui`, `mcp`, `system`, ...). */
export type TriggerSurface = Schemas["TriggerSurface"];

/** Every accepted `trigger_surface` value, in catalog order. */
export const TRIGGER_SURFACES = [
  "slack",
  "ui",
  "api",
  "mcp",
  "github",
  "gitlab",
  "linear",
  "jira",
  "agentmail",
  "schedule",
  "workflow",
  "system",
  "other",
] as const satisfies readonly TriggerSurface[];

// Compile error if the catalog adds a surface that TRIGGER_SURFACES lacks.
type MissingSurface = Exclude<TriggerSurface, (typeof TRIGGER_SURFACES)[number]>;
export const _allSurfacesListed: [MissingSurface] extends [never] ? true : never = true;
