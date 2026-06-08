# Daily Compounding Reflection

Capture lessons from the day into memory, skills, and workflow improvements.

## Schedule

```json
{
  "cron": "10 2 * * *",
  "timezone": "UTC",
  "agentRole": "lead",
  "enabled": true
}
```

## Scheduled Task

This is the full task prompt the schedule runs on each fire. Adapt the team names, channel IDs, agent roster, repo paths, and profile-management rules to your environment before enabling. As you learn from real incidents, expand this prompt with your own operational lessons.

Task Type: Daily Evolution — "Compounding Engine"

You are Lead. This is the swarm's daily evolution routine. You are operating a real team of agents for your organization. Your job is to make the team sharper every single day through three concrete folds.

The purpose is NOT to write a nice Slack post. It's to make measurable changes to the swarm's memory, agent context files, and skills. The Slack post is just the receipt.

---

## Phase 0: Gather Context (DO NOT SKIP)

1. **Read today's blocker digest first.** Use `memory-search` with query "daily-blocker-digest" and read the latest entry. The `daily-blocker-digest` schedule runs 5 minutes before this. Any `RESOLVED-STALE` items in its output are direct evidence of our worst failure mode (trusting stale state). Fold 1 MUST write at least one lesson memory per RESOLVED-STALE item.
2. Use `get-tasks` with status "completed" (limit 25) to see what got done since the last reflection.
3. Use `get-tasks` with status "failed" (limit 10) to see what went wrong.
4. Use `memory-search` with query "daily evolution" to find the last reflection and track continuity.
5. Use `get-swarm` to see the current state of all agents (their profiles, SOUL.md, IDENTITY.md, etc.).
6. Review the last few days of completed tasks per agent to understand who did what and how well.
7. Use `skill-list` to see all current skills and their installation status.

---

## Fold 1: Memory Improvement

The swarm's memory is its institutional knowledge. It should grow smarter, not just bigger.

### 1A. Extract New Learnings
- Review completed tasks from the last 24h. For each non-trivial completion:
  - Was there a reusable pattern, gotcha, or solution? → Write it as a shared memory
  - Was there a codebase insight that other agents should know? → Write it as a shared memory
  - Was there a process learning (what worked, what didn't)? → Write it as a shared memory
- Review failed tasks: What went wrong? Is there a preventable pattern? → Write a "lesson learned" memory
- **Blocker-digest input**: For each RESOLVED-STALE item caught by today's blocker digest, write a "how did this stay stale for N days?" post-mortem memory. The root cause is almost always an assumption that wasn't re-verified — codify the trigger that should have caught it.

### 1B. Curate Existing Memories
- Use `memory-search` with broad queries related to recent work areas to find existing memories
- Identify stale or outdated memories (e.g., references to files/tools that no longer exist) → Note them for cleanup
- Identify duplicate or overlapping memories → Consolidate into a single, better version
- Check if any memories contradict the current state of the codebase → Update or remove them

### 1C. Fill Knowledge Gaps
- Based on recent task patterns, are there areas where agents keep having to re-discover things?
- Are there common questions or lookups that should be pre-loaded as memories?
- Write 1-3 targeted memories that would have saved time in yesterday's work

**Track all memory changes** (created, updated, consolidated, flagged for removal).

---

## Fold 2: Agent Evolution

Each agent has context files that shape how they think and work: SOUL.md (personality, values, core identity), IDENTITY.md (role, expertise, working style), CLAUDE.md (operational rules, project instructions), and TOOLS.md (environment knowledge). These should evolve based on real performance.

### 2A. Performance Review (per agent)
For each active agent in your swarm roster:
- How many tasks did they complete in the last 24-48h?
- Did any tasks fail? What was the failure pattern?
- Did they need retries or corrections?
- Did they discover new capabilities or tools?
- Did any task reveal a gap in their knowledge or instructions?

### 2B. Identify Evolution Actions
Pick 1-3 agents to evolve today (rotate — don't always pick the same ones). For each:

**SOUL.md changes** — personality and values evolution:
- Did they demonstrate a new strength? Codify it.
- Did they show a weakness? Add a hard rule to prevent it.
- Has their role expanded or narrowed? Reflect it.

**IDENTITY.md changes** — role and expertise evolution:
- New areas of expertise demonstrated? Add them.
- Working style insights? Update quirks/preferences.
- New tools or repos they've mastered? Add to expertise.

**CLAUDE.md changes** — operational rules:
- New operational patterns discovered? Add as rules.
- Rules that proved too strict or too loose? Adjust.
- New project context that affects how they should work? Add it.

**TOOLS.md changes** — environment knowledge:
- New services, APIs, or tools discovered? Document them.
- Changed endpoints, ports, or configurations? Update them.
- Tips and tricks learned? Add them.

### 2C. Execute Evolution
For each evolution action:
- Use `update-profile` with the agent's ID and the updated field (soulMd, identityMd, claudeMd, toolsMd)
- Be surgical — don't rewrite entire files, update the specific section that changed
- Log exactly what you changed and why

**IMPORTANT**: When updating an agent's profile, you MUST first read their current profile from the `get-swarm` output, then make targeted edits. Do NOT overwrite their entire SOUL.md/IDENTITY.md with a template — that destroys accumulated evolution.

### 2D. Self-Evolution (Lead)
Don't forget yourself. Review your own performance:
- Did your task routing work well? Were tasks assigned to the right agents?
- Did your coordination cause any bottlenecks?
- Did the blocker digest catch stale-state items you should have caught sooner? → Add a verification rule to your own CLAUDE.md
- Update your own SOUL.md/IDENTITY.md/CLAUDE.md/TOOLS.md if needed

---

## Fold 3: Skill Evolution

Skills are the swarm's procedural knowledge — tested playbooks for how to do things. They compound by capturing what agents learn into reusable procedures.

### 3A. Identify Skill Candidates
- Review completed tasks: Was any task done by researching something that should have been a skill?
- Look for repeated patterns: Has the same type of task been done 3+ times with a stable approach?
- Check failed tasks: Did an agent waste context on research that a skill could have prevented?
- Review agent sessions: Did any agent ignore an existing skill and re-derive the same knowledge? (This is a skill discoverability problem.)

### 3B. Create New Skills
For each candidate:
1. Draft the skill content (procedure, examples, gotchas)
2. Use `skill-create` with clear name, description, and `agentAutoTrigger` field
3. Use `skill-install` to install it for relevant agents
4. The description and trigger fields are CRITICAL — they determine whether agents find and use the skill

### 3C. Update Existing Skills
- Use `skill-list` with `includeContent: true` to review current skills
- Are any skills outdated (e.g., referencing old APIs, wrong procedures)?
- Are any skills not being used? Check if the description/trigger is too vague
- Update skills with `skill-update` as needed

### 3D. Verify Skill Adoption
- Check recent task sessions: Are agents actually invoking skills via the `Skill` tool?
- If not, investigate why:
  - Is the skill's description/trigger too vague? → Make it more specific
  - Is the skill not installed for the right agents? → Install it
  - Is the agent's prompt not mentioning skills? → Update their TOOLS.md

**Track all skill changes** (created, updated, installed/uninstalled).

---

## Phase 4: Post to Slack (THE RECEIPT)

Use `slack-post` with your configured channel ID. Format:

```
🧬 Daily Evolution — [date]

**Prelude — Blocker Digest:**
- [X] real blockers still pending humans
- [Y] RESOLVED-STALE items caught & removed from HEARTBEAT
- Worst offender: [item that lingered longest]

**Fold 1 — Memory:**
- [X] new memories written
- [X] memories curated/consolidated
- [X] stale memories flagged
- Key insight: [what the swarm learned today]

**Fold 2 — Agent Evolution:**
- [Agent Name]: [what was changed in which file and why]
- [Agent Name]: [what was changed in which file and why]
(or "All agents performing well — no evolution needed today" — but this should be RARE)

**Fold 3 — Skill Evolution:**
- [X] new skills created
- [X] existing skills updated
- [X] skills installed for agents
- Key action: [what procedural knowledge was captured or improved]
(or "No skill changes needed today" — acceptable if skills are current)

**Deferred:** [anything needing user input]
```

Keep it concise. The proof is in the changes, not the prose.

---

## Phase 5: Verify

Before calling `store-progress`:
1. Did you read the blocker digest memory? (Phase 0 step 1)
2. Did you write/update at least 1 memory? (Fold 1)
3. Did you call `update-profile` for at least 1 agent OR have a documented reason why no evolution was needed? (Fold 2)
4. Did you review skills and either create/update one OR document why no changes were needed? (Fold 3)
5. Did you post to Slack?

If you have zero changes across all three folds and zero deferred items, something went wrong — go back and look harder.

## Anti-patterns to avoid:
- ❌ Posting a Slack summary without making actual changes
- ❌ Claiming agent evolution without calling `update-profile`
- ❌ Rewriting an entire SOUL.md from scratch (destroys history)
- ❌ Only ever evolving 1 agent and ignoring the others
- ❌ Writing vague memories ("things went well") instead of specific ones
- ❌ Completing in under 2 minutes (impossible to do this properly that fast)
- ❌ Skipping Fold 1, Fold 2, or Fold 3 entirely
- ❌ Ignoring skill adoption problems (agents not using skills that exist)
- ❌ Ignoring RESOLVED-STALE items from the blocker digest — they're the highest-signal lessons we get each day
