# Spike: accounts (agent-fs account flow)

Run on 2026-10-26 (BCN, CET) against agent-fs main aecd4c8 (v0.18.5) from source, local storage, embeddings off
(`EMBEDDING_PROVIDER=openai` with no key makes the provider null), data dir in /tmp (deleted). No swarm API was booted:
the calls are the same HTTP calls `src/be/seed/agent-fs-provision.ts` makes, replayed with fetch. Keys are never printed.

Files here:
- `accounts-spike.ts` + `accounts-spike.output.txt`: tasks 1 to 5, raw calls.
- `account-route-sim.ts` + `account-route-sim.output.txt`: the proposed `POST /api/fs/me/account` handler as HTTP calls, 15 scenarios.
- `seeder-invite-retry.patch`: seeder fix (`git apply --check` passes on main 860dd9cb9).

## Results

1. Bootstrap. register 200, `POST /orgs {name:swarm}` 201, drives list returns ONE drive: `default` (isDefault).
   The seeder's `find(name==="shared") ?? find(isDefault)` therefore picks the default drive. It never POSTs a drive on a fresh org.
   **Correction:** a drive created with `POST /orgs/:o/drives` is NOT visible to invited members. `inviteToOrg` grants only the org's
   `isDefault` drive (agent-fs `packages/core/src/identity/orgs.ts:217-262`). My first run created a "shared" drive and ada got 404 on it
   (`output` of the first run, not kept). Plan must never create a second drive for the shared space.
2. New person. Invite BEFORE register: 500 `User with email ... not found` (confirms the seeder boot invite is a no-op for unregistered people).
   register 200 -> key. Before invite: ls 404 "Drive not found", GET /orgs/:o/drives 404 "Org not found". After admin invite (editor): drives 200,
   ls 200, write 200. Re-invite 200 (idempotent). An editor cannot invite or list members (403).
3. Registered, not a member. Second register: 409 `User with this email already exists`, no key. Admin invite works (200) and the
   person's ORIGINAL key then lists the drive (200). Admin `reset-key` for a member: 200 with new key. **Old key then 401 on everything**
   (ls and /auth/me). New key 200. Reset for a registered NON-member: 404 `Org not found`. So order is: invite first, then reset.
4. Case. agent-fs matches emails exactly and stores them as typed. `Foo@` and `foo@` register as two separate accounts (both 200) and
   each can be invited with its exact spelling. Invite of `BAR@` for account `bar@`: 500 not found. Trailing space: 500 not found
   (the swarm trims in `inviteEmailToSharedOrg`, the seeder does not: `resolveInviteTargets` uses `user.email` untrimmed).
   Consequence: the swarm role map is keyed lowercase (`provision.ts:~353`), so two accounts differing only by case collapse into one entry.
5. Person email == bootstrap email. register 409 (no key). Upper-cased variant registers a SEPARATE account (200).
   **Raw invite of the bootstrap email as `editor` returns 200 and DEMOTES the only admin**: afterwards the bootstrap key gets 403
   `requires 'admin'` on GET members (it is locked out of invites, resets, member lists). `inviteToOrg` upserts the role with no rank check.
   Today the swarm avoids this only because both callers skip when current role rank >= requested (`provision.ts:116-118`, `:222-226`),
   using a lowercase map. Any new code path that calls invite without that check can brick the org.

## What the plan must do

### Route: `POST /api/fs/me/account`
Body `{ email, recover?: boolean, role?: "viewer"|"editor"|"admin" }` (default role editor; the caller's swarm user email is the default for `email`).
Response (zod schema, 200): `{ status: "created"|"exists"|"recovered"|"registered-uninvited", email, role?, apiKey?, invited }`.
`apiKey` is present only on created, recovered, and registered-uninvited. Errors use the shared envelope: 400 invalid email, 409 reserved or reset failed, 5xx agent-fs down.
Declare `rbac: { ungated: "<reason>" }` or a verb (it mints a credential, so a verb such as `fs.account.write` is better than ungated; new verbs go in
`src/rbac/permissions.ts` + `legacy-policy.ts`). `Cache-Control: no-store`. Never log the body or response. No telemetry.

Call sequence (all agent-fs calls use the bootstrap key except register):
1. trim; validate email shape (400).
2. Guards (409 `reserved`): `lower === resolveRegisterEmail().toLowerCase()`; domain `@swarm.local` or `AGENT_FS_EMAIL_DOMAIN` (agent accounts are `<agentId>@swarm.local`, `resolveAgentEmail`).
   Case-insensitive, because the upper-cased bootstrap email registers a distinct account (finding 5).
3. `ensureAgentFsSharedProvisioning()` for orgId and apiUrl; `GET /orgs/:o/members`; filter by lowercase equality; prefer the exact-spelling hit.
4. Member found: no `recover` -> `exists` (no key; the person already has one in some browser). `recover:true` -> `POST /orgs/:o/members/:userId/reset-key` -> `recovered` + key. Refuse the bootstrap user and any `admin` row unless the caller asked for it explicitly.
5. Not a member: `POST /auth/register {email: lower}` (public, no auth). 200 -> key held in memory. 409 -> account exists without membership, no key. Other status -> 502.
6. `POST /orgs/:o/members/invite {email: lower, role}` with the SAME string registered. Never send it without the rank check from step 4 for an existing member.
7. Fresh key + invite ok -> `created`. Fresh key + invite failed -> still return 200 `registered-uninvited` with the key (agent-fs shows it once). The browser saves it; a retry of the route hits the 409 path, invites, and returns `exists`; the saved key then works with no reset.
8. 409 + invite ok: `exists`, or with `recover:true` list members again and reset (invite must come first: reset for a non-member is 404).
9. Browser: save the key via `useAgentFs().connect()` only after the route returns it. `recover:true` must sit behind an explicit confirm dialog: reset kills the person's key in every other browser (old key 401).

Simulation (`account-route-sim.output.txt`): new person created with key ls 200; repeat -> exists, no key; lower/mixed/space variants find the same member; recover -> old key 401, new 200;
registered non-member -> exists, and their original key now works; recover on non-member -> recovered (200); fresh register + failed invite -> registered-uninvited, then retry -> exists, recover -> works;
bootstrap email (any case), agent domain, bad email -> rejected; mixed-case Comb member found by lowercase typing and Comb's key untouched; bootstrap admin still 200 at the end.

Known gaps: (a) a non-member account registered earlier with different case (`Foo@` and user types `foo@`) cannot be detected, since agent-fs has no user lookup for non-members: the route registers a second account. Lowercasing on register keeps new accounts consistent; Comb's existing flow registers as typed. (b) A different person guessing an email can request `recover` for it: only holders of the swarm API key reach the route, so gate `recover` on the caller being the user bound to that email, or admin. (c) Behind a swarm-side register the key transits the swarm (not stored). The browser-side `createAndConnect` path (no new route) remains valid; this route is the fallback when the agent-fs URL is not browser reachable.

### Seeder fix (`seeder-invite-retry.patch`)
Today `inviteToSharedOrg` swallows every error and `provisionAgentFs` stores `AGENT_FS_PROVISION_HASH` regardless (`provision.ts:105-129,394-416`).
Patch: the helper returns `invited | no-account | transient-failure`. "User ... not found" (HTTP 500 from agent-fs) is `no-account`: expected, the hash is still stored, because the route above invites at registration time and there are no pending invites in agent-fs. Anything else (network, 401/403, other 5xx) counts as transient, and `provisionAgentFs` throws before storing the hash so the next boot retries. Existing members are skipped by the rank check, so retries are cheap and idempotent. Do NOT bump `PROVISION_VERSION`. Tests to add in `src/tests/agent-fs-provision-seeder.test.ts` (copy the invite tests near :179 and :381): transient 503 on invite -> hash not stored, rerun invites; 500 not-found -> hash stored; second boot with an unchanged user list is a no-op. The agent-credential caller (`provision.ts:297`) still ignores the return value, which is unchanged behavior.

Also: normalize invite emails with trim in `resolveInviteTargets` (finding 4), and key the role map by exact email or document the lowercase collapse.

## Brainstorm/research corrections
- Shared drive is the org default drive named `default` unless an operator creates `shared`; do not call it "shared" in code assumptions beyond the seeder constant.
- Research said admin reset needs a member target: confirmed (404 for non-member); order must be invite then reset.
- Invite can demote an admin (new finding, finding 5).
- Run tests with: `bun run test:root -- src/tests/agent-fs-provision-seeder.test.ts`.
