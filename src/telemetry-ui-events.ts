/**
 * Which telemetry events the dashboard may ask the API to send, and the
 * runtime check of their properties against the vendored event catalog.
 *
 * The dashboard has no direct line to the telemetry proxy: it posts
 * `{ event, properties }` to `POST /api/telemetry/ui-event`, and the API sends
 * the event with the normal v2 envelope. Pure: no DB, no network.
 */
import catalog from "./telemetry-contract/catalog.json";

interface PropertySpec {
  type?: string;
  ref?: string;
  enum?: string[];
  minimum?: number;
  required?: boolean;
  nullable?: boolean;
  items?: PropertySpec;
}

interface CatalogEntry {
  product: string;
  event: string;
  source: string;
  properties: Record<string, PropertySpec>;
}

// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- generated catalog; its JSON literal types do not match the spec type.
const file = catalog as unknown as {
  definitions: Record<string, PropertySpec>;
  events: CatalogEntry[];
};

/**
 * Events the API relays for the dashboard: every catalog event whose emitter
 * is `ui`, and nothing the catalog attributes to the API server. The route
 * cannot verify a server-attributed claim: `lead.captured` would let any
 * signed-in user invent a consented lead, because the Slack Connect email goes
 * from the browser straight to the feedback proxy, which keeps the lead in
 * feedback_submissions. `used_by.consent_changed` is left out too: the API
 * sends it itself after an admin-only consent change, so a non-admin cannot
 * fake one.
 */
const SERVER_ONLY_UI_EVENTS = new Set(["used_by.consent_changed"]);
/** Longest string property the route relays. Catalog strings are keys and IDs, never prose. */
const MAX_STRING_LENGTH = 200;

const relayable = new Map(
  file.events
    .filter(
      (e) =>
        e.product === "agent-swarm" && e.source === "ui" && !SERVER_ONLY_UI_EVENTS.has(e.event),
    )
    .map((e) => [e.event, e]),
);

/** Names the route accepts, sorted. */
export const UI_EVENT_NAMES: readonly string[] = [...relayable.keys()].sort();

/** The catalog emitter (`source`) of a relayable event, or undefined when it is not relayable. */
export function uiEventEmitter(event: string): string | undefined {
  return relayable.get(event)?.source;
}

function resolveSpec(spec: PropertySpec): PropertySpec {
  const resolved = spec.ref ? { ...file.definitions[spec.ref], ...spec } : spec;
  return resolved.items ? { ...resolved, items: resolveSpec(resolved.items) } : resolved;
}

function typeMatches(type: string | undefined, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    default:
      return true;
  }
}

/**
 * Problems with `properties` for `event`. An empty list means the proxy will
 * accept them. Rejects unknown events, unknown or missing properties, wrong
 * types, values outside an enum, and numbers below a minimum. Common
 * properties (`is_cloud`, ...) are rejected too: the API adds those itself.
 */
export function validateUiEvent(event: string, properties: Record<string, unknown>): string[] {
  const entry = relayable.get(event);
  if (!entry) return [`unknown event "${event}"`];

  const problems: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const raw = entry.properties[key];
    if (!raw) {
      problems.push(`unknown property "${key}"`);
      continue;
    }
    const spec = resolveSpec(raw);
    if (value === null) {
      if (!spec.nullable) problems.push(`"${key}" must not be null`);
      continue;
    }
    if (!typeMatches(spec.type, value)) {
      problems.push(
        `"${key}" must be ${spec.type === "array" ? "an array of strings" : `a ${spec.type}`}`,
      );
      continue;
    }
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
      problems.push(`"${key}" must be at most ${MAX_STRING_LENGTH} characters`);
    }
    if (spec.enum && !spec.enum.includes(value as string)) {
      problems.push(`"${key}" must be one of ${spec.enum.join(", ")}`);
    }
    if (Array.isArray(value) && spec.items?.enum) {
      const allowed = spec.items.enum;
      if (value.some((item) => !allowed.includes(item))) {
        problems.push(`"${key}" items must be one of ${allowed.join(", ")}`);
      }
    }
    if (typeof spec.minimum === "number" && typeof value === "number" && value < spec.minimum) {
      problems.push(`"${key}" must be at least ${spec.minimum}`);
    }
  }
  for (const [key, spec] of Object.entries(entry.properties)) {
    if (spec.required && properties[key] === undefined) {
      problems.push(`missing required property "${key}"`);
    }
  }
  return problems;
}
