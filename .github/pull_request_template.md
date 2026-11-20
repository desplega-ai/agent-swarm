<!--
Write for a human who reads this in 60 seconds. Show the change, do not narrate it.
Prose budget: about 150 words. Code blocks, mermaid, tables and <details> do not count. The check warns above 200 and fails above 300.
Plain words, active voice, one idea per sentence. No file-by-file changelog: that belongs in the task output.

The "PR Body" check enforces this template. Local check:
  bun scripts/check-pr-body.ts --title "<title>" --body-file <file>
- The **Why:**, **Risk:** and **Urgency:** lines are required.
- Every ## section is required, except sections marked:
  "optional", "bot" (required only when desplega-bot is the author), "outline" (skip only when Risk is low and the diff is 50 lines or fewer).
- The check fails on a missing part. Length: it warns above a target and fails far above it (Why: 40 words, prose: 300 words).
- Until 2026-11-26 the newer rules only warn: Before / after, the link format of Swarm provenance, the control of a fix, the length limits.

Risk is how deep to read. Urgency is when. Set Risk yourself. Copy Urgency from the request, and write "nice to have" when the request gives none.
- high: migration, auth/RBAC, secrets or scrubbing, billing/cost, data deletion, prompt or claim/routing changes that hit every agent, a public API or SDK break. The reviewer reads every 🔍 row. Adds the risk:high label.
- medium: a behaviour change on a core path, with tests. The reviewer reads the outline and the 🔍 rows, and skims the rest.
- low: docs, tests, dependency bumps, copy, isolated UI. The reviewer eyeballs the outline or before/after, then merges.
When the check passes, "asap" requests a review from tarasyarema and posts a comment. "this week" requests a review from desplega-bot.

Links:
- Image, GIF or video: GitHub user attachment (github-attach skill). Fallback for images only: agent-fs signed-url --inline (expires in 7 days).
- Doc (plan, research, report): the agent-fs live app link, under ## Swarm provenance. A share-create link only when the requester asks for one or a reader has no agent-fs login.
- Swarm task, session and workflow-run links, durable agent-fs paths and Slack permalinks: only under ## Swarm provenance.
-->

<!-- new rules fail from: 2026-11-26 -->

**Why:** <!-- max words: 25 --> <!-- hard max words: 40 --> <!-- One sentence: who sees what after the merge. Not how it works. Link public sources only (Fixes #N). -->

**Risk:** <!-- low | medium | high, then an optional reason in parentheses: "high (secrets)". -->

**Urgency:** <!-- one of: asap | this week | nice to have -->

## Before / after <!-- evidence -->

<!-- The smallest view of what a user, an agent or an operator sees change. Not the code that makes it.
Say where each view comes from: the command, and main@<sha> against this branch.
- API or MCP result, CLI output, log line, generated file, prompt or skill text: a `diff` block with the old and the new lines.
- Config or env default, computed value, performance: a table (before | after).
- Slack: frames from the Slack mock. `bun run e2e --only <scenario> --visuals <dir>`, then `bun run e2e:visuals <dir>`.
- Dashboard: one screenshot pair. Add a recording only for a new or changed interaction or flow.
- Something new: show the "after" alone.
- A one-line change: plain text, "Before: ... After: ...".
- Nothing that a user, an agent or an operator can see (a refactor, a test fix, an internal hardening): one line, "No visible change: <reason>".
  CLI output, a log line, an API result, a prompt, a skill text and a docs page are all visible. The reviewer checks this line against the diff.
At most 2 images and 1 recording here. Put more in <details>. -->

## Review map <!-- max rows: 5 -->

<!-- One row per area, not per file, unless the file is the area. Biggest risk first. Fold all ⏭ rows into one last row.
🔍 deep = read the diff · 👀 skim = check the shape · ⏭ skip = mechanical, tests, generated.

| Area | Depth | What could break |
|---|---|---|
| `path/or/area` (+N/-M) | 🔍 | 12 words or fewer |
-->

## Change outline <!-- outline --> <!-- max code lines: 12 -->

<!-- The shape of the change, not the source: pseudocode with +/- lines, a mermaid flow, or a tree with paths on the nodes.
Order: schema/API, then types, then behaviour, then files. -->

## Heads-up <!-- optional -->

<!-- Delete this section when there is nothing to say. 3 bullets or fewer: migrations, new config or env keys, breaking or
deploy-visible changes, deliberate omissions, and known risks that you did not test. No rationale essays. -->

## Verified <!-- max bullets: 3 --> <!-- fix mentions: main -->

<!-- "command → result". For a fix, the first bullet is the control on main: "On main@<sha>: <command> → fails, <message>".
The check requires the word "main" in this section for a fix title.
Do not list the CI gates: CI shows them. A pre-existing red is one line, with the counts in <details>. -->

## Swarm provenance <!-- bot --> <!-- link: Task -->

<!-- Required when desplega-bot is the author, with a [Task](url) link. Optional for others. Links only, each as [label](url).
Auth-gated links are allowed here and only here.

<details><summary>Links</summary>

- [Task](dashboard task link) · [tree](dashboard session link of the root task)
- [Ask](Slack thread permalink)
- [Workflow run](dashboard workflow-run link)
- [Plan or research](agent-fs live app link)

</details> -->
