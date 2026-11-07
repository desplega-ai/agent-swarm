// The connect flow without React. The card and the `/setup` Files step pass
// the real swarm and agent-fs calls in, and tests pass fakes.

import type { FsMeResponse, MintedFsKey } from "../../api/types";
import { AgentFsError } from "../../lib/agent-fs/client";
import type { AgentFsCredential } from "../../lib/agent-fs/credential-store";
import type { MeResponse } from "../../lib/agent-fs/types";

export interface ConnectFlowDeps {
  /** Swarm `GET /api/fs/me`: the user's agent-fs account, made ready on demand. */
  fsMe: () => Promise<FsMeResponse>;
  /** Swarm `POST /api/fs/keys`: a named agent-fs key for this browser, returned once. */
  mintKey: (label: string) => Promise<MintedFsKey>;
  /** agent-fs `GET /auth/me` with `apiKey`. The paste-key fallback only. */
  getMe: (apiKey: string) => Promise<MeResponse>;
  /** `ls /` on the swarm drive with `apiKey`. The paste-key fallback only. */
  ls: (apiKey: string) => Promise<unknown>;
  /**
   * Swarm API invite of `email` to the swarm drive, accepted with `apiKey`
   * when pending. The paste-key fallback only.
   */
  invite: (email: string, apiKey: string) => Promise<unknown>;
  /** Save the credential (`useAgentFs().connect`). */
  connect: (credential: AgentFsCredential) => void;
}

export type ConnectOutcome = { kind: "connected" } | { kind: "failed"; message: string };

export type AutoConnectOutcome =
  | { kind: "connected" }
  // The swarm could not make the agent-fs account ready yet (for example a
  // registration domain rule on agent-fs). `reason` comes from the server.
  | { kind: "pending"; reason: string }
  // agent-fs is too old for named keys (501): the person pastes a key.
  | { kind: "unsupported" }
  | { kind: "failed"; message: string };

/** A failure with a message written for the person connecting. */
class ConnectError extends Error {}

function inviteMessage(email: string): string {
  return `Ask a swarm admin to invite ${email} to the drive.`;
}

/** The HTTP status of a swarm API error (`FsApiError`), or null. */
function apiStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

const PENDING_PREFIX = "agent-fs account pending: ";

/** A 403 from the swarm: the person's role does not hold `fs.join.own`. */
const NO_ACCESS_MESSAGE =
  "Your role cannot open files on this swarm. Ask a swarm admin for access.";

/**
 * Get this browser its own named agent-fs key through the swarm, then save
 * it. The identity comes from the swarm (`fsMe`), not from agent-fs
 * `/auth/me`: a minted key is scoped to the shared org.
 */
export async function autoConnect(
  deps: ConnectFlowDeps,
  label: string,
): Promise<AutoConnectOutcome> {
  let me: FsMeResponse;
  try {
    me = await deps.fsMe();
  } catch (err) {
    if (apiStatus(err) === 403) return { kind: "failed", message: NO_ACCESS_MESSAGE };
    return { kind: "failed", message: errorMessage(err, "Could not reach the swarm API.") };
  }
  if (me.status === "pending") {
    return { kind: "pending", reason: me.reason ?? "Your files account is not ready yet." };
  }
  if (me.status === "unsupported") return { kind: "unsupported" };
  if (me.status !== "ready") {
    return { kind: "failed", message: me.reason ?? "Files is not set up on this swarm." };
  }

  let key: MintedFsKey;
  try {
    key = await deps.mintKey(label);
  } catch (err) {
    const status = apiStatus(err);
    if (status === 501) return { kind: "unsupported" };
    if (status === 403) return { kind: "failed", message: NO_ACCESS_MESSAGE };
    if (status === 409) {
      const message = errorMessage(err, "Your files account is not ready yet.");
      return {
        kind: "pending",
        reason: message.startsWith(PENDING_PREFIX) ? message.slice(PENDING_PREFIX.length) : message,
      };
    }
    return { kind: "failed", message: errorMessage(err, "Could not create a files key.") };
  }

  deps.connect({
    apiKey: key.apiKey,
    userId: key.agentFsUserId,
    email: me.email ?? "",
    displayName: me.displayName ?? null,
    connectedAt: new Date().toISOString(),
    label: key.label,
    keyId: key.keyId,
  });
  return { kind: "connected" };
}

async function hasDriveAccess(deps: ConnectFlowDeps, apiKey: string): Promise<boolean> {
  try {
    await deps.ls(apiKey);
    return true;
  } catch (err) {
    if (err instanceof AgentFsError && (err.status === 403 || err.status === 404)) return false;
    throw err;
  }
}

/**
 * "Paste a key" (the fallback for an agent-fs without named keys): verify
 * the key, get drive access, then save the credential.
 */
export async function connectWithKey(
  deps: ConnectFlowDeps,
  apiKey: string,
): Promise<ConnectOutcome> {
  try {
    const me = await deps.getMe(apiKey);
    // Invite only when the identity has no access yet. An existing member keeps
    // their current role, so a viewer of the swarm drive stays a viewer.
    if (!(await hasDriveAccess(deps, apiKey))) {
      try {
        await deps.invite(me.email, apiKey);
      } catch {
        throw new ConnectError(inviteMessage(me.email));
      }
      if (!(await hasDriveAccess(deps, apiKey))) throw new ConnectError(inviteMessage(me.email));
    }
    deps.connect({
      apiKey,
      userId: me.userId,
      email: me.email,
      displayName: me.displayName ?? null,
      connectedAt: new Date().toISOString(),
    });
    return { kind: "connected" };
  } catch (err) {
    const message =
      err instanceof ConnectError
        ? err.message
        : err instanceof AgentFsError && err.status === 401
          ? "agent-fs does not accept this key."
          : errorMessage(err, "Could not connect to agent-fs.");
    return { kind: "failed", message };
  }
}
