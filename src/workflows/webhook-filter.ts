import { WEBHOOK_FILTER_PRESETS, WebhookDeliveryFilterSchema } from "../types";

/**
 * Delivery filter for a webhook trigger.
 *
 * Runs only after signature verification, and a miss must not persist a run.
 * Clauses are AND-ed. `events` / `eventHeader` are a deprecated alias that
 * compiles to one clause (a header, or JSON body `type` for the
 * standard-webhooks preset). `filter` adds header and body clauses.
 * The first miss is the skip reason.
 */

export type WebhookHeaderBag = Record<string, string | string[] | undefined>;

export const WEBHOOK_FILTER_INVALID_MESSAGE = "Webhook trigger filter is invalid";
export const WEBHOOK_PRESET_INVALID_MESSAGE = "Webhook trigger preset is invalid";
export const WEBHOOK_EVENTS_INVALID_MESSAGE = "Webhook trigger events allowlist is invalid";
export const WEBHOOK_EVENT_HEADER_INVALID_MESSAGE = "Webhook trigger eventHeader is invalid";

type FilterScalar = string | number | boolean | null;
type PresetName = (typeof WEBHOOK_FILTER_PRESETS)[number];

type EventSource = { source: "header" | "body"; path: string };

const EVENT_SOURCES: Record<PresetName, EventSource> = {
  github: { source: "header", path: "X-GitHub-Event" },
  gitlab: { source: "header", path: "X-Gitlab-Event" },
  "standard-webhooks": { source: "body", path: "type" },
};

type Clause = EventSource & {
  allowed: readonly FilterScalar[];
  origin: "events" | "filter";
};

export type WebhookDeliverySkip =
  | { skipped: true; reason: "event-not-allowed"; event: string | null }
  | {
      skipped: true;
      reason: "filter-not-matched";
      match: { source: "header" | "body"; path: string };
    };

export type WebhookDeliveryDecision =
  | { action: "allow" }
  | { action: "skip"; skip: WebhookDeliverySkip }
  | { action: "invalid"; message: string };

type DeliveryTrigger = {
  events?: unknown;
  eventHeader?: unknown;
  preset?: unknown;
  filter?: unknown;
};

/** Case-insensitive header name. The first value wins when a header is repeated. */
function headerValue(headers: WebhookHeaderBag, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function isPreset(value: unknown): value is PresetName {
  return typeof value === "string" && (WEBHOOK_FILTER_PRESETS as readonly string[]).includes(value);
}

function listed(value: FilterScalar | readonly FilterScalar[]): readonly FilterScalar[] {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return [value];
  }
  return value;
}

function valueAllowed(value: unknown, allowed: readonly FilterScalar[]): boolean {
  return allowed.some((candidate) => Object.is(candidate, value));
}

/**
 * Dot path. A numeric segment indexes an array (`commits.0.id`, no leading
 * zeros) and is an ordinary key on an object. Inherited properties do not match.
 */
function readBodyPath(
  body: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  let current: unknown = body;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment) || !Object.hasOwn(current, segment)) {
        return { found: false };
      }
      current = current[Number(segment)];
      continue;
    }
    if (current === null || typeof current !== "object") return { found: false };
    if (!Object.hasOwn(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function clauseMatches(clause: Clause, headers: WebhookHeaderBag, body: unknown): boolean {
  if (clause.source === "header") {
    return valueAllowed(headerValue(headers, clause.path), clause.allowed);
  }
  const read = readBodyPath(body, clause.path);
  return read.found && valueAllowed(read.value, clause.allowed);
}

function observedEvent(clause: Clause, headers: WebhookHeaderBag, body: unknown): string | null {
  if (clause.source === "header") return headerValue(headers, clause.path) ?? null;
  const read = readBodyPath(body, clause.path);
  return read.found && typeof read.value === "string" ? read.value : null;
}

function invalid(message: string): WebhookDeliveryDecision {
  return { action: "invalid", message };
}

/**
 * Decide whether a verified delivery may start a run.
 * `body` is the parsed JSON value, or the raw payload when it is not JSON.
 */
export function decideWebhookDelivery(
  trigger: DeliveryTrigger,
  headers: WebhookHeaderBag,
  body: unknown,
): WebhookDeliveryDecision {
  if (trigger.preset !== undefined && !isPreset(trigger.preset)) {
    return invalid(WEBHOOK_PRESET_INVALID_MESSAGE);
  }
  if (
    trigger.eventHeader !== undefined &&
    (typeof trigger.eventHeader !== "string" || trigger.eventHeader.length === 0)
  ) {
    return invalid(WEBHOOK_EVENT_HEADER_INVALID_MESSAGE);
  }
  if (trigger.events != null) {
    if (
      !Array.isArray(trigger.events) ||
      trigger.events.some((event) => typeof event !== "string")
    ) {
      return invalid(WEBHOOK_EVENTS_INVALID_MESSAGE);
    }
  }

  const clauses: Clause[] = [];
  const events = Array.isArray(trigger.events) ? (trigger.events as string[]) : [];
  if (events.length > 0) {
    const preset: PresetName = isPreset(trigger.preset) ? trigger.preset : "github";
    const source: EventSource =
      typeof trigger.eventHeader === "string"
        ? { source: "header", path: trigger.eventHeader }
        : EVENT_SOURCES[preset];
    clauses.push({ ...source, allowed: events, origin: "events" });
  }

  // `null` is a stored JSON value, not an omitted filter. Rows are loaded
  // without re-validating the trigger, so a null filter must fail closed.
  if (trigger.filter !== undefined) {
    const parsed = WebhookDeliveryFilterSchema.safeParse(trigger.filter);
    if (!parsed.success) return invalid(WEBHOOK_FILTER_INVALID_MESSAGE);
    for (const [name, allowed] of Object.entries(parsed.data.headers ?? {})) {
      clauses.push({ source: "header", path: name, allowed: listed(allowed), origin: "filter" });
    }
    for (const [path, allowed] of Object.entries(parsed.data.body ?? {})) {
      clauses.push({ source: "body", path, allowed: listed(allowed), origin: "filter" });
    }
  }

  for (const clause of clauses) {
    if (clauseMatches(clause, headers, body)) continue;
    if (clause.origin === "events") {
      return {
        action: "skip",
        skip: {
          skipped: true,
          reason: "event-not-allowed",
          event: observedEvent(clause, headers, body),
        },
      };
    }
    return {
      action: "skip",
      skip: {
        skipped: true,
        reason: "filter-not-matched",
        match: { source: clause.source, path: clause.path },
      },
    };
  }

  return { action: "allow" };
}
