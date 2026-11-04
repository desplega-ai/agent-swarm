import { createHash, randomUUID } from "node:crypto";
import { scrubSecrets } from "../../utils/secret-scrubber";
import {
  deleteSwarmConfigByKey,
  getAgentById,
  getAllUsers,
  getResolvedConfig,
  getSwarmConfigs,
  upsertSwarmConfig,
} from "../db";
import { getUserGrant } from "../rbac-roles";
import type { Seeder, SeedItem } from "./types";

const KIND = "agent-fs-provision";
const ITEM_KEY = "shared-org-drive";
const PROVISION_VERSION = 1;
const ORG_NAME = "swarm";
const DRIVE_NAME = "shared";
const PROVISION_HASH_KEY = "AGENT_FS_PROVISION_HASH";
// Stored in place of the hash when invites failed transiently. upstreamHash() maps it to
// null, so the next boot re-applies even when the org, drive and key rows already exist
// (otherwise the adopt-current-state fallback below would mark the failed run as in sync).
const PROVISION_RETRY_MARKER = "retry-pending";
const API_KEY_CONFIG = "API_AGENT_FS_API_KEY";
const LEGACY_SHARED_KEY_CONFIG = "AGENT_FS_API_KEY";

export type Role = "viewer" | "editor" | "admin";

type AgentFsSeedItem = SeedItem & {
  apiUrl: string;
  registerEmail: string;
  invites: InviteTarget[];
};

type InviteTarget = {
  email: string;
  role: Role;
};

type OrgMember = {
  userId?: string;
  email?: string | null;
  role?: string | null;
  user?: { email?: string | null } | null;
};

type FetchLike = typeof fetch;

export class AgentFsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

// The provision seeder runs synchronously before the HTTP server binds its port.
// Without a timeout, a co-deployed agent-fs that accepts the TCP connection but
// never responds (LB mid-start, network blackhole) would hang boot forever and
// the API would never listen — turning an optional integration into a crash-loop.
const AGENT_FS_REQUEST_TIMEOUT_MS = 10_000;

let fetchImpl: FetchLike = globalThis.fetch;

export function setAgentFsProvisionFetchForTests(next: FetchLike): void {
  fetchImpl = next;
}

export function resetAgentFsProvisionFetchForTests(): void {
  fetchImpl = globalThis.fetch;
}

export const agentFsProvisionSeeder: Seeder<AgentFsSeedItem> = {
  kind: KIND,

  async items(): Promise<AgentFsSeedItem[]> {
    const apiUrl = await resolveApiUrl();
    if (!apiUrl) return [];

    const registerEmail = await resolveRegisterEmail();
    const invites = await resolveInviteTargets();
    const contentHash = provisionHash({ apiUrl, registerEmail, invites });
    return [{ key: ITEM_KEY, contentHash, apiUrl, registerEmail, invites }];
  },

  async upstreamHash(): Promise<string | null> {
    const existingHash = await getConfigValue(PROVISION_HASH_KEY);
    if (existingHash === PROVISION_RETRY_MARKER) return null;
    if (existingHash) return existingHash;

    const hasOrg = !!(await getConfigValue("AGENT_FS_DEFAULT_ORG_ID"));
    const hasDrive = !!(await getConfigValue("AGENT_FS_DEFAULT_DRIVE_ID"));
    const hasKey = !!(await getConfigValue(API_KEY_CONFIG));
    return hasOrg && hasDrive && hasKey ? await provisionHashFromCurrentState() : null;
  },

  async apply(item): Promise<void> {
    try {
      await provisionAgentFs(item);
    } catch (error) {
      console.warn(
        scrubSecrets(
          `[seed:${KIND}] skipped: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      throw error;
    }
  },
};

async function provisionAgentFs(item: AgentFsSeedItem): Promise<void> {
  const shared = await ensureAgentFsSharedProvisioning({
    apiUrl: item.apiUrl,
    registerEmail: item.registerEmail,
  });
  const currentRoles = await getCurrentOrgMemberRoles(
    item.apiUrl,
    shared.authHeaders,
    shared.orgId,
  );

  let transientFailures = 0;
  for (const invite of item.invites) {
    const currentRole = currentRoles.get(invite.email.toLowerCase());
    if (currentRole && roleRank(currentRole) >= roleRank(invite.role)) continue;
    const outcome = await inviteToSharedOrg(item.apiUrl, shared.authHeaders, shared.orgId, invite);
    if (outcome === "transient-failure") transientFailures++;
  }
  // "no-account" is not a failure to retry: agent-fs has no pending invites. The person's
  // account is created later in the browser, by the /setup Files step or Comb's connect card,
  // and both invite in the same flow. A transient failure (network, 5xx other than not-found,
  // 401/403) must not store the hash, so the next boot re-runs the invites. The org and drive
  // config rows were already written by ensureAgentFsSharedProvisioning above.
  if (transientFailures > 0) {
    await storeProvisionHash(PROVISION_RETRY_MARKER);
    throw new Error(
      `agent-fs invites failed for ${transientFailures} member(s); will retry on next boot`,
    );
  }

  await storeProvisionHash(item.contentHash);
}

async function storeProvisionHash(value: string): Promise<void> {
  await upsertSwarmConfig({
    scope: "global",
    key: PROVISION_HASH_KEY,
    value,
    isSecret: false,
    description: "Internal hash for agent-fs provisioning reconciliation",
  });
}

/** The API-owned bootstrap key: stored config, then env, then the legacy shared key. Empty when none. */
async function resolveSharedApiKey(): Promise<string> {
  return (
    (await getConfigValue(API_KEY_CONFIG)) ||
    process.env.API_AGENT_FS_API_KEY ||
    process.env.AGENT_FS_API_KEY ||
    (await getConfigValue(LEGACY_SHARED_KEY_CONFIG)) ||
    ""
  );
}

export async function ensureAgentFsSharedProvisioning(options?: {
  apiUrl?: string;
  registerEmail?: string;
}): Promise<{
  apiUrl: string;
  apiKey: string;
  orgId: string;
  driveId: string;
  authHeaders: Record<string, string>;
}> {
  const apiUrl = (options?.apiUrl ?? (await resolveApiUrl())).trim().replace(/\/+$/, "");
  if (!apiUrl) throw new Error("AGENT_FS_API_URL is not configured");

  const registerEmail = options?.registerEmail ?? (await resolveRegisterEmail());
  let apiKey = await resolveSharedApiKey();

  if (!apiKey) {
    const registered = await agentFsRequest<{
      apiKey?: string;
      userId?: string;
      orgId?: string;
    }>(apiUrl, "/auth/register", {
      method: "POST",
      body: { email: registerEmail },
      allowConflict: false,
    });

    apiKey = registered.apiKey ?? "";
    if (!apiKey) {
      throw new Error("agent-fs service registration did not return an apiKey");
    }
  }

  process.env.API_AGENT_FS_API_KEY = apiKey;
  await upsertSwarmConfig({
    scope: "global",
    key: API_KEY_CONFIG,
    value: apiKey,
    isSecret: true,
    description: `API-owned agent-fs bootstrap key for ${registerEmail}`,
  });
  await deleteSwarmConfigByKey("global", null, LEGACY_SHARED_KEY_CONFIG);

  const authHeaders = { authorization: `Bearer ${apiKey}` };
  await agentFsRequest(apiUrl, "/auth/me", { headers: authHeaders });
  const orgId = await ensureSharedOrg(apiUrl, authHeaders);
  const driveId = await ensureSharedDrive(apiUrl, authHeaders, orgId);

  for (const [key, value, description] of [
    ["AGENT_FS_DEFAULT_ORG_ID", orgId, "agent-fs default shared org ID"],
    ["AGENT_FS_SHARED_ORG_ID", orgId, "agent-fs shared org ID for agent prompts"],
    ["AGENT_FS_DEFAULT_DRIVE_ID", driveId, "agent-fs default shared drive ID"],
  ] as const) {
    process.env[key] = value;
    await upsertSwarmConfig({ scope: "global", key, value, isSecret: false, description });
  }

  // Export the URL and re-run provider selection: when provisioning lands
  // lazily (first /api/fs/agent-credentials call instead of the boot seeder),
  // the file-storage provider may already be memoized as local-fs — without
  // this, agent-fs stays inactive until a process restart even though every
  // credential it needs now exists. Lazy import: a static be/seed → fs edge
  // shifts module-init order for the whole seed graph.
  process.env.AGENT_FS_API_URL = apiUrl;
  const { resetFileStorageProvider } = await import("../../fs/registry");
  resetFileStorageProvider();

  return { apiUrl, apiKey, orgId, driveId, authHeaders };
}

export type SharedOrgInviteResult = {
  orgId: string;
  invited: boolean;
  status: "already_member" | "added" | "pending";
  inviteId?: string;
  expiresAt?: string;
  acceptUrl?: string;
};

/** Use complete shared credentials without writes. Provision missing credentials otherwise. */
export async function resolveAgentFsSharedContext(): Promise<{
  apiUrl: string;
  orgId: string;
  driveId: string;
  authHeaders: Record<string, string>;
} | null> {
  const apiUrl = await resolveApiUrl();
  if (!apiUrl) return null;
  const apiKey = await resolveSharedApiKey();
  const orgId =
    (await getConfigValue("AGENT_FS_DEFAULT_ORG_ID")) ||
    process.env.AGENT_FS_DEFAULT_ORG_ID ||
    (await getConfigValue("AGENT_FS_SHARED_ORG_ID")) ||
    process.env.AGENT_FS_SHARED_ORG_ID;
  const driveId =
    (await getConfigValue("AGENT_FS_DEFAULT_DRIVE_ID")) || process.env.AGENT_FS_DEFAULT_DRIVE_ID;
  if (apiKey && orgId && driveId) {
    return { apiUrl, orgId, driveId, authHeaders: { authorization: `Bearer ${apiKey}` } };
  }
  return ensureAgentFsSharedProvisioning({ apiUrl });
}

/**
 * Tell agent-fs which swarm the shared org trusts, so the live app can offer
 * "Continue with <swarm>" (`PATCH /orgs/{orgId}` with `{ swarmUrl }`). Runs
 * once per boot, after the seeders. It only acts when the shared org is
 * already provisioned and never provisions it. An agent-fs without the route
 * (404 or 405, for example 0.18.17) is "unsupported", not an error.
 */
export async function syncAgentFsOrgSwarmUrl(
  swarmUrl: string,
): Promise<"set" | "unsupported" | "skipped"> {
  const apiUrl = await resolveApiUrl();
  const apiKey =
    (await getConfigValue(API_KEY_CONFIG)) ||
    process.env.API_AGENT_FS_API_KEY ||
    process.env.AGENT_FS_API_KEY;
  const orgId =
    (await getConfigValue("AGENT_FS_DEFAULT_ORG_ID")) || process.env.AGENT_FS_DEFAULT_ORG_ID;
  if (!apiUrl || !apiKey || !orgId) return "skipped";
  try {
    await agentFsRequest(apiUrl, `/orgs/${encodeURIComponent(orgId)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}` },
      body: { swarmUrl },
    });
    return "set";
  } catch (error) {
    if (error instanceof AgentFsRequestError && (error.status === 404 || error.status === 405)) {
      return "unsupported";
    }
    throw error;
  }
}

/**
 * Invite an external (non-agent) member into the shared org using the
 * API-owned bootstrap credentials. Powers `POST /api/fs/members/invite` so
 * callers holding the tenant API key (e.g. the cloud control plane's
 * Connect-to-Drive flow) never need the bootstrap key itself — it is
 * API-only and never served over HTTP.
 *
 * agent-fs (>= 0.18.9) adds an email that has an account directly
 * (`status: "added"`) and answers an email without one with a pending invite
 * (`status: "pending"`, plus `acceptUrl` when its app URL is configured).
 * agent-fs sends no email, so the accept link is passed back to the caller.
 */
export async function inviteEmailToSharedOrg(
  email: string,
  role: Role,
): Promise<SharedOrgInviteResult> {
  const shared = await resolveAgentFsSharedContext();
  if (!shared) throw new Error("AGENT_FS_API_URL is not configured");
  const currentRoles = await getCurrentOrgMemberRoles(
    shared.apiUrl,
    shared.authHeaders,
    shared.orgId,
  );
  const currentRole = currentRoles.get(email.trim().toLowerCase());
  if (currentRole && roleRank(currentRole) >= roleRank(role)) {
    return { orgId: shared.orgId, invited: false, status: "already_member" };
  }
  const response = await agentFsRequest<{
    status?: unknown;
    inviteId?: unknown;
    expiresAt?: unknown;
    acceptUrl?: unknown;
  }>(shared.apiUrl, `/orgs/${encodeURIComponent(shared.orgId)}/members/invite`, {
    method: "POST",
    headers: shared.authHeaders,
    body: { email: email.trim(), role },
    allowConflict: true,
  });
  // Older agent-fs answers a direct add with a bare `{ ok: true }`.
  if (response.status !== "pending") {
    return { orgId: shared.orgId, invited: true, status: "added" };
  }
  return {
    orgId: shared.orgId,
    invited: true,
    status: "pending",
    ...(typeof response.inviteId === "string" ? { inviteId: response.inviteId } : {}),
    ...(typeof response.expiresAt === "string" ? { expiresAt: response.expiresAt } : {}),
    ...(typeof response.acceptUrl === "string" ? { acceptUrl: response.acceptUrl } : {}),
  };
}

export async function ensureAgentFsCredentialsForAgent(agentId: string): Promise<{
  enabled: boolean;
  created: boolean;
  agentId: string;
  email?: string;
  orgId?: string;
  driveId?: string;
}> {
  const apiUrl = await resolveApiUrl();
  if (!apiUrl) return { enabled: false, created: false, agentId };

  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const existing = (
    await getSwarmConfigs({
      scope: "agent",
      scopeId: agentId,
      key: "AGENT_FS_API_KEY",
    })
  )[0];
  if (existing?.value) {
    await syncAgentFsDisplayName(apiUrl, existing.value, agent.name);
    return {
      enabled: true,
      created: false,
      agentId,
      email: await resolveAgentEmail(agentId),
      orgId:
        (await getConfigValue("AGENT_FS_DEFAULT_ORG_ID")) ||
        (await getConfigValue("AGENT_FS_SHARED_ORG_ID")),
      driveId: await getConfigValue("AGENT_FS_DEFAULT_DRIVE_ID"),
    };
  }

  const shared = await ensureAgentFsSharedProvisioning({ apiUrl });
  let email = await resolveAgentEmail(agentId);
  let registered: { apiKey?: string };
  try {
    registered = await agentFsRequest(apiUrl, "/auth/register", {
      method: "POST",
      body: { email },
      allowConflict: false,
    });
  } catch (error) {
    if (!(error instanceof AgentFsRequestError) || error.status !== 409) throw error;

    email = recoveryAgentEmail(email);
    registered = await agentFsRequest(apiUrl, "/auth/register", {
      method: "POST",
      body: { email },
      allowConflict: false,
    });
  }

  const apiKey = registered.apiKey ?? "";
  if (!apiKey) throw new Error(`agent-fs registration did not return an apiKey for ${agentId}`);

  const currentRoles = await getCurrentOrgMemberRoles(apiUrl, shared.authHeaders, shared.orgId);
  const currentRole = currentRoles.get(email.toLowerCase());
  if (!currentRole || roleRank(currentRole) < roleRank("editor")) {
    await inviteToSharedOrg(apiUrl, shared.authHeaders, shared.orgId, { email, role: "editor" });
  }

  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agentId,
    key: "AGENT_FS_API_KEY",
    value: apiKey,
    isSecret: true,
    description: `agent-fs API key for ${email}`,
  });

  await syncAgentFsDisplayName(apiUrl, apiKey, agent.name);

  return {
    enabled: true,
    created: true,
    agentId,
    email,
    orgId: shared.orgId,
    driveId: shared.driveId,
  };
}

// Reconcile on every credential request, including agents provisioned before profiles
// existed. PATCH is idempotent and uses the agent's own key, never the bootstrap key.
async function syncAgentFsDisplayName(apiUrl: string, apiKey: string, name: string): Promise<void> {
  try {
    await agentFsRequest(apiUrl, "/auth/profile", {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}` },
      body: { displayName: name },
    });
  } catch (error) {
    // Older servers return 404/405. Timeouts and other profile failures must
    // likewise leave boot and existing credentials usable; retry next time.
    console.warn(
      scrubSecrets(
        `[agent-fs] display name sync skipped: ${error instanceof AgentFsRequestError ? `HTTP ${error.status}` : "request failed"}`,
      ),
    );
  }
}

async function ensureSharedOrg(apiUrl: string, headers: Record<string, string>): Promise<string> {
  const configured =
    (await getConfigValue("AGENT_FS_DEFAULT_ORG_ID")) ||
    (await getConfigValue("AGENT_FS_SHARED_ORG_ID"));
  if (configured) return configured;

  const orgs = await agentFsRequest<{
    orgs?: Array<{ id: string; name?: string; isPersonal?: boolean }>;
  }>(apiUrl, "/orgs", { headers });
  const existing = orgs.orgs?.find((org) => org.name === ORG_NAME && !org.isPersonal);
  if (existing?.id) return existing.id;

  const created = await agentFsRequest<{ id?: string; orgId?: string }>(apiUrl, "/orgs", {
    method: "POST",
    headers,
    body: { name: ORG_NAME },
  });
  const orgId = created.id ?? created.orgId;
  if (!orgId) throw new Error("agent-fs org creation did not return an id");
  return orgId;
}

async function ensureSharedDrive(
  apiUrl: string,
  headers: Record<string, string>,
  orgId: string,
): Promise<string> {
  const configured = await getConfigValue("AGENT_FS_DEFAULT_DRIVE_ID");
  if (configured) return configured;

  const drives = await agentFsRequest<{
    drives?: Array<{ id: string; name?: string; isDefault?: boolean }>;
  }>(apiUrl, `/orgs/${encodeURIComponent(orgId)}/drives`, { headers });
  const existing =
    drives.drives?.find((drive) => drive.name === DRIVE_NAME) ??
    drives.drives?.find((drive) => drive.isDefault) ??
    drives.drives?.[0];
  if (existing?.id) return existing.id;

  const created = await agentFsRequest<{ id?: string; driveId?: string }>(
    apiUrl,
    `/orgs/${encodeURIComponent(orgId)}/drives`,
    {
      method: "POST",
      headers,
      body: { name: DRIVE_NAME },
    },
  );
  const driveId = created.id ?? created.driveId;
  if (!driveId) throw new Error("agent-fs drive creation did not return an id");
  return driveId;
}

async function inviteToSharedOrg(
  apiUrl: string,
  headers: Record<string, string>,
  orgId: string,
  invite: InviteTarget,
): Promise<"invited" | "no-account" | "transient-failure"> {
  try {
    await agentFsRequest(apiUrl, `/orgs/${encodeURIComponent(orgId)}/members/invite`, {
      method: "POST",
      headers,
      body: invite,
      allowConflict: true,
    });
    return "invited";
  } catch (error) {
    console.warn(
      scrubSecrets(
        `[seed:${KIND}] invite skipped for ${invite.email}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    // agent-fs answers an unregistered invitee with HTTP 500 "User with email ... not found".
    const noAccount =
      error instanceof AgentFsRequestError &&
      error.status === 500 &&
      /not found/i.test(error.message);
    return noAccount ? "no-account" : "transient-failure";
  }
}

async function getCurrentOrgMemberRoles(
  apiUrl: string,
  headers: Record<string, string>,
  orgId: string,
): Promise<Map<string, Role>> {
  const roles = new Map<string, Role>();
  for (const member of await getCurrentOrgMembers(apiUrl, headers, orgId)) {
    roles.set(member.email, member.role);
  }

  return roles;
}

export async function getCurrentOrgMembers(
  apiUrl: string,
  headers: Record<string, string>,
  orgId: string,
): Promise<Array<{ userId?: string; email: string; role: Role }>> {
  const response = await agentFsRequest<{ members?: OrgMember[] }>(
    apiUrl,
    `/orgs/${encodeURIComponent(orgId)}/members`,
    { headers },
  );
  return (response.members ?? []).flatMap((member) => {
    const email = (member.email ?? member.user?.email ?? "").trim().toLowerCase();
    const role = normalizeRole(member.role);
    return email && role ? [{ userId: member.userId, email, role }] : [];
  });
}

function normalizeRole(role: string | null | undefined): Role | null {
  if (role === "viewer" || role === "editor" || role === "admin") return role;
  return null;
}

export function roleRank(role: Role): number {
  return { viewer: 0, editor: 1, admin: 2 }[role];
}

export async function agentFsRequest<T = unknown>(
  apiUrl: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    allowConflict?: boolean;
  } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetchImpl(`${apiUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(AGENT_FS_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok && !(options.allowConflict && response.status === 409)) {
    const text = await response.text().catch(() => "");
    throw new AgentFsRequestError(
      scrubSecrets(
        `agent-fs ${options.method ?? "GET"} ${path} failed: HTTP ${response.status}${text ? ` ${text}` : ""}`,
      ),
      response.status,
      text,
    );
  }

  return (await response.json().catch(() => ({}))) as T;
}

export async function resolveApiUrl(): Promise<string> {
  const raw = process.env.AGENT_FS_API_URL || (await getConfigValue("AGENT_FS_API_URL")) || "";
  return raw.trim().replace(/\/+$/, "");
}

async function resolveRegisterEmail(): Promise<string> {
  const configured =
    process.env.AGENT_FS_REGISTER_EMAIL || (await getConfigValue("AGENT_FS_REGISTER_EMAIL"));
  if (configured?.trim()) return configured.trim();

  const installId =
    process.env.SWARM_INSTALLATION_ID ||
    process.env.SWARM_ORG_ID ||
    (await getConfigValue("installation_id")) ||
    "swarm";
  const domain = process.env.AGENT_FS_EMAIL_DOMAIN || "swarm.local";
  return `agent-fs-admin-${slugEmailPart(installId)}@${domain}`;
}

async function resolveInviteTargets(): Promise<InviteTarget[]> {
  const targets = new Map<string, InviteTarget>();

  for (const user of await getAllUsers()) {
    const email = user.email?.trim();
    if (!email) continue;
    // Only active users get a seat: invited and suspended users cannot sign in yet.
    if ((user.status ?? "active") !== "active") continue;
    // Follow the RBAC grant, not the free-text profile role, so an RBAC Viewer stays a viewer.
    const grant = await getUserGrant(user.id);
    const role: Role = grant.grantsAll || grant.verbs.has("task.fs.mutate") ? "editor" : "viewer";
    targets.set(email.toLowerCase(), { email, role });
  }

  return [...targets.values()].sort((a, b) => a.email.localeCompare(b.email));
}

async function provisionHashFromCurrentState(): Promise<string> {
  return provisionHash({
    apiUrl: await resolveApiUrl(),
    registerEmail: await resolveRegisterEmail(),
    invites: await resolveInviteTargets(),
  });
}

function provisionHash(input: {
  apiUrl: string;
  registerEmail: string;
  invites: InviteTarget[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: PROVISION_VERSION,
        apiUrl: input.apiUrl,
        registerEmail: input.registerEmail,
        invites: input.invites,
      }),
    )
    .digest("hex");
}

async function getConfigValue(key: string): Promise<string | undefined> {
  return (await getSwarmConfigs({ scope: "global", key }))[0]?.value;
}

async function resolveAgentEmail(agentId: string): Promise<string> {
  const configured = (await getResolvedConfig(agentId)).find(
    (config) => config.key === "AGENT_EMAIL",
  )?.value;
  if (configured?.trim()) return configured.trim();
  const domain = process.env.AGENT_FS_EMAIL_DOMAIN || "swarm.local";
  return `${agentId}@${domain}`;
}

function recoveryAgentEmail(email: string): string {
  const separator = email.lastIndexOf("@");
  const localPart = separator === -1 ? email : email.slice(0, separator);
  const domain = separator === -1 ? "swarm.local" : email.slice(separator + 1);
  return `${localPart}+recovery-${randomUUID()}@${domain}`;
}

function slugEmailPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "swarm"
  );
}
