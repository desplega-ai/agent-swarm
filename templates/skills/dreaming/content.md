dreaming is also referred to as **compounding** — the earlier name — which you'll still see in older memories, schedules, and Slack history.

## What a dream reflection session is

Once a day the `dream` workflow fans out one reflection task per live agent. You are one lane of that fan-out. Your job, in this task only:

1. **Read your slice** — the `dream-agent-slice` output for your agent id. That is your evidence, and the only evidence that counts.
2. **Find what's actually true** — recurring failures, repeated tool friction, conventions you confirmed by doing them.
3. **Propose a delta set** as your task's structured output. Nothing else.

You do not edit profiles, memories, or skills in this task. You **propose**. The Lead critiques, dedupes, and arbitrates across every agent's proposals; the `dream-apply` script is the only thing that writes. A delta you cannot point at a line of your slice for will not survive critique — and shouldn't.

The purpose is a measurable change to the swarm's memory, profiles, and skills. The receipt is just the receipt.

## Read your slice first

Your slice contains, for the lookback window (default 1 day):

- `tasks.summary` — total / failed / retries / resumes — and `tasks.recent` with `failureReason` and `retryCount` per task.
- `tools` — tool call counts, highest first.
- `memories` — what you wrote, with `usefulness` (the alpha/beta readout) and `accessCount`.
- `costContext` — sessions, USD, token totals.
- `profiles` — the current `soul` / `identity` / `claude` / `tools` / `heartbeat` text **and `h2Anchors`: the exact H2 headings in each file**.
- `skills` — installed skills with an `invokes` count, plus `invokedSkills` you used that aren't installed for you.

Read `profiles.<file>.h2Anchors` **before** writing any profile op. Those strings are your anchors. Anything not in that list does not exist.

## Evidence rules

### What earns a delta

- **A recurring failure pattern.** The same `failureReason` (or the same root cause under two wordings) twice in the window, or once in the window plus an existing memory saying it happened before. One-line rule that would have prevented it → `CLAUDE` op.
- **Repeated tool friction.** A tool you called 20 times to get one answer, a tool you reached for that doesn't exist, an argument shape you got wrong more than once, an endpoint/port/flag that isn't what your `TOOLS` file says. → `TOOLS` op.
- **A convention you confirmed by doing it.** The command that actually worked, the route that's really there, the review rule that held under a real diff. Confirmed beats plausible.
- **An installed skill with `invokes: 0` that you needed today.** That's a discoverability problem, not a knowledge problem — fix the skill's description/trigger, or note the skill in `TOOLS`.
- **A memory contradicted by what you saw today.** Delete it, or write the corrected one. Stale institutional knowledge is worse than none.
- **A `RESOLVED-STALE` item or a blocker that sat unverified for days.** The root cause is almost always an assumption nobody re-checked. Codify the trigger that should have caught it — that class of lesson is the highest-signal thing you get. Verify, don't assume: every PR or issue reference in `HEARTBEAT` is a claim to re-check, not a status. One that already merged is `RESOLVED-STALE` and the line should come out.
- **A stale reference in a file you already have open.** A dead host or endpoint, a retired tool, a repo that moved, a rule that contradicts the infra you actually used today. A line that is now false costs more than a line that is missing — fix it or remove it.

### What does not

- **One-offs.** One flaky test, one merge conflict, one rate limit. Wait for the second occurrence.
- **Noise dressed up as failure.** `superseded_workflow_task` and `cancelled` are bookkeeping, not failures. Neither are the transient infra reasons — NUL spawn errors, provider quota windows, reboot-sweep "worker session not found", OOM, `e2big` — nor sentinel-progress phantoms, where the work landed and only the structured receipt is missing. Filter these out *before* you call two failures a pattern; what survives the filter is real signal and deserves a delta.
- **Speculation.** "Agents should probably…", "it might help if…", "consider…". If it didn't happen, it isn't evidence.
- **Restating existing profile text.** Read the section under your anchor. If it already says it — even in different words — there is no delta. Paraphrase is noise with a diff attached.
- **Vibes.** "Collaboration went well", "strong day". No task id, no failure reason, no tool count → not evidence.
- **Praise and adjectives about yourself.** `SOUL` is not a performance review.
- **Anything requiring a section rewrite to express.** If your idea only fits by replacing a whole section, it isn't a delta yet — it's an unfinished thought.

Volume is not the goal. Two sharp deltas beat nine soft ones. **Zero deltas plus a one-line reason is a legitimate outcome on a quiet day** — but if you had failures in the window and propose nothing, look again.

## The ReflectionDelta contract

Your structured output is a delta set:

```json
{ "deltas": [ /* ReflectionDelta objects */ ] }
```

Four kinds: `profile-op`, `memory`, `skill`, `hygiene`. Each kind has a **closed** field list — an unexpected field holds the whole delta. Always set `reason`: it is what the Lead arbitrates on and what shows up on the receipt.

(If your task's output schema names a different envelope, follow the schema — the delta objects themselves are identical.)

### `profile-op` — an anchored edit to one of your context files

Fields: `kind`, `agentId`, `file`, `op`, `anchor`, `content` (required for `append-under` / `replace-section`), `reason`. Nothing else.

```json
{
  "kind": "profile-op",
  "agentId": "8f2c1d34-5e6a-4b7c-9d80-1a2b3c4d5e6f",
  "file": "CLAUDE",
  "op": "append-under",
  "anchor": "## Verification",
  "content": "- Re-read the failing test's assertion before changing production code — two tasks this window (t-4471, t-4488) failed on a mis-read expectation, not a real bug.",
  "reason": "Same mis-read-assertion failure twice in 24h."
}
```

- `file`: `SOUL` | `IDENTITY` | `CLAUDE` | `TOOLS` | `HEARTBEAT`
- `op`: `append-under` | `replace-section` | `remove-section`
- `remove-section` takes no `content`.

### `memory` — write or delete institutional knowledge

Fields: `kind`, `agentId`, `action`, `content`, `id` / `memoryId`, `name`, `key`, `scope`, `tags`, `reason`.

```json
{
  "kind": "memory",
  "agentId": "8f2c1d34-5e6a-4b7c-9d80-1a2b3c4d5e6f",
  "action": "write",
  "content": "AgentMail is a REST API, not an MCP server — there are no agentmail_* tools. Call the REST endpoints directly; two tasks burned turns searching for a tool that doesn't exist.",
  "reason": "Rediscovered the same non-existent-tool dead end."
}
```

`action: "write"` requires `content`. `action: "delete"` requires `id` or `memoryId` (take it from `memories[].id` in your slice) and no `content`. The id must belong to the agent named in `agentId` — the apply verifies ownership and **holds** a delete whose memory belongs to someone else or doesn't exist, so never propose deleting from another lane's slice.

Write memories the way you'd want to find them: the fact, the consequence, and the trigger that should fire. `"things went well"` is not a memory.

`scope` may only be `swarm`. The apply path's memory write always stores swarm-scoped memory, so a delta asking for `scope: "agent"` is **held**, not quietly downgraded — a memory you meant to keep private would otherwise be readable by every worker while the receipt claimed agent scope. Omit the field unless you want to state it explicitly.

Reality check: on the apply path a memory write persists `agentId` + `content`. `name` / `key` / `tags` are accepted by the validator but do not currently change what gets stored — don't rely on them.

### `skill` — create or update a procedural playbook

Fields: `kind`, `action`, `content`, `skillId`, `scope`, `reason`. **No `agentId`** — skills aren't per-agent at this layer.

```json
{
  "kind": "skill",
  "action": "update",
  "skillId": "sk_7c1e...",
  "content": "<full replacement skill body>",
  "reason": "Installed for 4 agents, invoked 0 times in 7 days — trigger wording never matches how the work is actually described."
}
```

`action: "create"` needs `content` only; `action: "update"` needs `skillId` too. `content` is the **whole** skill body, not a patch.

`scope` may only be `swarm` (or omitted — same thing). The apply runs as the Lead and a skill delta names no agent, so an `"agent"`-scoped skill would silently become a Lead-personal skill instead of a catalog entry; such a delta is **held**.

Propose a skill when the same shape of task has been done 3+ times with a stable approach, or when an agent burned context re-deriving something a playbook would have answered. Description and trigger wording are the load-bearing parts — a skill nobody finds is a skill that doesn't exist. Propose an update when a skill cites a host, endpoint, or command that no longer exists: a playbook with a dead step in it is worse than no playbook.

### `hygiene` — recurring-duty upkeep on `HEARTBEAT`

Fields: `kind`, `agentId`, `op`, `anchor`, `content`, `rotationCursorKey`, `rotationCursorNamespace`, `rotationCursorBy`, `reason`. The target file is always `HEARTBEAT` — you don't name it.

```json
{
  "kind": "hygiene",
  "agentId": "8f2c1d34-5e6a-4b7c-9d80-1a2b3c4d5e6f",
  "op": "remove-section",
  "anchor": "## Watch: staging migration backfill",
  "rotationCursorKey": "dream:hygiene:cursor",
  "rotationCursorBy": 1,
  "reason": "Backfill completed 3 days ago; the duty is stale and still firing."
}
```

Rotation-cursor fields are optional; include them only when the delta advances a rotation you actually consumed.

`HEARTBEAT` is a runbook, not a log. A line recording what happened belongs in a `memory`; a line telling you to do something *again* belongs here. Once a file has filled with incident detail, resolved watches, and merged PRs, the useful delta is a removal — not another addition.

Removals need a why that outlives the receipt. `reason` shows on today's receipt and is then gone, so pair a non-obvious removal with a `memory` recording what you took out and why it's dead. Otherwise a later dream sees the gap and regrows it. This is the one case where the same lesson legitimately belongs in two deltas.

## Anchor discipline

Anchored edits are surgical on purpose: **whole-file rewrites destroy accumulated evolution.** The guard is strict, and it fails closed.

- **Quote the anchor verbatim** from `profiles.<file>.h2Anchors` in your slice — exact text, including the `## ` prefix, capitalization, punctuation, and any trailing words. Copy it; do not retype it.
- **H2 only.** `# ` and `### ` are not anchors. An anchor that doesn't match `^## ` is rejected outright.
- **Exactly one match wins.** Zero matches → HELD (`anchor not found`). Two or more sections with the same heading → HELD (`anchor is ambiguous`) — pick a different, unique anchor rather than gambling.
- **Never invent a heading.** There is no "create section" op. If the knowledge has no home, put it under the closest existing anchor, or write it as a `memory` and let a later dream find it a home.
- **`content` must not contain `## ` lines.** Introducing new H2s would create anchors nobody vetted; the guard rejects the delta. Use `### `, bullets, or plain paragraphs.
- **`append-under` lands at the END of the section**, immediately before the next H2 — not right under the heading. Write content that reads correctly as the last item in that section.
- **`replace-section` replaces the section body**, keeping the heading. Use it only when the existing text is wrong, not when it's merely incomplete — incomplete is what `append-under` is for.
- **`remove-section` deletes the heading and everything down to the next H2.** Deleting is a real option for stale duties and dead conventions; be sure it's dead.
- **`SOUL` and `IDENTITY` have a 200-character floor.** A splice that would leave either file shorter than 200 characters is HELD. Don't gut them.

Headings inside fenced code blocks are not anchors — the scanner masks fenced regions.

## Which file does it belong in

| File | Holds | Test |
| --- | --- | --- |
| `SOUL` | Durable identity, values, hard personal rules | Would it still be true after a year of different projects? |
| `IDENTITY` | Role, expertise, working style, repos you own | Does it describe *what you are for*? |
| `CLAUDE` | Working conventions and operational rules | Is it an instruction you'd want followed on every task? |
| `TOOLS` | Environment facts and tool gotchas — endpoints, ports, CLIs, "X is REST not MCP" | Would a fresh agent get it wrong without this? |
| `HEARTBEAT` | Recurring duties, watches, rotation | Does it need to happen *again* on a cadence? |

`SOUL` and `IDENTITY` are the slowest-moving files — most days they should get nothing. `TOOLS` and `CLAUDE` are where a normal day's learning belongs. Keep headings stable: a heading you rename is an anchor every future dream loses.

## HELD semantics

`dream-apply` sorts every approved delta into three buckets, and the same day's receipt shows all three:

- **APPLIED** — the write landed.
- **HELD** — the delta was rejected *before* anything was written: schema violation, unexpected field, anchor not found, anchor ambiguous, missing `content`, `content` introducing H2s, `SOUL`/`IDENTITY` under 200 characters. Nothing changed.
- **DEFERRED** — the delta was valid but the write itself errored (tool failure, downstream error).

A HELD delta carries its reason on the receipt. **Fix the anchor on the next dream; don't fight the guard.** If an anchor was ambiguous, choose a unique one. If it wasn't found, re-read `h2Anchors` — the heading probably changed or you paraphrased it. Re-proposing the identical delta unchanged just reproduces the same HELD line.

A HELD list that is empty or short is the goal. A long HELD list means the proposals weren't grounded in the slice.

## Before you submit

1. Every delta traces to a specific line in your slice — a task id, a failure reason, a tool count, a usefulness score.
2. Every `anchor` was copied from `h2Anchors`, not remembered.
3. No `content` contains a `## ` line.
4. No delta restates text already under its target anchor.
5. Every delta has a `reason` a reader can evaluate without your slice in front of them.
6. Field names stay inside the closed list for that kind.
7. If you have zero deltas, say why in one line rather than padding.

## Anti-patterns

- Proposing a whole-file rewrite instead of an anchored op.
- Inventing an anchor because the section you wanted doesn't exist.
- Writing the same lesson as both a `memory` and a `profile-op` — pick the one that will actually be read at the right moment.
- Padding the set to look productive.
- Only ever adding. A dream that never removes anything grows the files faster than it grows the signal.
- Removing something without recording why, so the next dream puts it straight back.
- Vague memories ("things went well") instead of specific ones.
- Ignoring a skill that exists and is never invoked.
- Treating a Slack post or a summary as the deliverable. The deltas are the deliverable.
