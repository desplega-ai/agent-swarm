import { createHash } from "node:crypto";
import { resetFileStorageProvider } from "../../fs/registry";
import { scrubSecrets } from "../../utils/secret-scrubber";
import {
  deleteSwarmConfigByKey,
  getAgentById,
  getAllUsers,
  getResolvedConfig,
  getSwarmConfigs,
  upsertSwarmConfig,
} from "../db";
import type { Seeder, SeedItem } from "./types";

const KIND = "agent-fs-provision";
const ITEM_KEY = "shared-org-drive";
const PROVISION_VERSION = 1;
const ORG_NAME = "swarm";
const DRIVE_NAME = "shared";
const PROVISION_HASH_KEY = "AGENT_FS_PROVISION_HASH";
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
  email?: string | null;
  role?: string | null;
  user?: { email?: string | null } | null;
};

type FetchLike = typeof fetch;

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

  items(): AgentFsSeedItem[] {
    const apiUrl = resolveApiUrl();
    if (!apiUrl) return [];

    const registerEmail = resolveRegisterEmail();
    const invites = resolveInviteTargets();
    const contentHash = provisionHash({ apiUrl, registerEmail, invites });
    return [{ key: ITEM_KEY, contentHash, apiUrl, registerEmail, invites }];
  },

  upstreamHash(): string | null {
    const existingHash = getConfigValue(PROVISION_HASH_KEY);
    if (existingHash) return existingHash;

    const hasOrg = !!getConfigValue("AGENT_FS_DEFAULT_ORG_ID");
    const hasDrive = !!getConfigValue("AGENT_FS_DEFAULT_DRIVE_ID");
    const hasKey = !!getConfigValue(API_KEY_CONFIG);
    return hasOrg && hasDrive && hasKey ? provisionHashFromCurrentState() : null;
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

  for (const invite of item.invites) {
    const currentRole = currentRoles.get(invite.email.toLowerCase());
    if (currentRole && roleRank(currentRole) >= roleRank(invite.role)) continue;
    await inviteToSharedOrg(item.apiUrl, shared.authHeaders, shared.orgId, invite);
  }

  upsertSwarmConfig({
    scope: "global",
    key: PROVISION_HASH_KEY,
    value: item.contentHash,
    isSecret: false,
    description: "Internal hash for agent-fs provisioning reconciliation",
  });
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
  const apiUrl = (options?.apiUrl ?? resolveApiUrl()).trim().replace(/\/+$/, "");
  if (!apiUrl) throw new Error("AGENT_FS_API_URL is not configured");

  const registerEmail = options?.registerEmail ?? resolveRegisterEmail();
  let apiKey =
    getConfigValue(API_KEY_CONFIG) ||
    process.env.API_AGENT_FS_API_KEY ||
    process.env.AGENT_FS_API_KEY ||
    getConfigValue(LEGACY_SHARED_KEY_CONFIG) ||
    "";

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
  upsertSwarmConfig({
    scope: "global",
    key: API_KEY_CONFIG,
    value: apiKey,
    isSecret: true,
    description: `API-owned agent-fs bootstrap key for ${registerEmail}`,
  });
  deleteSwarmConfigByKey("global", null, LEGACY_SHARED_KEY_CONFIG);

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
    upsertSwarmConfig({ scope: "global", key, value, isSecret: false, description });
  }

  // Export the URL and re-run provider selection: when provisioning lands
  // lazily (first /api/fs/agent-credentials call instead of the boot seeder),
  // the file-storage provider may already be memoized as local-fs — without
  // this, agent-fs stays inactive until a process restart even though every
  // credential it needs now exists.
  process.env.AGENT_FS_API_URL = apiUrl;
  resetFileStorageProvider();

  return { apiUrl, apiKey, orgId, driveId, authHeaders };
}

/**
 * Invite an external (non-agent) member into the shared org using the
 * API-owned bootstrap credentials. Powers `POST /api/fs/members/invite` so
 * callers holding the tenant API key (e.g. the cloud control plane's
 * Connect-to-Drive flow) never need the bootstrap key itself — it is
 * API-only and never served over HTTP.
 */
export async function inviteEmailToSharedOrg(
  email: string,
  role: Role,
): Promise<{ orgId: string; invited: boolean }> {
  const shared = await ensureAgentFsSharedProvisioning();
  const currentRoles = await getCurrentOrgMemberRoles(
    shared.apiUrl,
    shared.authHeaders,
    shared.orgId,
  );
  const currentRole = currentRoles.get(email.trim().toLowerCase());
  if (currentRole && roleRank(currentRole) >= roleRank(role)) {
    return { orgId: shared.orgId, invited: false };
  }
  await agentFsRequest(shared.apiUrl, `/orgs/${encodeURIComponent(shared.orgId)}/members/invite`, {
    method: "POST",
    headers: shared.authHeaders,
    body: { email: email.trim(), role },
    allowConflict: true,
  });
  return { orgId: shared.orgId, invited: true };
}

export async function ensureAgentFsCredentialsForAgent(agentId: string): Promise<{
  enabled: boolean;
  created: boolean;
  agentId: string;
  email?: string;
  orgId?: string;
  driveId?: string;
}> {
  const apiUrl = resolveApiUrl();
  if (!apiUrl) return { enabled: false, created: false, agentId };

  const agent = getAgentById(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const existing = getSwarmConfigs({
    scope: "agent",
    scopeId: agentId,
    key: "AGENT_FS_API_KEY",
  })[0];
  if (existing?.value) {
    return {
      enabled: true,
      created: false,
      agentId,
      email: resolveAgentEmail(agentId),
      orgId: getConfigValue("AGENT_FS_DEFAULT_ORG_ID") || getConfigValue("AGENT_FS_SHARED_ORG_ID"),
      driveId: getConfigValue("AGENT_FS_DEFAULT_DRIVE_ID"),
    };
  }

  const shared = await ensureAgentFsSharedProvisioning({ apiUrl });
  const email = resolveAgentEmail(agentId);
  const registered = await agentFsRequest<{ apiKey?: string }>(apiUrl, "/auth/register", {
    method: "POST",
    body: { email },
    allowConflict: false,
  });

  const apiKey = registered.apiKey ?? "";
  if (!apiKey) throw new Error(`agent-fs registration did not return an apiKey for ${agentId}`);

  const currentRoles = await getCurrentOrgMemberRoles(apiUrl, shared.authHeaders, shared.orgId);
  const currentRole = currentRoles.get(email.toLowerCase());
  if (!currentRole || roleRank(currentRole) < roleRank("editor")) {
    await inviteToSharedOrg(apiUrl, shared.authHeaders, shared.orgId, { email, role: "editor" });
  }

  upsertSwarmConfig({
    scope: "agent",
    scopeId: agentId,
    key: "AGENT_FS_API_KEY",
    value: apiKey,
    isSecret: true,
    description: `agent-fs API key for ${email}`,
  });

  return {
    enabled: true,
    created: true,
    agentId,
    email,
    orgId: shared.orgId,
    driveId: shared.driveId,
  };
}

async function ensureSharedOrg(apiUrl: string, headers: Record<string, string>): Promise<string> {
  const configured =
    getConfigValue("AGENT_FS_DEFAULT_ORG_ID") || getConfigValue("AGENT_FS_SHARED_ORG_ID");
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
  const configured = getConfigValue("AGENT_FS_DEFAULT_DRIVE_ID");
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
): Promise<void> {
  try {
    await agentFsRequest(apiUrl, `/orgs/${encodeURIComponent(orgId)}/members/invite`, {
      method: "POST",
      headers,
      body: invite,
      allowConflict: true,
    });
  } catch (error) {
    console.warn(
      scrubSecrets(
        `[seed:${KIND}] invite skipped for ${invite.email}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
}

async function getCurrentOrgMemberRoles(
  apiUrl: string,
  headers: Record<string, string>,
  orgId: string,
): Promise<Map<string, Role>> {
  const response = await agentFsRequest<{ members?: OrgMember[] }>(
    apiUrl,
    `/orgs/${encodeURIComponent(orgId)}/members`,
    { headers },
  );
  const roles = new Map<string, Role>();

  for (const member of response.members ?? []) {
    const email = (member.email ?? member.user?.email ?? "").trim().toLowerCase();
    const role = normalizeRole(member.role);
    if (email && role) roles.set(email, role);
  }

  return roles;
}

function normalizeRole(role: string | null | undefined): Role | null {
  if (role === "viewer" || role === "editor" || role === "admin") return role;
  return null;
}

function roleRank(role: Role): number {
  return { viewer: 0, editor: 1, admin: 2 }[role];
}

async function agentFsRequest<T = unknown>(
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
    throw new Error(
      `agent-fs ${options.method ?? "GET"} ${path} failed: HTTP ${response.status}${text ? ` ${text}` : ""}`,
    );
  }

  return (await response.json().catch(() => ({}))) as T;
}

function resolveApiUrl(): string {
  const raw = process.env.AGENT_FS_API_URL || getConfigValue("AGENT_FS_API_URL") || "";
  return raw.trim().replace(/\/+$/, "");
}

function resolveRegisterEmail(): string {
  const configured =
    process.env.AGENT_FS_REGISTER_EMAIL || getConfigValue("AGENT_FS_REGISTER_EMAIL");
  if (configured?.trim()) return configured.trim();

  const installId =
    process.env.SWARM_INSTALLATION_ID ||
    process.env.SWARM_ORG_ID ||
    getConfigValue("installation_id") ||
    "swarm";
  const domain = process.env.AGENT_FS_EMAIL_DOMAIN || "swarm.local";
  return `agent-fs-admin-${slugEmailPart(installId)}@${domain}`;
}

function resolveInviteTargets(): InviteTarget[] {
  const targets = new Map<string, InviteTarget>();

  for (const user of getAllUsers()) {
    if (!user.email) continue;
    const role = isExplicitViewerRole(user.role) ? "viewer" : "editor";
    targets.set(user.email.toLowerCase(), { email: user.email, role });
  }

  return [...targets.values()].sort((a, b) => a.email.localeCompare(b.email));
}

function isExplicitViewerRole(role: string | undefined): boolean {
  return /\b(viewer|read[-\s]?only|guest)\b/i.test(role ?? "");
}

function provisionHashFromCurrentState(): string {
  return provisionHash({
    apiUrl: resolveApiUrl(),
    registerEmail: resolveRegisterEmail(),
    invites: resolveInviteTargets(),
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

function getConfigValue(key: string): string | undefined {
  return getSwarmConfigs({ scope: "global", key })[0]?.value;
}

function resolveAgentEmail(agentId: string): string {
  const configured = getResolvedConfig(agentId).find(
    (config) => config.key === "AGENT_EMAIL",
  )?.value;
  if (configured?.trim()) return configured.trim();
  const domain = process.env.AGENT_FS_EMAIL_DOMAIN || "swarm.local";
  return `${agentId}@${domain}`;
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
