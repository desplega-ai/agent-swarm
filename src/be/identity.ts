/**
 * The framework's single identity-resolution primitive.
 *
 * Invariant (Rule 33 / provenance-or-silence): the swarm's sole responsibility
 * for identity is the reverse lookup `(kind, externalId)` (or email) → linked
 * user → canonical name, via `findUserByExternalId` / `findUserByEmail`. If
 * the lookup points nowhere, callers render the explicit UNKNOWN sentinel —
 * NEVER a provider display name, NEVER a guess. Every provider adapter that
 * renders a human identity into agent-visible text MUST go through
 * `renderIdentity(resolveIdentity(...))` (or `resolveIdentityByEmail`).
 *
 * Pure DB reads — zero provider API calls. `unknown` is a value, not an
 * error: callers branch on `status`, never throw or fall back to a
 * provider-supplied label.
 *
 * This module is API-side ONLY (see the DB-boundary note in `./users.ts`).
 */

import { findUserByEmail, findUserByExternalId } from "./users";

export type IdentityResolution =
  | {
      status: "resolved";
      kind: string;
      externalId: string;
      userId: string;
      name: string;
      email?: string;
    }
  | { status: "unknown"; kind: string; externalId: string };

/** Reverse lookup by `(kind, externalId)` — e.g. `resolveIdentity('slack', 'U016H7XKZGS')`. */
export function resolveIdentity(kind: string, externalId: string): IdentityResolution {
  const user = findUserByExternalId(kind, externalId);
  if (!user) {
    return { status: "unknown", kind, externalId };
  }
  return {
    status: "resolved",
    kind,
    externalId,
    userId: user.id,
    name: user.name,
    email: user.email,
  };
}

/**
 * Reverse lookup by email (primary or alias). Email is a `users.email`
 * attribute, not an external-id kind — rendered with `kind: "email"` so
 * `renderIdentity` produces a consistent pair form regardless of provider.
 */
export function resolveIdentityByEmail(email: string): IdentityResolution {
  const user = findUserByEmail(email);
  if (!user) {
    return { status: "unknown", kind: "email", externalId: email };
  }
  return {
    status: "resolved",
    kind: "email",
    externalId: email,
    userId: user.id,
    name: user.name,
    email: user.email,
  };
}

/**
 * Render an `IdentityResolution` into agent-visible text — the only two
 * shapes an identity may ever take. The sentinel keeps the raw id but never
 * a name: an unresolved identity must never be confused for a real one.
 */
export function renderIdentity(resolution: IdentityResolution): string {
  const pair = `${resolution.kind}:${resolution.externalId}`;
  if (resolution.status === "resolved") {
    return `${resolution.name} (${pair})`;
  }
  return `${pair} (unknown user)`;
}
