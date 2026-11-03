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
 *   supplies only the ids. An org install owns a delivery that names its
 *   enterprise and is marked as an org-wide install.
 * - `is_enterprise_install` is optional on interactive payloads and absent from
 *   the documented slash command payload. Without it, a workspace install and
 *   an org install granted the same workspace could both match, so exactly one
 *   claims the delivery:
 *   - A payload that names the bot it belongs to (`message.bot_id` on a button,
 *     `view.bot_id` on a view) belongs to the installation with that bot
 *     (`auth.test` `bot_id`). Each installation has its own bot.
 *   - Otherwise (slash commands, shortcuts), a delivery that names an
 *     enterprise belongs to the org install when the install is granted the
 *     workspace (`auth.teams.list`) or no workspace is named. Only the org
 *     install can see its grants, so a workspace install in an enterprise does
 *     not claim it. A workspace install claims a flag-less delivery only for a
 *     workspace outside any enterprise, which no org install can be granted.
 * - A delivery for a workspace granted after the last lookup is held while the
 *   grant list refreshes, then classified again. The refresh runs at most once
 *   per 30 s for each workspace.
 */

export interface SlackWorkspaceIdentity {
  teamId: string | null;
  enterpriseId: string | null;
  /** Org-wide Enterprise install, from trusted OAuth metadata. */
  isEnterpriseInstall: boolean;
  /** This installation's bot (`auth.test` `bot_id`). */
  botId?: string;
  /** Org install only: workspaces it is granted, from `auth.teams.list`. */
  orgTeamIds?: ReadonlySet<string>;
}

/** One installation a payload says it was delivered for. */
export interface InboundInstallation {
  teamId: string | null;
  enterpriseId: string | null;
  /** null when the payload does not say. */
  isEnterpriseInstall: boolean | null;
  /** The bot whose message or view the payload came from, when it names one. */
  botId?: string;
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
 * shortcut payloads carry `team.id` / `enterprise.id` (or `team.enterprise_id`)
 * and an optional `is_enterprise_install`; `team` is null for an org-wide
 * install. A view opened from a Slack Connect channel names the installing
 * workspace in `view.app_installed_team_id`, as Bolt reads it. Slash commands
 * carry `team_id` / `enterprise_id`, and the documented payload has no flag.
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

  const team = asRecord(record.team);
  const view = asRecord(record.view);
  const installation = toInstallation(
    asId(view?.app_installed_team_id) ?? record.team_id ?? team?.id,
    record.enterprise_id ?? asRecord(record.enterprise)?.id ?? team?.enterprise_id,
    record.is_enterprise_install,
  );
  if (!installation) return [];
  // A button's message, or a view, was posted or opened by one installation's
  // bot. A message shortcut's message can be anyone's, so it proves nothing.
  const botId =
    asId(view?.bot_id) ??
    (record.type === "block_actions" ? asId(asRecord(record.message)?.bot_id) : null);
  return [botId ? { ...installation, botId } : installation];
}

/** Does this swarm's installation own the delivery? Anything unproven is not ours. */
export function classifyInboundOwnership(
  identity: SlackWorkspaceIdentity | null,
  installations: InboundInstallation[],
): InboundOwnership {
  if (!identity || installations.length === 0) {
    return { own: false, reason: "unverified_workspace" };
  }
  // The two branches are complementary: a workspace install and an org install
  // granted that workspace never both claim one delivery.
  const owns = (installation: InboundInstallation): boolean => {
    if (identity.isEnterpriseInstall) {
      if (identity.enterpriseId === null || installation.enterpriseId !== identity.enterpriseId) {
        return false;
      }
      if (installation.isEnterpriseInstall !== null) return installation.isEnterpriseInstall;
      if (installation.botId) return installation.botId === identity.botId;
      return installation.teamId === null || identity.orgTeamIds?.has(installation.teamId) === true;
    }
    if (identity.teamId === null || installation.teamId !== identity.teamId) return false;
    if (installation.isEnterpriseInstall !== null) return !installation.isEnterpriseInstall;
    if (installation.botId) return installation.botId === identity.botId;
    // In an enterprise, an org install granted this workspace may own it.
    return installation.enterpriseId === null;
  };
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
  bot_id?: string;
}

/** The Web API calls that resolve this swarm's identity. */
export interface SlackIdentityClient {
  auth: {
    test(): Promise<SlackAuthTestResult>;
    teams: {
      list(args: { cursor?: string; limit?: number }): Promise<{
        teams?: Array<{ id?: string }>;
        response_metadata?: { next_cursor?: string };
      }>;
    };
  };
}

/** Bounds the `auth.teams.list` pagination (200 per page). */
const MAX_ORG_TEAM_PAGES = 100;

/**
 * Resolve this swarm's identity: `auth.test`, plus `auth.teams.list` for an
 * org-wide install. Throws on any failure, so the socket stays closed.
 */
export async function resolveSlackIdentity(
  client: SlackIdentityClient,
  isEnterpriseInstall: boolean,
): Promise<SlackWorkspaceIdentity> {
  const identity = identityFromAuthTest(await client.auth.test(), isEnterpriseInstall);
  if (!identity.isEnterpriseInstall) return identity;

  const orgTeamIds = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ORG_TEAM_PAGES; page += 1) {
    const result = await client.auth.teams.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const team of result.teams ?? []) {
      const id = asId(team.id);
      if (id) orgTeamIds.add(id);
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  // A partial grant list would withhold the remaining workspaces for good.
  if (cursor) throw new Error("auth.teams.list returned more pages than the safety limit");
  return { ...identity, orgTeamIds };
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
  const botId = asId(result.bot_id);
  if (isEnterpriseInstall && !enterpriseId) {
    throw new Error("SLACK_ENTERPRISE_INSTALL is set but auth.test returned no enterprise_id");
  }
  if (!isEnterpriseInstall && !teamId) {
    throw new Error("auth.test returned no team_id");
  }
  return {
    teamId: isEnterpriseInstall ? null : teamId,
    enterpriseId,
    isEnterpriseInstall,
    ...(botId ? { botId } : {}),
  };
}

let resolveIdentity: (() => Promise<SlackWorkspaceIdentity>) | null = null;
let identity: SlackWorkspaceIdentity | null = null;
let pending: Promise<SlackWorkspaceIdentity | null> | null = null;
let refreshing: Promise<void> | null = null;
/** When each workspace last triggered a grant-list refresh. */
const refreshedTeamsAt = new Map<string, number>();

/** Minimum gap between grant-list refreshes for one workspace. */
const ORG_TEAMS_REFRESH_INTERVAL_MS = 30_000;

/** Register how to resolve this swarm's identity. Clears any cached identity. */
export function setSlackWorkspaceIdentitySource(
  source: (() => Promise<SlackWorkspaceIdentity>) | null,
): void {
  resolveIdentity = source;
  identity = null;
  pending = null;
  refreshing = null;
  refreshedTeamsAt.clear();
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

/**
 * Re-resolve a resolved identity because an org install saw `teamIds`,
 * workspaces of its enterprise it does not know yet. Each workspace triggers a
 * refresh at most once per 30 s. A failure keeps the current identity. Returns
 * the refresh in flight (a new one or one already running), or null if none.
 */
export function refreshSlackWorkspaceIdentity(teamIds: readonly string[]): Promise<void> | null {
  const source = resolveIdentity;
  if (!source || !identity) return null;
  if (refreshing) return refreshing;
  const now = Date.now();
  const due = teamIds.filter(
    (teamId) =>
      now - (refreshedTeamsAt.get(teamId) ?? Number.NEGATIVE_INFINITY) >=
      ORG_TEAMS_REFRESH_INTERVAL_MS,
  );
  if (due.length === 0) return null;
  if (refreshedTeamsAt.size >= 1_000) refreshedTeamsAt.clear();
  for (const teamId of due) refreshedTeamsAt.set(teamId, now);
  const current = (async () => {
    try {
      const resolved = await source();
      if (resolveIdentity === source && identity) identity = resolved;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Slack] Workspace guard: identity refresh failed: ${message}`);
    } finally {
      // A source swapped mid-call already cleared `refreshing`.
      if (resolveIdentity === source) refreshing = null;
    }
  })();
  refreshing = current;
  return current;
}

/**
 * Workspaces of an org install's enterprise that a delivery names and the
 * grant list lacks, where a fresher grant list could change the verdict: the
 * delivery omits the flag and names no bot.
 */
function unknownOrgTeams(
  own: SlackWorkspaceIdentity | null,
  installations: InboundInstallation[],
): string[] {
  if (!own?.isEnterpriseInstall || own.enterpriseId === null) return [];
  const teams: string[] = [];
  for (const i of installations) {
    if (
      i.enterpriseId === own.enterpriseId &&
      i.isEnterpriseInstall === null &&
      !i.botId &&
      i.teamId !== null &&
      own.orgTeamIds?.has(i.teamId) !== true
    ) {
      teams.push(i.teamId);
    }
  }
  return teams;
}

/**
 * Hold a delivery naming an unknown workspace of our enterprise until the
 * grant list refreshes, then classify it again (logging it if still withheld).
 * Slack does not retry commands or actions, so the first one from a newly
 * granted workspace must not be dropped.
 */
async function ownsAfterGrantRefresh(
  body: unknown,
  getIdentity: () => SlackWorkspaceIdentity | null,
): Promise<boolean> {
  // A refresh already running may predate the grant: allow one more.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const own = getIdentity();
    const installations = readInboundInstallations(body);
    if (classifyInboundOwnership(own, installations).own) return true;
    if (own === null || own !== identity) break;
    const refresh = refreshSlackWorkspaceIdentity(unknownOrgTeams(own, installations));
    if (!refresh) break;
    await refresh;
  }
  return checkInboundWorkspace(body, getIdentity()).own;
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
 * envelope is left unacked and undispatched, so Slack redelivers it. One
 * naming a workspace an org install may have been granted since the last
 * lookup is held until the grant list refreshes, then gated again.
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
    const own = getIdentity();
    const installations = readInboundInstallations(body);
    if (classifyInboundOwnership(own, installations).own) return emit(event, ...args);
    // Only the live identity is refreshed; a caller-supplied one is left alone.
    if (own !== null && own === identity && unknownOrgTeams(own, installations).length > 0) {
      void ownsAfterGrantRefresh(body, getIdentity)
        .then((owned) => {
          if (owned) emit(event, ...args);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[Slack] Workspace guard: held delivery failed: ${message}`);
        });
      return true;
    }
    checkInboundWorkspace(body, own);
    return true;
  };
}

/** Test-only. */
export function resetSlackWorkspaceGuardForTests(): void {
  setSlackWorkspaceIdentitySource(null);
  lastWithheldLogAt.clear();
}
