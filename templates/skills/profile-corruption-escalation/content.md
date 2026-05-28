# Profile Corruption Escalation

## Status: Root Cause Fixed in PR #374 (merged 2026-04-24)

The 13-recurrence Picateclas corruption was traced to `src/tools/update-profile.ts:231` unconditionally writing `/workspace/SOUL.md` whenever `isUpdatingSelf=true`. PR #374 fixed it. Any corruption after 2026-04-24 is a **different code path** — investigate fresh, do not assume it's the same bug.

## When to Use

You inspect `get-swarm` and find an agent's `soulMd` or `identityMd` corrupted — short placeholder content, unusual sentinels ("Test Worker", "Updated by Myself", "xxx" padding), or any canned payload that keeps recurring.

## Step 0 — Sentinel-Grep BEFORE Counting Recurrences

**Before applying the N-recurrence ceiling, grep the repo for the literal sentinel strings.**

```bash
grep -rn '"Test Worker"' /workspace/repos/agent-swarm/src
grep -rn '"Updated by Myself"' /workspace/repos/agent-swarm/src
```

If the writer is a test fixture or seed script, fixing the code is 1000× more valuable than restoring the profile. The 13-recurrence mystery was solved in 4 minutes by a grep.

## The N-Recurrence Ceiling Rule

Apply this only AFTER step 0 fails (sentinel grep returns nothing).

- **1st–12th occurrence**: Restore the profile. Write a memory recording the state.
- **13th+ occurrence**: **STOP RESTORING.** Restore fatigue proves the bug lives in code you don't control. Escalate instead.

## Escalation Package (What to Post)

Use `slack-post` to the ops channel. Include ALL of:

1. **Sentinel payload strings as grep targets** — exact literals to search for. State whether you already grepped.
2. **Proof of fresh write** — `lastUpdatedAt` timestamp from `get-swarm`, newer than the previous restore.
3. **Corruption tally** — "N occurrences in ~M weeks, half-life now <24h."
4. **Investigation leads** — grep for sentinels, check scheduled tasks, audit `PostToolUse` hooks, check seed/migration scripts.
5. **What you did NOT do** — explicit "I did not perform the Nth restore. Profile is left corrupted in DB as evidence."

## Escalation Template

```
🚨 Profile Corruption — {N}th recurrence — escalation trigger fired

Agent: {name} ({id})
Fresh write at: {lastUpdatedAt}
Tally: {N} corruptions in ~{M} weeks, half-life {<hours>}h.

Sentinel grep targets: "Test Worker", "Updated by Myself", long "xxxxx…" padding
I already grepped: {summary of grep result}.

Investigation leads:
1. Grep agent-swarm for the sentinels above.
2. Check for scheduled "validate profile" / "test update-profile" tasks.
3. Audit seed/migration scripts on container restart.
4. Audit any code path that writes /workspace/SOUL.md or /workspace/IDENTITY.md.

I did NOT perform the {N}th restore. Profile is corrupted in DB as evidence.
```

## Gotchas

- **Work quality ≠ profile validity.** A corrupted profile worker can still ship working code. Don't let "but the agent still works" push you to keep restoring — that masks the bug.
- **Don't rewrite CLAUDE.md during restoration.** Only SOUL/IDENTITY get touched by this corruption class.
- **Don't auto-retry.** After escalating, the next restore waits for explicit human ack ("OK to restore now, code fix merged").
- **Sentinel-grep first, escalate second.** A 2nd recurrence without grepping is premature escalation. Grep is cheap (<5 min) and usually wins.

## Related

- `reviewer-corruption-hunt-pattern` — the heuristic that solved the 13-recurrence mystery
- `picateclas-14th-restore-post-pr374` — restore payload + fix details
