/**
 * Pure helpers for the schema_version 2 telemetry identity envelope
 * (`context`). No DB, no network: importable from the API server and workers.
 *
 * The envelope is pseudonymous by design. It carries an org ID, an org name
 * the operator chose, the email DOMAIN of the org's admin, and a hashed user
 * reference. It never carries an email address, a user name or a raw user ID.
 */
import { createHash, randomBytes } from "node:crypto";
import { type EventContext, TRIGGER_SURFACES, type TriggerSurface } from "./telemetry-contract";
import catalog from "./telemetry-contract/catalog.json";

/** `org_` + 16 lowercase hex (self-host, minted here) or 27 alphanumerics (cloud). Same pattern the proxy enforces. */
const ORG_ID_PATTERN = /^org_([0-9a-f]{16}|[A-Za-z0-9]{27})$/;
/** Lowercase hostname with at least one dot and no `@`. Same pattern the proxy enforces. */
const ORG_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type TelemetryUserRole = "admin" | "member";

/** Who caused an event. Absent, or with no `userId`, the event carries `user_ref: null`. */
export interface TelemetryActor {
  userId?: string | null;
  role?: TelemetryUserRole | null;
}

/** Map a raw `agent_tasks.source` to the catalog enum. Anything outside it is `other`. */
export function mapTriggerSurface(source: string | null | undefined): TriggerSurface {
  return (TRIGGER_SURFACES as readonly string[]).includes(source ?? "")
    ? (source as TriggerSurface)
    : "other";
}

/** Mint a self-host org ID: `org_` + 16 lowercase hex. */
export function mintOrgId(): string {
  return `org_${randomBytes(8).toString("hex")}`;
}

/** Return `raw` when it is a valid org ID, else undefined. Never throws. */
export function validOrgId(raw: string | null | undefined): string | undefined {
  const value = raw?.trim();
  return value && ORG_ID_PATTERN.test(value) ? value : undefined;
}

/** Return `raw` when it is a valid lowercase hostname, else undefined. Never throws. */
export function validOrgDomain(raw: string | null | undefined): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value && ORG_DOMAIN_PATTERN.test(value) ? value : undefined;
}

/**
 * The domain part of an email address, lowercased. Undefined when the input is
 * not an address with a valid hostname. The local part is never returned.
 */
export function emailDomain(email: string | null | undefined): string | undefined {
  const value = email?.trim();
  if (!value) return undefined;
  const at = value.lastIndexOf("@");
  if (at <= 0) return undefined;
  return validOrgDomain(value.slice(at + 1));
}

/**
 * Pseudonymous user reference: `u_` + the first 32 hex of
 * `sha256(installation_id + ":" + users.id)`. Stable inside one install,
 * unlinkable across installs, and not reversible to the user ID.
 */
export function userRef(installationId: string, userId: string): string {
  const digest = createHash("sha256").update(`${installationId}:${userId}`).digest("hex");
  return `u_${digest.slice(0, 32)}`;
}

/** `e2b` inside an E2B sandbox, else `cloud` for a hosted swarm, else `self-host`. */
export function resolveDeployment(flags: {
  isCloud: boolean;
  isE2b: boolean;
}): EventContext["deployment"] {
  if (flags.isE2b) return "e2b";
  return flags.isCloud ? "cloud" : "self-host";
}

/** `cloud` for a hosted swarm, else `self-host-free`. The `paid-*` values are reserved. */
export function resolvePlan(isCloud: boolean): EventContext["plan"] {
  return isCloud ? "cloud" : "self-host-free";
}

export interface ContextInput {
  orgId: string;
  orgName?: string | null;
  orgDomain?: string | null;
  installationId: string;
  actor?: TelemetryActor;
  isCloud: boolean;
  isE2b: boolean;
  swarmVersion: string;
  installMethod?: string | null;
  installPreset?: string | null;
  acquisitionSource?: string | null;
}

/** Build the top-level `context` object of a schema_version 2 event. */
export function buildContext(input: ContextInput): EventContext {
  const userId = input.actor?.userId?.trim();
  const orgName = input.orgName?.trim();
  const orgDomain = validOrgDomain(input.orgDomain);
  return {
    org_id: input.orgId,
    org_name: orgName ? orgName : null,
    org_domain: orgDomain ?? null,
    user_ref: userId ? userRef(input.installationId, userId) : null,
    user_role: userId ? (input.actor?.role ?? null) : null,
    plan: resolvePlan(input.isCloud),
    deployment: resolveDeployment({ isCloud: input.isCloud, isE2b: input.isE2b }),
    swarm_version: input.swarmVersion,
    install_method: input.installMethod ?? null,
    install_preset: input.installPreset ?? null,
    acquisition_source: input.acquisitionSource ?? null,
  };
}

interface CatalogPropertySpec {
  type?: string;
  ref?: string;
  nullable?: boolean;
}

let specsByEvent: Map<string, Record<string, CatalogPropertySpec>> | null = null;

function catalogSpecs(event: string): Record<string, CatalogPropertySpec> | undefined {
  if (!specsByEvent) {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- generated catalog; its JSON literal types do not match the spec type.
    const file = catalog as unknown as {
      events: Array<{
        product: string;
        event: string;
        properties: Record<string, CatalogPropertySpec>;
      }>;
    };
    specsByEvent = new Map(
      file.events.filter((e) => e.product === "agent-swarm").map((e) => [e.event, e.properties]),
    );
  }
  return specsByEvent.get(event);
}

/**
 * Make properties survive the proxy's strict validation, which rejects the
 * whole event (and so loses it) for one bad value. `PropsFor<E>` already stops
 * an unknown key at compile time; this covers the runtime values the types
 * cannot: `null` on a property that is not nullable, a fractional number on an
 * `integer` property (a duration measured in fractional ms), and NaN/Infinity.
 * Dropping an optional property is better than dropping the event. Required
 * properties are never invented.
 */
export function normalizeProperties(
  event: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const specs = catalogSpecs(event);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    const spec = specs?.[key];
    if (value === null) {
      if (spec && !spec.nullable) continue;
      out[key] = null;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = spec?.type === "integer" ? Math.round(value) : value;
      continue;
    }
    out[key] = value;
  }
  return out;
}
