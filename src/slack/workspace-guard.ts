/**
 * Drop inbound Slack deliveries that belong to another workspace.
 *
 * Socket Mode load-balances envelopes across every open connection of one
 * Slack app, whatever workspace the event came from. When several swarms share
 * one app (each with its own bot token but the same app-level token), a swarm
 * receives other workspaces' mentions, and Bolt does not filter them: with a
 * single bot token its `authorize` returns that token for every source.
 *
 * The bot token's `auth.test` tells us which workspace this swarm serves. Every
 * delivery whose workspace differs is dropped by the first global middleware
 * (`slackInboundOutcomeMiddleware`) as an `ignored` outcome, before any
 * listener can create a task from it.
 *
 * Decisions:
 * - Events API envelopes are acked: Bolt acks them before any middleware runs.
 *   Leaving them unacked would make Slack retry, load-balanced across the same
 *   connections, and count every foreign delivery as a failure against the
 *   shared app. Interactive payloads and slash commands are left unacked; Slack
 *   does not retry them, and the user sees an error instead of silence.
 * - A delivery with no workspace field passes: there is nothing to compare.
 * - If the workspace is not known yet (auth.test failed), deliveries pass and
 *   the lookup is retried, at most once per `IDENTITY_RETRY_MS`.
 */

export interface SlackWorkspaceIdentity {
  teamId: string | null;
  enterpriseId: string | null;
  /** Org-wide Enterprise Grid install: match on the enterprise, not the workspace. */
  isEnterpriseInstall: boolean;
}

export interface InboundWorkspaceIds {
  teamIds: string[];
  enterpriseIds: string[];
}

export type InboundWorkspaceMatch = "own" | "foreign" | "unknown";

type Body = Record<string, unknown>;

function asRecord(value: unknown): Body | undefined {
  return value && typeof value === "object" ? (value as Body) : undefined;
}

function pushId(list: string[], value: unknown): void {
  if (typeof value === "string" && value.length > 0 && !list.includes(value)) list.push(value);
}

/**
 * Workspace and enterprise ids an inbound payload was delivered for.
 *
 * Events API envelopes carry `authorizations`, the installation the event was
 * delivered to. It is authoritative: in a Slack Connect channel the top-level
 * `team_id` can name the partner workspace. Interactive, view and shortcut
 * payloads carry `team.id` / `enterprise.id`; slash commands and envelopes
 * without `authorizations` carry `team_id` / `enterprise_id`.
 */
export function readInboundWorkspaceIds(body: unknown): InboundWorkspaceIds {
  const ids: InboundWorkspaceIds = { teamIds: [], enterpriseIds: [] };
  const record = asRecord(body);
  if (!record) return ids;

  const authorizations = Array.isArray(record.authorizations) ? record.authorizations : [];
  for (const entry of authorizations) {
    const authorization = asRecord(entry);
    pushId(ids.teamIds, authorization?.team_id);
    pushId(ids.enterpriseIds, authorization?.enterprise_id);
  }
  if (ids.teamIds.length > 0 || ids.enterpriseIds.length > 0) return ids;

  pushId(ids.teamIds, record.team_id);
  pushId(ids.teamIds, asRecord(record.team)?.id);
  pushId(ids.enterpriseIds, record.enterprise_id);
  pushId(ids.enterpriseIds, asRecord(record.enterprise)?.id);
  return ids;
}

/**
 * Compare a payload's ids with this swarm's workspace. Only a positive
 * mismatch is `foreign`; a payload that cannot be compared is `unknown`.
 */
export function matchInboundWorkspace(
  identity: SlackWorkspaceIdentity,
  ids: InboundWorkspaceIds,
): InboundWorkspaceMatch {
  if (identity.isEnterpriseInstall) {
    // Workspaces inside the org all belong to this install; only the enterprise decides.
    if (!identity.enterpriseId || ids.enterpriseIds.length === 0) return "unknown";
    return ids.enterpriseIds.includes(identity.enterpriseId) ? "own" : "foreign";
  }
  if (ids.teamIds.length > 0) {
    if (!identity.teamId) return "unknown";
    return ids.teamIds.includes(identity.teamId) ? "own" : "foreign";
  }
  if (ids.enterpriseIds.length > 0) {
    // Org-level payload with no workspace: ours only if this workspace is in that org.
    return identity.enterpriseId && ids.enterpriseIds.includes(identity.enterpriseId)
      ? "own"
      : "foreign";
  }
  return "unknown";
}

/** The type label logged for a dropped delivery. Never message text. */
export function inboundPayloadType(body: unknown): string {
  const record = asRecord(body);
  if (!record) return "unknown";
  const eventType = asRecord(record.event)?.type;
  if (typeof eventType === "string") return `event:${eventType}`;
  if (typeof record.command === "string") return "command";
  return typeof record.type === "string" ? record.type : "unknown";
}

// ─── Identity of this swarm's workspace ──────────────────────────────────────

/** Subset of `auth.test` the guard reads. */
export interface SlackAuthTestResult {
  team_id?: string;
  enterprise_id?: string;
  is_enterprise_install?: boolean;
}

export const IDENTITY_RETRY_MS = 30_000;

let resolveIdentity: (() => Promise<SlackAuthTestResult>) | null = null;
let identity: SlackWorkspaceIdentity | null = null;
let pending: Promise<SlackWorkspaceIdentity | null> | null = null;
let lastFailureAt = 0;

/** Register the `auth.test` call for this swarm's bot token. Clears any cached identity. */
export function setSlackWorkspaceIdentitySource(
  source: (() => Promise<SlackAuthTestResult>) | null,
): void {
  resolveIdentity = source;
  identity = null;
  pending = null;
  lastFailureAt = 0;
}

function toIdentity(result: SlackAuthTestResult): SlackWorkspaceIdentity {
  return {
    teamId: result.team_id || null,
    enterpriseId: result.enterprise_id || null,
    isEnterpriseInstall: result.is_enterprise_install === true,
  };
}

/**
 * This swarm's workspace, or null when no source is registered or the lookup
 * failed. Successful lookups are cached; failures are retried after
 * `IDENTITY_RETRY_MS`.
 */
export async function getSlackWorkspaceIdentity(
  now: number = Date.now(),
): Promise<SlackWorkspaceIdentity | null> {
  if (identity) return identity;
  if (!resolveIdentity) return null;
  if (pending) return pending;
  if (lastFailureAt > 0 && now - lastFailureAt < IDENTITY_RETRY_MS) return null;

  const source = resolveIdentity;
  pending = (async () => {
    try {
      const resolved = toIdentity(await source());
      // A source swapped mid-call (stop/start) must not cache the old workspace.
      if (resolveIdentity === source) identity = resolved;
      console.log(
        `[Slack] Workspace guard: team=${resolved.teamId ?? "none"} enterprise=${resolved.enterpriseId ?? "none"} enterpriseInstall=${resolved.isEnterpriseInstall}`,
      );
      return resolved;
    } catch (error) {
      lastFailureAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Slack] Workspace guard: auth.test failed, inbound workspace is not checked until it succeeds: ${message}`,
      );
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

const FOREIGN_LOG_INTERVAL_MS = 60_000;
const lastForeignLogAt = new Map<string, number>();

/**
 * Null when the delivery may proceed, otherwise the ignore reason. Logs the
 * foreign team and payload type, at most once a minute per team and type.
 */
export async function checkInboundWorkspace(body: unknown): Promise<string | null> {
  const own = await getSlackWorkspaceIdentity();
  if (!own) return null;
  const ids = readInboundWorkspaceIds(body);
  if (matchInboundWorkspace(own, ids) !== "foreign") return null;

  const team = ids.teamIds.join(",") || "none";
  const enterprise = ids.enterpriseIds.join(",") || "none";
  const type = inboundPayloadType(body);
  const key = `${team}|${enterprise}|${type}`;
  const now = Date.now();
  if (now - (lastForeignLogAt.get(key) ?? 0) >= FOREIGN_LOG_INTERVAL_MS) {
    if (lastForeignLogAt.size >= 1_000) lastForeignLogAt.clear();
    lastForeignLogAt.set(key, now);
    console.warn(
      `[Slack] Dropped inbound delivery from another workspace: team=${team} enterprise=${enterprise} type=${type}`,
    );
  }
  return "foreign_workspace";
}

/** Test-only. */
export function resetSlackWorkspaceGuardForTests(): void {
  setSlackWorkspaceIdentitySource(null);
  lastForeignLogAt.clear();
}
