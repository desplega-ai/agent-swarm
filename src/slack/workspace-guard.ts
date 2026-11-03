import { isEnvFlagEnabled } from "../utils/env-flag";

/**
 * Process only inbound Slack deliveries proven to belong to this swarm's
 * installation.
 *
 * Socket Mode sends each payload to any one of the app's open connections,
 * whatever workspace it came from. When several swarms share one Slack app
 * (each with its own bot token but the same app-level token), a swarm receives
 * other workspaces' deliveries, and Bolt does not filter them: with a single
 * bot token its `authorize` returns that token for every source.
 *
 * Decisions:
 * - The check runs on the raw socket envelope, before Bolt acks it
 *   (`installSocketWorkspaceGate`). A delivery that is not proven ours is
 *   neither acked nor dispatched. Slack retries an unacked Events API envelope,
 *   and each retry can land on another connection of the app, so the owner can
 *   still receive it. Acking and dropping would lose it for good. Interactive
 *   payloads and slash commands are not retried; the user sees an error instead
 *   of a silent drop.
 * - Fail closed. The socket opens only after this swarm's identity resolved
 *   (`auth.test`). Without an identity, or for a payload with no installation
 *   field, nothing passes.
 * - A workspace install owns a delivery only when the payload names its
 *   workspace (`team_id`) and does not mark the delivery as an org-wide
 *   install. An enterprise id alone never matches a workspace install.
 * - Whether this swarm's token is an org-wide Enterprise install comes from the
 *   installation's OAuth metadata (`is_enterprise_install` in the
 *   `oauth.v2.access` response), set as `SLACK_ENTERPRISE_INSTALL`. `auth.test`
 *   supplies only the ids. An org install owns a delivery only when the payload
 *   names its enterprise and marks the delivery as an org-wide install.
 */

export interface SlackWorkspaceIdentity {
  teamId: string | null;
  enterpriseId: string | null;
  /** Org-wide Enterprise install, from trusted OAuth metadata. */
  isEnterpriseInstall: boolean;
}

/** One installation a payload says it was delivered for. */
export interface InboundInstallation {
  teamId: string | null;
  enterpriseId: string | null;
  /** null when the payload does not say. */
  isEnterpriseInstall: boolean | null;
}

export type InboundOwnership =
  | { own: true }
  | { own: false; reason: "foreign_workspace" | "unverified_workspace" };

type Body = Record<string, unknown>;

function asRecord(value: unknown): Body | undefined {
  return value && typeof value === "object" ? (value as Body) : undefined;
}

function asId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Interactive payloads carry a boolean; slash commands carry "true"/"false". */
function asFlag(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function toInstallation(
  teamId: unknown,
  enterpriseId: unknown,
  flag: unknown,
): InboundInstallation | null {
  const installation = {
    teamId: asId(teamId),
    enterpriseId: asId(enterpriseId),
    isEnterpriseInstall: asFlag(flag),
  };
  return installation.teamId || installation.enterpriseId ? installation : null;
}

/**
 * Installations an inbound payload was delivered for.
 *
 * Events API envelopes carry `authorizations`, the installation the event was
 * delivered to. They are the only source for events: in a Slack Connect channel
 * the top-level `team_id` can name the partner workspace. Interactive, view and
 * shortcut payloads carry `team.id` / `enterprise.id`; slash commands carry
 * `team_id` / `enterprise_id`. Both carry `is_enterprise_install`.
 */
export function readInboundInstallations(body: unknown): InboundInstallation[] {
  const record = asRecord(body);
  if (!record) return [];

  const authorizations = Array.isArray(record.authorizations) ? record.authorizations : [];
  const fromAuthorizations: InboundInstallation[] = [];
  for (const entry of authorizations) {
    const authorization = asRecord(entry);
    const installation = toInstallation(
      authorization?.team_id,
      authorization?.enterprise_id,
      authorization?.is_enterprise_install,
    );
    if (installation) fromAuthorizations.push(installation);
  }
  // An Events API envelope without authorizations cannot be attributed.
  if (fromAuthorizations.length > 0 || record.type === "event_callback") return fromAuthorizations;

  const installation = toInstallation(
    record.team_id ?? asRecord(record.team)?.id,
    record.enterprise_id ?? asRecord(record.enterprise)?.id,
    record.is_enterprise_install,
  );
  return installation ? [installation] : [];
}

/** Does this swarm's installation own the delivery? Anything unproven is not ours. */
export function classifyInboundOwnership(
  identity: SlackWorkspaceIdentity | null,
  installations: InboundInstallation[],
): InboundOwnership {
  if (!identity || installations.length === 0) {
    return { own: false, reason: "unverified_workspace" };
  }
  const owns = identity.isEnterpriseInstall
    ? (installation: InboundInstallation) =>
        identity.enterpriseId !== null &&
        installation.enterpriseId === identity.enterpriseId &&
        installation.isEnterpriseInstall === true
    : (installation: InboundInstallation) =>
        identity.teamId !== null &&
        installation.teamId === identity.teamId &&
        installation.isEnterpriseInstall !== true;
  return installations.some(owns) ? { own: true } : { own: false, reason: "foreign_workspace" };
}

/** The type label logged for a withheld delivery. Never message text. */
export function inboundPayloadType(body: unknown): string {
  const record = asRecord(body);
  if (!record) return "unknown";
  const eventType = asRecord(record.event)?.type;
  if (typeof eventType === "string") return `event:${eventType}`;
  if (typeof record.command === "string") return "command";
  return typeof record.type === "string" ? record.type : "unknown";
}

// ─── Identity of this swarm's installation ───────────────────────────────────

/** Documented `auth.test` fields the guard reads. */
export interface SlackAuthTestResult {
  team_id?: string;
  enterprise_id?: string;
}

/** `SLACK_ENTERPRISE_INSTALL`: the bot token is an org-wide install (`oauth.v2.access`). */
export function isSlackEnterpriseInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagEnabled("SLACK_ENTERPRISE_INSTALL", false, env);
}

/** Build the identity, or throw when `auth.test` lacks the id the install mode needs. */
export function identityFromAuthTest(
  result: SlackAuthTestResult,
  isEnterpriseInstall: boolean,
): SlackWorkspaceIdentity {
  const teamId = asId(result.team_id);
  const enterpriseId = asId(result.enterprise_id);
  if (isEnterpriseInstall && !enterpriseId) {
    throw new Error("SLACK_ENTERPRISE_INSTALL is set but auth.test returned no enterprise_id");
  }
  if (!isEnterpriseInstall && !teamId) {
    throw new Error("auth.test returned no team_id");
  }
  return { teamId: isEnterpriseInstall ? null : teamId, enterpriseId, isEnterpriseInstall };
}

let resolveIdentity: (() => Promise<SlackWorkspaceIdentity>) | null = null;
let identity: SlackWorkspaceIdentity | null = null;
let pending: Promise<SlackWorkspaceIdentity | null> | null = null;

/** Register how to resolve this swarm's identity. Clears any cached identity. */
export function setSlackWorkspaceIdentitySource(
  source: (() => Promise<SlackWorkspaceIdentity>) | null,
): void {
  resolveIdentity = source;
  identity = null;
  pending = null;
}

/** The resolved identity, or null. Never calls Slack. */
export function getCachedSlackWorkspaceIdentity(): SlackWorkspaceIdentity | null {
  return identity;
}

/**
 * Resolve this swarm's identity, or null when no source is registered or the
 * lookup failed. A success is cached; a failure is retried on the next call.
 */
export async function getSlackWorkspaceIdentity(): Promise<SlackWorkspaceIdentity | null> {
  if (identity) return identity;
  if (!resolveIdentity) return null;
  if (pending) return pending;

  const source = resolveIdentity;
  pending = (async () => {
    try {
      const resolved = await source();
      // A source swapped mid-call (stop/start) must not cache the old identity.
      if (resolveIdentity !== source) return null;
      identity = resolved;
      console.log(
        `[Slack] Workspace guard: team=${resolved.teamId ?? "none"} enterprise=${resolved.enterpriseId ?? "none"} enterpriseInstall=${resolved.isEnterpriseInstall}`,
      );
      return resolved;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Slack] Workspace guard: identity lookup failed: ${message}`);
      return null;
    } finally {
      // A source swapped mid-call already cleared or replaced `pending`.
      if (resolveIdentity === source) pending = null;
    }
  })();
  return pending;
}

const WITHHELD_LOG_INTERVAL_MS = 60_000;
const lastWithheldLogAt = new Map<string, number>();

/**
 * Classify a delivery against `identity` and log the ones that are not ours:
 * team, enterprise and payload type only, at most once a minute per key.
 */
export function checkInboundWorkspace(
  body: unknown,
  own: SlackWorkspaceIdentity | null = identity,
): InboundOwnership {
  const installations = readInboundInstallations(body);
  const ownership = classifyInboundOwnership(own, installations);
  if (ownership.own) return ownership;

  const team = installations.map((i) => i.teamId ?? "-").join(",") || "none";
  const enterprise = installations.map((i) => i.enterpriseId ?? "-").join(",") || "none";
  const type = inboundPayloadType(body);
  const key = `${ownership.reason}|${team}|${enterprise}|${type}`;
  const now = Date.now();
  if (now - (lastWithheldLogAt.get(key) ?? 0) >= WITHHELD_LOG_INTERVAL_MS) {
    if (lastWithheldLogAt.size >= 1_000) lastWithheldLogAt.clear();
    lastWithheldLogAt.set(key, now);
    console.warn(
      `[Slack] Withheld inbound delivery (${ownership.reason}): team=${team} enterprise=${enterprise} type=${type}`,
    );
  }
  return ownership;
}

/** Minimal surface of the Socket Mode client the gate wraps. */
interface SocketEventEmitter {
  emit(event: string | symbol, ...args: unknown[]): boolean;
}

/**
 * Wrap the Socket Mode client so a `slack_event` envelope reaches Bolt (which
 * acks it) only when it belongs to `getIdentity()`'s installation. Any other
 * envelope is left unacked and undispatched, so Slack redelivers it.
 *
 * Install it after every other `emit` wrapper: the last one installed runs
 * first, so nothing downstream sees, stores or acks a withheld envelope.
 */
export function installSocketWorkspaceGate(
  client: SocketEventEmitter,
  getIdentity: () => SlackWorkspaceIdentity | null = getCachedSlackWorkspaceIdentity,
): void {
  const emit = client.emit.bind(client);
  client.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event !== "slack_event") return emit(event, ...args);
    const body = (args[0] as { body?: unknown } | undefined)?.body;
    if (checkInboundWorkspace(body, getIdentity()).own) return emit(event, ...args);
    return true;
  };
}

/** Test-only. */
export function resetSlackWorkspaceGuardForTests(): void {
  setSlackWorkspaceIdentitySource(null);
  lastWithheldLogAt.clear();
}
