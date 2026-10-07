<!--
Write for a human who eyeballs this in 60 seconds. Show the change, do not narrate it.
Prose budget: about 250 words. Code blocks, mermaid, tables and <details> do not count. The check warns above 300.
Plain words, active voice, one idea per sentence. No file-by-file changelog: that belongs in the task output.

The "PR Body" check enforces this template. Local check:
  bun scripts/check-pr-body.ts --title "<title>" --body-file <file>
- The **Why:** and **Risk:** lines are required.
- Every ## section is required, except sections marked:
  "fix" (only for fix: titles), "ui" (only when the diff touches apps/ui/ or apps/templates-ui/),
  "bot" (only when desplega-bot is the author), "outline" (skip only when Risk is low and the diff is 50 lines or fewer).

Risk is how deep to read. Urgency is when. Set Risk yourself; copy Urgency from the request.
- high: migration, auth/RBAC, secrets or scrubbing, billing/cost, data deletion, prompt or claim/routing changes that hit every agent, a public API or SDK break. The reviewer reads every 🔍 row. Adds the risk:high label.
- medium: a behaviour change on a core path, with tests. The reviewer reads the outline and the 🔍 rows, and skims the rest.
- low: docs, tests, dependency bumps, copy, isolated UI. The reviewer eyeballs the outline or before/after, then merges.

Links:
- Image or GIF: GitHub user attachment (github-attach skill). Fallback only: agent-fs signed-url --inline (expires in 7 days).
- Video (mp4): GitHub user attachment, else an agent-fs share-create link. Never a presigned link: it downloads.
- Doc (plan, research, report): agent-fs share-create link.
- Swarm task, session and workflow-run links, durable agent-fs paths and Slack permalinks: only under ## Swarm provenance.
-->

**Why:** <!-- One sentence: the problem, and what is true after merge. Link public sources only (Fixes #N). -->

**Risk:** <!-- low | medium | high, then an optional reason in parentheses: "high (secrets)". -->

## Review map

<!-- One row per area, not per file, unless the file is the area. Biggest risk first.
🔍 deep = read the diff · 👀 skim = check the shape · ⏭ skip = mechanical, tests, generated.

| Area | Depth | Why |
|---|---|---|
| `path/or/area` (+N/-M) | 🔍 | what could break |
-->

## Change outline <!-- outline -->

<!-- 1 or 2 views that show the shape of the change. Pick the smallest one that makes the point:
- logic: pseudocode with +/- lines (diff the shape, not the source),
- flow or interaction: mermaid,
- structure: a tree with paths on the nodes.
Order: schema/API, then types, then behaviour, then files. -->

## Before / after <!-- ui -->

<!-- Required when the diff touches apps/ui/ or apps/templates-ui/. Optional elsewhere (CLI output, a log line, an API response).

| Before (main) | After |
|---|---|
| ![before](github-attachment-url) | ![after](github-attachment-url) |

Recording: a GitHub attachment mp4 on its own line, or an agent-fs share-create link. Required for interaction or flow changes. -->

## Repro <!-- fix -->

<!-- 6 steps or fewer, on main. First line: "On: main@<sha>, <deployment>". "See #<number>" is fine. -->

## Heads-up

<!-- 3 bullets or fewer. Only: migrations, new config or env keys, breaking or deploy-visible changes, deliberate omissions.
"None." is a valid answer. No rationale essays. -->

## Verified

<!-- 3 bullets or fewer, "command → result". Include the "fails before the fix" control.
A pre-existing red is one line ("SKIP=test: the same N failing names on clean main"), with the counts in <details>. -->

## Urgency <!-- pick one -->

<!-- Check exactly one. Agents: copy the urgency from the request. If the request gives none, check "nice to have".
When the PR Body check passes: "asap" requests a review from tarasyarema and posts a comment. "this week" requests a review from desplega-bot. -->

- [ ] asap
- [ ] this week
- [ ] nice to have

## Swarm provenance <!-- bot -->

<!-- Required when desplega-bot is the author. Auth-gated links are allowed here and only here.
- Task: <dashboard task link> · tree: <dashboard session link of the root task>
- Ask: <Slack thread permalink>
- Workflow run: <dashboard workflow-run link> (if any)
- Plan / research: <agent-fs share-create link> (durable: <live agent-fs path>) -->
