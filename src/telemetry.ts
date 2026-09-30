/**
 * Anonymized telemetry for agent-swarm.
 *
 * - Opt-out via ANONYMIZED_TELEMETRY=false
 * - Fire-and-forget: never throws, never blocks
 * - No DB and no external services (global fetch + node:crypto only)
 * - Importable from both API server and workers
 * - Every event is schema_version 2: a top-level `context` identity envelope
 *   plus properties typed against the proxy's event catalog
 *   (`@desplega/telemetry-contract`). An event or property that is not in the
 *   catalog fails `tsc`, and the proxy rejects it at ingest.
 */
import { randomUUID } from "node:crypto";
import type { PropsFor, TelemetryEventName } from "@desplega/telemetry-contract";
import pkg from "../package.json";
import { isSlackConfigured } from "./slack/config";
import {
  buildContext,
  mintOrgId,
  normalizeProperties,
  type TelemetryActor,
  type TelemetryUserRole,
  validOrgDomain,
  validOrgId,
} from "./telemetry-context";
import { isEnvFlagEnabled } from "./utils/env-flag";
import { getCurrentRequestUserId } from "./utils/request-auth-context";

export type { TelemetryActor } from "./telemetry-context";

type SwarmEventName = TelemetryEventName<"agent-swarm">;
/** `started` for `server.started`: the event names of one family, without the prefix. */
type EventSuffix<Prefix extends string> = SwarmEventName extends infer E
  ? E extends `${Prefix}.${infer Suffix}`
    ? Suffix
    : never
  : never;
type FamilyProps<Prefix extends string, S extends string> = PropsFor<
  Extract<SwarmEventName, `${Prefix}.${S}`>
>;

const TELEMETRY_ENDPOINT = "https://proxy.desplega.sh/v1/events";
const PRODUCT = "agent-swarm";
const TIMEOUT_MS = 5_000;

let installationId: string | null = null;
let installedAt: string | null = null;
/** Org ID resolved at init (env, then `telemetry_org_id`). `SWARM_ORG_ID` is re-read per event. */
let cachedOrgId: string | undefined;
/** Email domain of the org's admin, set by the API server (`setTelemetryOrgDomain`). */
let cachedOrgDomain: string | undefined;
let roleResolver: ((userId: string) => TelemetryUserRole | undefined) | null = null;
let identityReloader: (() => Promise<void>) | null = null;
let lastIdentityLoadAt = 0;
let source = "unknown";
let cachedIsCloud = false;
let cachedIsE2b = false;
let cachedHasEmbedding = false;
let cachedHasSlackChannel = false;
let cachedHasEmailChannel = false;
let cachedInstallMethod = "manual";
let cachedInstallPreset: string | undefined;

/** Effective opt-out state: `ANONYMIZED_TELEMETRY` (default on). Read at call time. */
export function isTelemetryEnabled(): boolean {
  return isEnvFlagEnabled("ANONYMIZED_TELEMETRY", true);
}

/**
 * Hosts we own that indicate a cloud-pointed install. Exact-match for known
 * hostnames + suffix-match for the cloud apexes so future cloud subdomains
 * (`mcp.agent-swarm.dev`, `api.agent-swarm.cloud`, etc.) are automatically
 * classified as cloud. Substring match is intentionally avoided —
 * `agent-swarm.dev.attacker.com` must NOT be treated as cloud.
 */
const CLOUD_HOST_EXACT = new Set<string>([
  "agent-swarm-mcp.desplega.sh",
  "agent-swarm.dev",
  "agent-swarm.cloud",
]);
const CLOUD_HOST_SUFFIXES = [".agent-swarm.dev", ".agent-swarm.cloud"];

function isCloudHostname(hostname: string): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  if (CLOUD_HOST_EXACT.has(normalized)) return true;
  return CLOUD_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Detect whether the current process is running inside an E2B sandbox.
 * E2B automatically exposes `E2B_SANDBOX_ID` inside every sandbox.
 * Exported for tests; not part of the public API.
 */
export function _isE2bSandbox(): boolean {
  return typeof process.env.E2B_SANDBOX_ID === "string" && process.env.E2B_SANDBOX_ID.length > 0;
}

/**
 * Parse `MCP_BASE_URL` (or any candidate URL) into the cloud flag we ship on
 * every telemetry event. URL parsing — not substring match — so we never
 * confuse an attacker-controlled `agent-swarm.dev.bad` for cloud. On any
 * parse failure returns a safe `false` so callers never need to defend
 * against this throwing.
 *
 * The hostname itself is intentionally NOT emitted — telemetry is anonymous,
 * and leaking the deployment host would defeat that. Only the boolean
 * cloud-cohort flag ships.
 *
 * Exported for tests; not part of the public API.
 */
export function _resolveCloudMode(mcpBaseUrl: string | undefined | null): {
  isCloud: boolean;
} {
  if (!mcpBaseUrl) return { isCloud: false };
  let hostname: string;
  try {
    hostname = new URL(mcpBaseUrl).hostname;
  } catch {
    return { isCloud: false };
  }
  if (!hostname) return { isCloud: false };
  return { isCloud: isCloudHostname(hostname) };
}

const KNOWN_INSTALL_METHODS = new Set(["onboard_interactive", "onboard_noninteractive"]);

/**
 * Resolve the "which entry point produced this install" cohort.
 *
 * `raw` comes from `INSTALL_METHOD`, written into `.env` by the onboard
 * wizard's `generateEnv()` (`onboard_interactive` / `onboard_noninteractive`
 * per `--yes`/`-y`). Installs that never ran the wizard — hand-written
 * docker-compose, a bare `bun run start:http` clone — never set this var, so
 * an unrecognized/missing value falls back to `"e2b"` (detected independently
 * via `E2B_SANDBOX_ID`, since the `e2b start-stack` CLI path doesn't go
 * through `generateEnv()`) or `"manual"`.
 *
 * Exported for tests; not part of the public API.
 */
export function _resolveInstallMethod(raw: string | undefined | null, isE2b: boolean): string {
  const normalized = raw?.trim();
  if (normalized && KNOWN_INSTALL_METHODS.has(normalized)) return normalized;
  if (isE2b) return "e2b";
  return "manual";
}

/**
 * Preset IDs defined in `src/commands/onboard/presets.ts` (`PRESETS`).
 * Duplicated as a literal set here — rather than imported — to preserve this
 * file's zero-dependency contract (see file header); bump this list in the
 * same PR that adds/removes/renames a preset.
 */
const KNOWN_INSTALL_PRESETS = new Set(["dev", "content", "research", "solo", "custom"]);

export type IntegrationType =
  | "code_repo"
  | "comms"
  | "task_manager"
  | "information_management"
  | "other";

export type IntegrationProvider =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "slack"
  | "email"
  | "kapso"
  | "discord"
  | "telegram"
  | "whatsapp"
  | "linear"
  | "jira"
  | "asana"
  | "trello"
  | "google_drive"
  | "notion"
  | "dropbox"
  | "confluence";

const KNOWN_INTEGRATION_TYPES = new Set<IntegrationType>([
  "code_repo",
  "comms",
  "task_manager",
  "information_management",
  "other",
]);

const INTEGRATION_PROVIDERS = new Map<
  string,
  { provider: IntegrationProvider; type: IntegrationType }
>([
  ["github", { provider: "github", type: "code_repo" }],
  ["github.com", { provider: "github", type: "code_repo" }],
  ["api.github.com", { provider: "github", type: "code_repo" }],
  ["gitlab", { provider: "gitlab", type: "code_repo" }],
  ["gitlab.com", { provider: "gitlab", type: "code_repo" }],
  ["bitbucket", { provider: "bitbucket", type: "code_repo" }],
  ["bitbucket.org", { provider: "bitbucket", type: "code_repo" }],
  ["api.bitbucket.org", { provider: "bitbucket", type: "code_repo" }],
  ["slack", { provider: "slack", type: "comms" }],
  ["slack.com", { provider: "slack", type: "comms" }],
  ["api.slack.com", { provider: "slack", type: "comms" }],
  ["email", { provider: "email", type: "comms" }],
  ["kapso", { provider: "kapso", type: "comms" }],
  ["kapso.ai", { provider: "kapso", type: "comms" }],
  ["api.kapso.ai", { provider: "kapso", type: "comms" }],
  ["discord", { provider: "discord", type: "comms" }],
  ["discord.com", { provider: "discord", type: "comms" }],
  ["telegram", { provider: "telegram", type: "comms" }],
  ["telegram.org", { provider: "telegram", type: "comms" }],
  ["api.telegram.org", { provider: "telegram", type: "comms" }],
  ["whatsapp", { provider: "whatsapp", type: "comms" }],
  ["whatsapp.com", { provider: "whatsapp", type: "comms" }],
  ["linear", { provider: "linear", type: "task_manager" }],
  ["linear.app", { provider: "linear", type: "task_manager" }],
  ["api.linear.app", { provider: "linear", type: "task_manager" }],
  ["jira", { provider: "jira", type: "task_manager" }],
  ["asana", { provider: "asana", type: "task_manager" }],
  ["asana.com", { provider: "asana", type: "task_manager" }],
  ["app.asana.com", { provider: "asana", type: "task_manager" }],
  ["trello", { provider: "trello", type: "task_manager" }],
  ["trello.com", { provider: "trello", type: "task_manager" }],
  ["api.trello.com", { provider: "trello", type: "task_manager" }],
  ["google_drive", { provider: "google_drive", type: "information_management" }],
  ["gdrive", { provider: "google_drive", type: "information_management" }],
  ["drive.google.com", { provider: "google_drive", type: "information_management" }],
  ["notion", { provider: "notion", type: "information_management" }],
  ["notion.so", { provider: "notion", type: "information_management" }],
  ["api.notion.com", { provider: "notion", type: "information_management" }],
  ["dropbox", { provider: "dropbox", type: "information_management" }],
  ["dropbox.com", { provider: "dropbox", type: "information_management" }],
  ["api.dropboxapi.com", { provider: "dropbox", type: "information_management" }],
  ["confluence", { provider: "confluence", type: "information_management" }],
]);

function integrationProviderEntry(
  providerSlug: string | null | undefined,
): { provider: IntegrationProvider; type: IntegrationType } | undefined {
  const raw = providerSlug?.trim().toLowerCase();
  if (!raw) return undefined;

  let candidate = raw;
  try {
    candidate = new URL(raw).hostname.toLowerCase();
  } catch {
    // A provider slug or bare hostname is already in lookup-ready form. Also
    // accept the common git@host:owner/repo SSH shorthand used for repo URLs.
    const sshHost = raw.match(/^[^@]+@([^:]+):/)?.[1];
    if (sshHost) candidate = sshHost;
  }
  if (candidate.startsWith("www.")) candidate = candidate.slice(4);
  return INTEGRATION_PROVIDERS.get(candidate);
}

/** Resolve free-form provider/host input to the closed telemetry category set. */
export function _resolveIntegrationType(providerSlug: string | null | undefined): IntegrationType {
  return integrationProviderEntry(providerSlug)?.type ?? "other";
}

/** Return a provider only when the raw value matched the closed allowlist. */
export function _resolveIntegrationProvider(
  providerSlug: string | null | undefined,
): IntegrationProvider | undefined {
  return integrationProviderEntry(providerSlug)?.provider;
}

/**
 * Validate `INSTALL_PRESET` against the wizard's known preset IDs.
 *
 * Unlike `_resolveInstallMethod`, an unrecognized value is omitted entirely
 * rather than mapped to a fallback sentinel: `INSTALL_PRESET` is free-form
 * operator-set environment text, so forwarding an unrecognized value (an
 * email address, a customer name, anything placed in that env var by
 * mistake) would violate telemetry's enum-only / no-PII contract. Returning
 * `undefined` here means the `install_preset` metadata key is omitted from
 * the event entirely (see the spread-guard in `track()`).
 *
 * Exported for tests; not part of the public API.
 */
export function _resolveInstallPreset(raw: string | undefined | null): string | undefined {
  const normalized = raw?.trim();
  return normalized && KNOWN_INSTALL_PRESETS.has(normalized) ? normalized : undefined;
}

/**
 * Whether semantic memory is likely enabled — i.e. an embedding-capable key
 * is present. The onboard wizard's `generateEnv()` currently only writes
 * Anthropic credentials (`src/commands/onboard/env-generator.ts`), so this
 * lets us measure how many installs are silently running with memory search
 * degraded/off. Boolean only — never the key value.
 *
 * Exported for tests; not part of the public API.
 */
export function _hasEmbeddingKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.EMBEDDING_API_KEY || env.OPENAI_API_KEY);
}

/**
 * Mirrors `initSlackApp()`'s enablement check (`src/slack/app.ts`) without
 * importing the Slack module — this file is intentionally dependency-free
 * (see file header) so both the api-server and workers can import it cheaply.
 * If Slack's disable/credential logic changes, update this in the same PR.
 *
 * Exported for tests; not part of the public API.
 */
export function _hasSlackChannel(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSlackConfigured(env);
}

/**
 * Mirrors `isAgentMailEnabled()` (`src/agentmail/app.ts`) without importing
 * the AgentMail module — see `_hasSlackChannel` for why. AgentMail is the
 * swarm's only outbound email channel today.
 *
 * Exported for tests; not part of the public API.
 */
export function _hasEmailChannel(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.AGENTMAIL_WEBHOOK_SECRET && !isEnvFlagEnabled("AGENTMAIL_DISABLE", false, env);
}

interface InitTelemetryOptions {
  /**
   * Whether to mint and persist a new install ID when the config read returns
   * nothing (or fails). Only the api-server should set this — it owns the
   * install identity. Workers piggyback on whatever the api-server has
   * persisted; if it's not there yet, the worker silently no-ops telemetry to
   * avoid polluting metrics with ephemeral per-restart IDs.
   *
   * Default: false.
   */
  generateIfMissing?: boolean;
}

/**
 * Initialize telemetry. Call once at startup.
 * @param sourceId - "api-server" or "worker"
 * @param getConfig - reads a key from swarm_config (global scope)
 * @param setConfig - writes a key to swarm_config (global scope)
 * @param options - see {@link InitTelemetryOptions}
 */
export async function initTelemetry(
  sourceId: string,
  getConfig: (key: string) => Promise<string | undefined> | string | undefined,
  setConfig: (key: string, value: string) => Promise<void> | void,
  options: InitTelemetryOptions = {},
): Promise<void> {
  if (!isTelemetryEnabled()) return;
  source = sourceId;
  const generateIfMissing = options.generateIfMissing === true;

  const resolved = _resolveCloudMode(process.env.MCP_BASE_URL);
  cachedIsCloud = resolved.isCloud;
  cachedIsE2b = _isE2bSandbox();
  cachedHasEmbedding = _hasEmbeddingKey();
  cachedHasSlackChannel = _hasSlackChannel();
  cachedHasEmailChannel = _hasEmailChannel();
  cachedInstallMethod = _resolveInstallMethod(process.env.INSTALL_METHOD, cachedIsE2b);
  cachedInstallPreset = _resolveInstallPreset(process.env.INSTALL_PRESET);
  console.log(
    `telemetry: cloud=${cachedIsCloud} e2b=${cachedIsE2b} install_method=${cachedInstallMethod}`,
  );

  try {
    const existing = await getConfig("telemetry_installation_id");
    if (existing) {
      installationId = existing;
      // A pre-existing installation ID with no stored anchor means this
      // install predates `telemetry_installed_at` tracking. Do NOT mint
      // now() as a stand-in "install date" here — that back-fills a date
      // that's wrong by however long the install has actually existed
      // (seen: 110 days on our own production install after a routine
      // upgrade). Leave installedAt null so the field is omitted from the
      // payload: absence unambiguously means "pre-existing install, anchor
      // unknown", and consumers can fall back to min(occurred_at) per
      // installation_id in ClickHouse for the real anchor. Only a
      // genuinely new installationId (the branch below) mints one.
      const existingInstalledAt = await getConfig("telemetry_installed_at");
      if (existingInstalledAt) {
        installedAt = existingInstalledAt;
      }
    } else if (generateIfMissing) {
      const candidateId = `install_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await setConfig("telemetry_installation_id", candidateId);
      installationId = candidateId;
      await tryPersistInstalledAt(setConfig);
    }
    // else: leave installationId = null; track() will no-op
  } catch {
    // Config access failed.
    if (generateIfMissing) {
      // Generate ephemeral ID so telemetry still works this session.
      installationId = `ephemeral_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      // Not persisted — config access is failing, so there's nowhere durable
      // to write it. Leave installedAt null rather than a fake fresh mint.
    }
    // else: leave installationId = null; track() will no-op
  }

  if (installationId) {
    await loadOrgIdentity(getConfig, setConfig, generateIfMissing);
    if (!generateIfMissing) {
      // Workers cannot mint an org ID and the API server updates the org
      // domain while they run, so they re-read both through the same
      // config reader: soon after boot while the org ID is missing, hourly after.
      identityReloader = () => loadOrgIdentity(getConfig, setConfig, false);
      lastIdentityLoadAt = Date.now();
    }
  }
}

const ORG_IDENTITY_RETRY_MS = 60_000;
const ORG_IDENTITY_REFRESH_MS = 60 * 60_000;

/**
 * Resolve the org ID and the org email domain.
 *
 * The org ID is `SWARM_ORG_ID` when it is a valid ID (cloud sets it), else the
 * one persisted as `swarm_config.telemetry_org_id`, else (API server only) a
 * newly minted `org_<16 hex>` that is persisted next to the installation ID.
 * The API server also persists a valid `SWARM_ORG_ID`, so workers, which never
 * see that env var, send the same org ID.
 */
async function loadOrgIdentity(
  getConfig: (key: string) => Promise<string | undefined> | string | undefined,
  setConfig: (key: string, value: string) => Promise<void> | void,
  generateIfMissing: boolean,
): Promise<void> {
  const rawEnvOrg = process.env.SWARM_ORG_ID?.trim();
  const envOrg = validOrgId(rawEnvOrg);
  if (rawEnvOrg && !envOrg && generateIfMissing) {
    console.log(
      "telemetry: SWARM_ORG_ID is not org_<16 hex> or org_<27 alphanumerics>; using a derived org ID",
    );
  }

  let stored: string | undefined;
  try {
    stored = validOrgId(await getConfig("telemetry_org_id"));
  } catch {
    // Config unreadable: fall through with what the env gives us.
  }

  if (generateIfMissing) {
    const wanted = envOrg ?? stored ?? mintOrgId();
    if (wanted !== stored) {
      try {
        await setConfig("telemetry_org_id", wanted);
      } catch {
        // Not persisted: this session still sends `wanted`, like the ephemeral install ID.
      }
    }
    cachedOrgId = wanted;
  } else {
    cachedOrgId = envOrg ?? stored;
  }

  try {
    cachedOrgDomain = validOrgDomain(await getConfig("telemetry_org_domain"));
  } catch {
    // Keep the previous value.
  }
}

/** The current org ID: a valid `SWARM_ORG_ID` (re-read per event) or the resolved one. */
function currentOrgId(): string | undefined {
  return validOrgId(process.env.SWARM_ORG_ID) ?? cachedOrgId;
}

function maybeRefreshOrgIdentity(): void {
  if (!identityReloader) return;
  const now = Date.now();
  const interval = currentOrgId() ? ORG_IDENTITY_REFRESH_MS : ORG_IDENTITY_RETRY_MS;
  if (now - lastIdentityLoadAt < interval) return;
  lastIdentityLoadAt = now;
  identityReloader().catch(() => {});
}

/** API server only: publish the org admin's email domain (never the email). */
export function setTelemetryOrgDomain(domain: string | null | undefined): void {
  cachedOrgDomain = validOrgDomain(domain);
}

/**
 * API server only: how to look up a user's role for `context.user_role`
 * without an await. The resolver must be synchronous and cache-backed.
 */
export function setTelemetryRoleResolver(
  resolver: ((userId: string) => TelemetryUserRole | undefined) | null,
): void {
  roleResolver = resolver;
}

/** The install ID, or null before `initTelemetry` resolved one (or after opt-out). */
export function getTelemetryInstallationId(): string | null {
  return installationId;
}

/**
 * Mint + persist the `telemetry_installed_at` anchor, but only commit it to
 * module state (and therefore only emit it on this session's events) once
 * the write actually lands.
 *
 * The anchor's entire value is being a stable, one-time identity for "when
 * did this install first appear" — a failed write here must not fabricate
 * that stability. If `setConfig` throws, this process emits no anchor at
 * all (rather than an unpersisted one that the next boot won't see and will
 * mint a *different* replacement for), and — critically — the failure is
 * swallowed locally so it can't unwind into the caller's `catch`, which
 * would otherwise discard an already-resolved `installationId` that has
 * nothing to do with this write.
 */
async function tryPersistInstalledAt(
  setConfig: (key: string, value: string) => Promise<void> | void,
): Promise<void> {
  const candidate = new Date().toISOString();
  try {
    await setConfig("telemetry_installed_at", candidate);
    installedAt = candidate;
  } catch {
    // Leave installedAt null for this session.
  }
}

export interface TrackOptions<E extends SwarmEventName> {
  event: E;
  properties: PropsFor<E>;
  metadata?: Record<string, unknown>;
  /** Who caused the event. Omit for system events (`user_ref` is then null). */
  actor?: TelemetryActor;
}

/**
 * Read SWARM_ORG_ID / SWARM_ORG_NAME from process.env at call time. Reading
 * fresh each track() lets reloaded swarm_config values land in telemetry
 * without restarting (loadGlobalConfigsIntoEnv mutates process.env on
 * `POST /api/config/reload` with override=true). Returns only the keys that
 * are set, so the spread below stays a clean noop on self-host.
 */
function getOrgIdentity(): { organization_id?: string; organization_name?: string } {
  const out: { organization_id?: string; organization_name?: string } = {};
  const orgId = process.env.SWARM_ORG_ID?.trim();
  if (orgId) out.organization_id = orgId;
  const orgName = process.env.SWARM_ORG_NAME?.trim();
  if (orgName) out.organization_name = orgName;
  return out;
}

/**
 * Mirror of `buildIdentity()`'s SWARM_CLOUD parsing — accepts "true" or "1".
 * Always emitted (not optional) so consumers can split cloud vs self-host
 * cohorts without ambiguity between "false" and "unset".
 */
function isCloudDeployment(): boolean {
  const raw = process.env.SWARM_CLOUD;
  return raw === "true" || raw === "1";
}

function getTelemetryEnvironment(): string {
  const explicit = process.env.DESPLEGA_TELEMETRY_ENV?.trim();
  if (explicit) return explicit;

  // Do not default from NODE_ENV: shipped Bun/npm installs can report
  // "development" even when the operator did not choose a telemetry cohort.
  if (process.env.NODE_ENV === "test") return "test";
  return "production";
}

/**
 * Fire-and-forget telemetry event. Never throws, never blocks.
 *
 * Sends `schema_version: 2`: a `context` identity envelope (org, pseudonymous
 * user, plan, deployment, version) and catalog-typed `properties`. Drops the
 * event (rather than sending a half-identified one) until an org ID exists.
 */
export function track<E extends SwarmEventName>(options: TrackOptions<E>): void {
  emit(
    options.event,
    options.properties as Record<string, unknown>,
    options.metadata,
    options.actor,
  );
}

/** The untyped sender behind `track` and the typed `telemetry.*` wrappers. */
function emit(
  event: string,
  properties: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  actor?: TelemetryActor,
): void {
  if (!isTelemetryEnabled() || !installationId) return;
  maybeRefreshOrgIdentity();
  const orgId = currentOrgId();
  if (!orgId) return;
  try {
    const isCloud = cachedIsCloud || isCloudDeployment();
    const orgIdentity = getOrgIdentity();
    const userId = actor?.userId?.trim() || undefined;
    const payload = {
      schema_version: 2 as const,
      product: PRODUCT,
      event,
      occurred_at: new Date().toISOString(),
      source,
      actor_mode: "anonymous" as const,
      actor_anonymous_id: installationId,
      context: buildContext({
        orgId,
        orgName: orgIdentity.organization_name,
        orgDomain: cachedOrgDomain,
        installationId,
        actor: userId
          ? { userId, role: actor?.role ?? roleResolver?.(userId) ?? null }
          : undefined,
        isCloud,
        isE2b: cachedIsE2b,
        swarmVersion: pkg.version,
        installMethod: cachedInstallMethod,
        installPreset: cachedInstallPreset,
        // Stays null until the dashboard reports where the visitor came from.
        acquisitionSource: null,
      }),
      properties: normalizeProperties(event, {
        ...properties,
        // Legacy keys, kept during the v1 window so dashboards that still read
        // properties_json keep working; v2 carries the same facts in `context`.
        // Cloud-cohort signal. Two independent signals OR'd together:
        // `cachedIsCloud` (MCP_BASE_URL points at a host we own, resolved at
        // init time) catches self-host operators who point their swarm at
        // our managed MCP endpoint; `isCloudDeployment()` (SWARM_CLOUD env
        // var, read fresh) catches hosted Swarm Cloud deployments, whose
        // MCP_BASE_URL is the intra-compose `http://api:3013` address and so
        // never matches a cloud hostname on its own — SWARM_CLOUD=true is the
        // signal those deployments actually carry (see agent-swarm-internal's
        // .env.personalization). Growth reporting keys off this exact field
        // (`properties_json.is_cloud` in ClickHouse), so both cohorts must
        // resolve true here, not just in `metadata.is_cloud` below.
        // Placed at the top level of `properties_json` so ClickHouse can
        // GROUP BY without descending into nested objects. Spread LAST so
        // caller-supplied keys can never spoof the cohort classification.
        // The hostname is intentionally NOT included — telemetry must stay
        // anonymous, and the boolean is sufficient to split cloud vs self-host.
        is_cloud: isCloud,
        is_e2b: cachedIsE2b,
        swarmVersion: pkg.version,
        // Instrumentation-gap closure (2026-07-29): activation-funnel signals.
        // All boolean/enum, resolved once at init from process.env — never a
        // secret, URL, channel ID, address, or other identifier. Spread LAST
        // (same rule as is_cloud/is_e2b above) so callers can't spoof them.
        has_embedding_key: cachedHasEmbedding,
        has_slack_channel: cachedHasSlackChannel,
        has_email_channel: cachedHasEmailChannel,
        has_notification_channel: cachedHasSlackChannel || cachedHasEmailChannel,
        install_method: cachedInstallMethod,
      }),
      metadata: {
        transport: "https",
        environment: getTelemetryEnvironment(),
        is_cloud: isCloudDeployment(),
        ...orgIdentity,
        // Optional — only present when known, same pattern as organization_*.
        ...(cachedInstallPreset ? { install_preset: cachedInstallPreset } : {}),
        ...(installedAt ? { install_created_at: installedAt } : {}),
        ...metadata,
      },
    };
    fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {});
  } catch {
    // Never throw
  }
}

/**
 * Test-only: reset the module-scoped state so tests can re-init cleanly.
 * Do not call from production code.
 */
export function _resetTelemetryStateForTests(): void {
  installationId = null;
  installedAt = null;
  source = "unknown";
  cachedIsCloud = false;
  cachedIsE2b = false;
  cachedHasEmbedding = false;
  cachedHasSlackChannel = false;
  cachedHasEmailChannel = false;
  cachedInstallMethod = "manual";
  cachedInstallPreset = undefined;
  cachedOrgId = undefined;
  cachedOrgDomain = undefined;
  roleResolver = null;
  identityReloader = null;
  lastIdentityLoadAt = 0;
}

/** Test-only: read the org ID resolved at init. */
export function _getOrgIdForTests(): string | undefined {
  return cachedOrgId;
}

/** Test-only: read the resolved install ID. */
export function _getInstallationIdForTests(): string | null {
  return installationId;
}

/** Test-only: read the resolved install-created-at anchor. */
export function _getInstalledAtForTests(): string | null {
  return installedAt;
}

export const telemetry = {
  taskEvent<S extends EventSuffix<"task">>(
    event: S,
    props: FamilyProps<"task", S>,
    actor?: TelemetryActor,
  ): void {
    emit(`task.${event}`, props as Record<string, unknown>, undefined, actor);
  },

  server<S extends EventSuffix<"server">>(event: S, props: FamilyProps<"server", S>): void {
    emit(`server.${event}`, props as Record<string, unknown>, undefined);
  },

  session<S extends EventSuffix<"session">>(
    event: S,
    props: FamilyProps<"session", S>,
    actor?: TelemetryActor,
  ): void {
    emit(`session.${event}`, props as Record<string, unknown>, undefined, actor);
  },

  schedule<S extends EventSuffix<"schedule">>(event: S, props: FamilyProps<"schedule", S>): void {
    emit(`schedule.${event}`, props as Record<string, unknown>, undefined);
  },

  workflow<S extends EventSuffix<"workflow">>(
    event: S,
    props: FamilyProps<"workflow", S>,
    actor?: TelemetryActor,
  ): void {
    emit(`workflow.${event}`, props as Record<string, unknown>, undefined, actor);
  },

  agent<S extends EventSuffix<"agent">>(event: S, props: FamilyProps<"agent", S>): void {
    emit(`agent.${event}`, props as Record<string, unknown>, undefined);
  },

  onboarding<S extends EventSuffix<"onboarding">>(
    event: S,
    props: Omit<FamilyProps<"onboarding", S>, "seconds_since_install">,
    actor?: TelemetryActor,
  ): void {
    const installedAtMs = installedAt ? Date.parse(installedAt) : Number.NaN;
    const secondsSinceInstall = Number.isFinite(installedAtMs)
      ? Math.max(0, Math.floor((Date.now() - installedAtMs) / 1_000))
      : undefined;
    emit(
      `onboarding.${event}`,
      {
        ...props,
        ...(secondsSinceInstall !== undefined
          ? { seconds_since_install: secondsSinceInstall }
          : {}),
      },
      undefined,
      actor,
    );
  },

  integration(
    event: "connected",
    props: { type: IntegrationType; provider?: IntegrationProvider; first_of_type: boolean },
    actor?: TelemetryActor,
  ): void {
    const type = KNOWN_INTEGRATION_TYPES.has(props.type) ? props.type : "other";
    const provider = props.provider
      ? integrationProviderEntry(props.provider)?.provider
      : undefined;
    emit(
      `integration.${event}`,
      { type, ...(provider ? { provider } : {}), first_of_type: props.first_of_type },
      undefined,
      actor,
    );
  },

  compaction<S extends EventSuffix<"compaction">>(
    event: S,
    props: FamilyProps<"compaction", S>,
  ): void {
    emit(`compaction.${event}`, props as Record<string, unknown>, undefined);
  },
};

/**
 * Emit the connected event while ensuring free-form provider/host input can
 * never flow into telemetry. Returns false when telemetry is not initialized,
 * which lets once-per-install callers avoid persisting a marker for a no-op.
 */
export function emitIntegrationConnected(
  type: IntegrationType,
  providerSlug: string | null | undefined,
  firstOfType: boolean,
): boolean {
  if (!isTelemetryEnabled() || !installationId) return false;
  const provider = _resolveIntegrationProvider(providerSlug);
  telemetry.integration(
    "connected",
    {
      type,
      ...(provider ? { provider } : {}),
      first_of_type: firstOfType,
    },
    // The user whose request connected it, when there is one (a boot-time
    // built-in connection has none, so user_ref is null).
    { userId: getCurrentRequestUserId() ?? null },
  );
  return true;
}
