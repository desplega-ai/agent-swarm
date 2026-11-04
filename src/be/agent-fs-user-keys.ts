import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";
import { getUserGrant } from "./rbac-roles";
import {
  AgentFsRequestError,
  agentFsRequest,
  getCurrentOrgMembers,
  inviteEmailToSharedOrg,
  resolveAgentFsSharedContext,
  resolveApiUrl,
  roleRank,
} from "./seed/agent-fs-provision";
import { findUserById } from "./users";

type AccountState =
  | { status: "off"; email?: string; reason: string }
  | { status: "pending"; email: string; orgId?: string; driveId?: string; reason: string }
  | {
      status: "ready";
      agentFsUserId: string;
      email: string;
      displayName?: string;
      orgId: string;
      driveId: string;
    };

export class AgentFsKeyValidationError extends Error {}

export async function ensureUserAgentFsAccount(userId: string): Promise<AccountState> {
  if (!(await resolveApiUrl())) {
    return { status: "off", reason: "AGENT_FS_API_URL is not configured" };
  }
  const user = await findUserById(userId);
  const email = user?.email?.trim() ?? "";
  if (!user || !email) {
    return { status: "pending", email, reason: "The swarm user is missing or has no email" };
  }
  const shared = await resolveAgentFsSharedContext();
  if (!shared) return { status: "off", reason: "AGENT_FS_API_URL is not configured" };
  const pending = (reason: string): AccountState => ({
    status: "pending",
    email,
    orgId: shared.orgId,
    driveId: shared.driveId,
    reason: scrubSecrets(reason),
  });
  const grant = await getUserGrant(userId);
  const role = grant.grantsAll || grant.verbs.has("task.fs.mutate") ? "editor" : "viewer";
  const members = await getCurrentOrgMembers(shared.apiUrl, shared.authHeaders, shared.orgId);
  let member = members.find((candidate) => candidate.email === email.toLowerCase());
  if (!member) {
    try {
      // Registration creates the account before the invite, without retaining its primary key.
      await agentFsRequest(shared.apiUrl, "/auth/register", {
        method: "POST",
        body: { email },
      });
    } catch (error) {
      if (!(error instanceof AgentFsRequestError) || error.status >= 500) throw error;
      if (error.status !== 409) return pending(error.message);
    }
  }

  if (!member || roleRank(member.role) < roleRank(role)) {
    const invited = await inviteEmailToSharedOrg(email, role);
    if (invited.status === "pending") return pending("The agent-fs org invite is pending");
    member = (await getCurrentOrgMembers(shared.apiUrl, shared.authHeaders, shared.orgId)).find(
      (candidate) => candidate.email === email.toLowerCase(),
    );
  }
  if (!member?.userId || roleRank(member.role) < roleRank(role)) {
    return pending("The agent-fs org membership is not ready");
  }
  // The swarm assigns only viewer and editor, so an editor whose grant dropped
  // to viewer is lowered before a key is minted. An agent-fs admin is managed
  // in agent-fs (it can be the owner of the bootstrap key) and keeps its role.
  if (member.role !== "admin" && roleRank(member.role) > roleRank(role)) {
    try {
      await agentFsRequest(
        shared.apiUrl,
        `/orgs/${encodeURIComponent(shared.orgId)}/members/${encodeURIComponent(member.userId)}`,
        { method: "PATCH", headers: shared.authHeaders, body: { role } },
      );
    } catch (error) {
      if (!(error instanceof AgentFsRequestError) || error.status >= 500) throw error;
      return pending(`The agent-fs org role could not be lowered to ${role}`);
    }
  }
  return {
    status: "ready",
    agentFsUserId: member.userId,
    email,
    displayName: user.name,
    orgId: shared.orgId,
    driveId: shared.driveId,
  };
}

export async function mintUserAgentFsKey(userId: string, label: string) {
  const sanitized = Array.from(
    label
      .replace(/\p{Cc}/gu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, 100)
    .join("");
  if (!sanitized) throw new AgentFsKeyValidationError("The key label must contain visible text");
  const account = await ensureUserAgentFsAccount(userId);
  if (account.status !== "ready") return account;
  const shared = await resolveAgentFsSharedContext();
  if (!shared) return { status: "off" as const, reason: "AGENT_FS_API_URL is not configured" };
  try {
    const minted = await agentFsRequest<{ id: string; apiKey: string; label: string }>(
      shared.apiUrl,
      `/orgs/${encodeURIComponent(account.orgId)}/members/${encodeURIComponent(account.agentFsUserId)}/keys`,
      { method: "POST", headers: shared.authHeaders, body: { label: sanitized } },
    );
    if (!minted.apiKey || !minted.id) throw new Error("agent-fs did not return a named key");
    registerVolatileSecret(minted.apiKey, `AGENT_FS_USER_KEY:${minted.id}`);
    return {
      status: "minted" as const,
      apiKey: minted.apiKey,
      keyId: minted.id,
      label: minted.label,
      agentFsUserId: account.agentFsUserId,
      orgId: account.orgId,
      driveId: account.driveId,
    };
  } catch (error) {
    if (error instanceof AgentFsRequestError && error.status === 404) {
      let memberMissing = false;
      try {
        memberMissing = JSON.parse(error.body)?.error === "NOT_FOUND";
      } catch {
        // Older agent-fs versions return a plain-text 404 for the missing route.
      }
      if (memberMissing) {
        return {
          status: "pending" as const,
          email: account.email,
          orgId: account.orgId,
          driveId: account.driveId,
          reason: scrubSecrets(error.message),
        };
      }
      return {
        status: "unsupported" as const,
        reason: "Named user keys require agent-fs 0.18.17 or later",
      };
    }
    throw error;
  }
}
