// Session sharing: version gates and the pure share-state helpers behind the
// Share dialog and the read-only composer.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type {
  SessionAccess,
  SessionEveryoneAccess,
  SessionShareAccess,
  SessionShares,
  SessionSharesInput,
} from "../api/types";

/**
 * `GET`/`PUT /api/sessions/:id/shares`, `access`/`owner` on session detail,
 * and `scope` on the list ship after 2.3.0. Older servers 404 the shares
 * route, so the UI also treats that 404 as "unsupported".
 */
export const SESSION_SHARING_MIN_VERSION = "2.3.1";

/** `presence:session:<rootTaskId>` rooms and the Comb-independent ticket route. */
export const SESSION_PRESENCE_MIN_VERSION = "2.3.1";

/**
 * Whether the composer is read-only. Only an explicit `read` locks it: a
 * missing `access` (older servers) keeps today's composer.
 */
export function isReadOnlyAccess(access: SessionAccess | undefined): boolean {
  return access === "read";
}

/** The person-row choices in the Share dialog. */
export type PersonShareChoice = SessionShareAccess | "remove";

/** Body for the `PUT` that applies one change to the current shares. */
export function sharesInput(shares: SessionShares): SessionSharesInput {
  return {
    everyone: shares.everyone,
    users: shares.users.map(({ userId, access }) => ({ userId, access })),
  };
}

/** Add a person at "Can view". Adding the owner or someone already added changes nothing. */
export function addPerson(
  shares: SessionShares,
  userId: string,
  ownerId: string | null | undefined,
): SessionShares {
  if (userId === ownerId || shares.users.some((u) => u.userId === userId)) return shares;
  return { ...shares, users: [...shares.users, { userId, access: "read" }] };
}

/** Change a person's access, or remove them (the server revokes their share). */
export function setPerson(
  shares: SessionShares,
  userId: string,
  choice: PersonShareChoice,
): SessionShares {
  if (choice === "remove") {
    return { ...shares, users: shares.users.filter((u) => u.userId !== userId) };
  }
  return {
    ...shares,
    users: shares.users.map((u) => (u.userId === userId ? { ...u, access: choice } : u)),
  };
}

export function setEveryone(shares: SessionShares, everyone: SessionEveryoneAccess): SessionShares {
  return { ...shares, everyone };
}

export const EVERYONE_OPTIONS: {
  value: SessionEveryoneAccess;
  label: string;
  description: string;
}[] = [
  { value: "none", label: "Private", description: "Only people added can open it." },
  { value: "read", label: "Everyone can view", description: "Anyone on this swarm can open it." },
  {
    value: "write",
    label: "Everyone can edit",
    description: "Anyone on this swarm can open it and send messages.",
  },
];
