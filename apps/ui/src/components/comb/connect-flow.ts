// The connect card's flow without React. The card passes the real agent-fs
// and swarm calls in, and tests pass fakes.

import { AgentFsError } from "../../lib/agent-fs/client";
import type { AgentFsCredential } from "../../lib/agent-fs/credential-store";
import type { MeResponse } from "../../lib/agent-fs/types";

export interface ConnectFlowDeps {
  /** agent-fs `POST /auth/register`. A taken email fails with a 409. */
  register: (email: string) => Promise<{ apiKey: string }>;
  /** agent-fs `GET /auth/me` with `apiKey`. */
  getMe: (apiKey: string) => Promise<MeResponse>;
  /** `ls /` on the swarm drive with `apiKey`. */
  ls: (apiKey: string) => Promise<unknown>;
  /** Swarm API invite of `email` to the swarm drive. */
  invite: (email: string) => Promise<unknown>;
  /** Save the verified credential (`useAgentFs().connect`). */
  connect: (credential: AgentFsCredential) => void;
}

export type ConnectOutcome =
  | { kind: "connected" }
  // Register answered 409: the email has an account, so the person pastes its key.
  | { kind: "email-taken" }
  // `newKey` is set when a fresh registration could not finish. agent-fs
  // shows a new key only once, so the card keeps it for the person.
  | { kind: "failed"; message: string; newKey?: string };

/** A failure with a message written for the person connecting. */
class ConnectError extends Error {}

function inviteMessage(email: string): string {
  return `Ask a swarm admin to invite ${email} to the drive.`;
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

/** Verify the key, get drive access, then save the credential. */
async function finish(deps: ConnectFlowDeps, apiKey: string): Promise<void> {
  const me = await deps.getMe(apiKey);
  // Invite only when the identity has no access yet. An existing member keeps
  // their current role, so a viewer of the swarm drive stays a viewer
  // (read-only) instead of becoming an editor.
  if (!(await hasDriveAccess(deps, apiKey))) {
    try {
      await deps.invite(me.email);
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
}

function failed(err: unknown, newKey?: string): ConnectOutcome {
  const message =
    err instanceof ConnectError
      ? err.message
      : err instanceof AgentFsError && err.status === 401
        ? "agent-fs does not accept this key."
        : err instanceof Error
          ? err.message
          : "Could not connect to agent-fs.";
  return { kind: "failed", message, newKey };
}

/** "Paste a key". */
export async function connectWithKey(
  deps: ConnectFlowDeps,
  apiKey: string,
): Promise<ConnectOutcome> {
  try {
    await finish(deps, apiKey);
    return { kind: "connected" };
  } catch (err) {
    return failed(err);
  }
}

/** "Create with my email": register, then connect with the new key. */
export async function createAndConnect(
  deps: ConnectFlowDeps,
  email: string,
): Promise<ConnectOutcome> {
  let apiKey: string;
  try {
    apiKey = (await deps.register(email)).apiKey;
  } catch (err) {
    if (err instanceof AgentFsError && err.status === 409) return { kind: "email-taken" };
    return failed(err);
  }
  try {
    await finish(deps, apiKey);
    return { kind: "connected" };
  } catch (err) {
    return failed(err, apiKey);
  }
}
