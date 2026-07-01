import { createHash } from "node:crypto";
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

type Role = "viewer" | "editor" | "admin";

type AgentFsSeedItem = SeedItem & {
  apiUrl: string;
  registerEmail: string;
  invites: InviteTarget[];
};

type InviteTarget = {
  email: string;
  role: Role;
};

type FetchLike = typeof fetch;

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
        `[seed:${KIND}] skipped: ${error instanceof Error ? error.message : String(error)}`,
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

  for (const invite of item.invites) {
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

  return { apiUrl, apiKey, orgId, driveId, authHeaders };
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

  await inviteToSharedOrg(apiUrl, shared.authHeaders, shared.orgId, { email, role: "editor" });

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
      `[seed:${KIND}] invite skipped for ${invite.email}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
    const role = isOperatorRole(user.role) ? "editor" : "viewer";
    targets.set(user.email.toLowerCase(), { email: user.email, role });
  }

  return [...targets.values()].sort((a, b) => a.email.localeCompare(b.email));
}

function isOperatorRole(role: string | undefined): boolean {
  return /\b(admin|operator|owner|lead)\b/i.test(role ?? "");
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
