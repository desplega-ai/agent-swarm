# Profile Corruption Escalation

## STATUS: Root cause for the Picateclas corruption family was found and fixed in PR #374 (merged 2026-04-24)

The 13-recurrence Picateclas corruption was traced to `src/tools/update-profile.ts:231` unconditionally writing `/workspace/SOUL.md` whenever `isUpdatingSelf=true`, plus the `update-profile-auth.test.ts` fixture setting a fake `WORKER_ID=bbbb0000-...` that satisfied the gate. The Stop hook then synced the corrupted file to DB. PR #374 fixed both:
- `src/tools/update-profile.ts:231` — gated the file write on `requestInfo.agentId === process.env.AGENT_ID`
- `src/hooks/hook.ts:359` — raised `IDENTITY_FILE_MIN_LENGTH` from 100 → 500 (defense in depth)

**14th restore** completed post-merge with a 1,930/2,065-char payload. If a **15th corruption** of Picateclas (or any agent) appears with the same sentinels post-2026-04-24, treat it as a **DIFFERENT code path**, not the same bug. Escalate immediately — do NOT just restore.

See memories: `picateclas-14th-restore-post-pr374`, `reviewer-corruption-hunt-pattern`.

## When to use

You inspect `get-swarm` and find an agent's `soulMd` or `identityMd` field corrupted — short placeholder content, unusual sentinels ("Test Worker", "Updated by Myself", "xxx" padding to bypass 200-char minLength), or any canned payload that you've seen before.

## Step 0 — Sentinel-grep BEFORE counting recurrences

Before applying the N-recurrence ceiling, **grep the agent-swarm repo for the literal sentinel strings**. The 13-recurrence Picateclas mystery was solved in 4m25s by grepping `"Test Worker"` — it should have happened at recurrence 2 or 3, not 13.

Heuristic: if the corrupted payload contains stable sentinel content with padding sized to clear a known schema floor (e.g. exactly 200 chars to bypass `minLength=200`), the writer is **server-side code that knows the schema** — almost always a test fixture or seed script. Grep wins fast.

```
grep -rn '"Test Worker"' /workspace/repos/agent-swarm/src
grep -rn '"Updated by Myself"' /workspace/repos/agent-swarm/src
```

If you find the writer in <5 minutes, fix it (or open a PR) instead of restoring. That's the 1000× higher-value outcome.

See memory `reviewer-corruption-hunt-pattern` for the full pattern.

## The N-recurrence ceiling rule

Apply this only AFTER step 0 fails (sentinel grep returns nothing in the repo).

Count prior corruptions of the same agent with the same sentinel. Consult memory first:

```
memory-search "picateclas profile corruption"      # or whichever agent name
```

- **1st–12th occurrence**: Restore the profile (surgical update-profile with the agent's best-known-good SOUL/IDENTITY from your memory). Write a new `{agent}-{N}th-profile-corruption-{YYYY-MM-DD}` memory recording the state + escalation status.
- **13th+ occurrence**: **STOP RESTORING.** Rebuild fatigue has proven the restore doesn't stick — the bug lives in code you don't control. Escalate instead.

If you can't determine N from memory, treat anything ≥ 2 prior corruptions in < 7 days as "escalate now."

**Post PR #374 (Apr 2026):** any new sentinel-payload corruption of any agent should be treated as recurrence 1 of a NEW bug — investigate fresh code paths, do not assume it's the same `update-profile.ts:231` issue.

## Escalation package (what to post)

Use `slack-post` to the ops channel. Include ALL of:

1. **Sentinel payload strings as grep targets** — exact literals to search for in the source repo. Example: `"Test Worker"`, `"Updated by Myself"`, `xxxxx...` patterns. **State whether you already grepped (and what the result was).**
2. **Proof of fresh write** — `lastUpdatedAt` timestamp from `get-swarm`, newer than the previous restore. Without this it could be stale state, not new corruption.
3. **Corruption tally** — "N occurrences in ~M weeks, half-life now <24h."
4. **Investigation leads** — where to look:
   - Grep the `desplega-ai/agent-swarm` repo for the sentinel strings.
   - Check for scheduled tasks named `validate profile`, `test update-profile`, etc.
   - Check seed/migration scripts that run on container restart.
   - Audit `PostToolUse` hook content-validation (flagged in prior memories as "not shipped").
   - **Post PR #374:** Audit any other code path that writes `/workspace/SOUL.md` or `/workspace/IDENTITY.md` — the original bug was at `src/tools/update-profile.ts:231`; look for siblings.
5. **What you did NOT do** — explicit "I did not perform the Nth restore. Profile is left corrupted in DB as evidence."

## Template

```
:rotating_light: Profile Corruption — {N}th recurrence — escalation trigger fired

Agent: {name} ({id})
Fresh write at: {lastUpdatedAt}
Tally: {N} corruptions in ~{M} weeks, half-life {<hours>}h.

Sentinel grep targets (expect to find in source):
- "Test Worker"
- "Updated by Myself"
- Long "xxxxx…" padding literals

I already grepped: {summary of grep result, e.g. "no hits in src/ post-#374 — this is a NEW code path"}.

Investigation leads:
1. Grep agent-swarm for the sentinels above.
2. Check for scheduled "validate profile" / "test update-profile" tasks.
3. Audit seed/migration scripts on container restart.
4. Audit any code path that writes /workspace/SOUL.md or /workspace/IDENTITY.md (original bug was update-profile.ts:231).

I did NOT perform the {N}th restore. Profile is corrupted in DB as evidence. Waiting for engineering fix before next restore.

See memory: {agent}-{N}th-profile-corruption-{date}
```

## Gotchas

- **Work quality ≠ profile validity.** Even a corrupted profile worker ships working code because the persona/working-style lives more in CLAUDE.md + memory than in the short SOUL.md. Don't let "but the agent still works" push you to keep restoring — that masks the bug.
- **Don't rewrite CLAUDE.md during restoration.** In this corruption family, CLAUDE.md has been stable through 12 cycles. Only SOUL/IDENTITY get touched. Restoring CLAUDE.md too is wasted work and risks overwriting real learnings.
- **Rotate escalation target.** If you've already escalated to one person and no fix in a week, try a different channel (DM vs public, a different engineer, a Linear ticket). Slack-only escalation can get missed.
- **Don't auto-retry.** After escalating, do not put the restore back on a schedule. The next restore waits for explicit human ack ("OK to restore now, code fix merged").
- **Sentinel-grep first, escalate second.** If a 2nd recurrence happens and you haven't grepped the sentinel literal yet, you're escalating prematurely. Grep is cheap (<5 min) and usually wins.

## Related

- Memory family: `{agent}-Nth-profile-corruption-YYYY-MM-DD`
- Memory: `reviewer-corruption-hunt-pattern` — the heuristic that solved the 13-recurrence mystery
- Memory: `picateclas-14th-restore-post-pr374` — restore payload + the fix details
- Lead rule #9 in CLAUDE.md: "Sentinel-grep before escalating recurring bugs"

