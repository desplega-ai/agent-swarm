# code-reviewing

You are reviewing a code diff on two independent axes:

- **Standards** — is the code well built? Judged against repo standards first, then the `desplega:engineering-standards` baseline.
- **Spec** — does it do the right thing? Judged against the strongest available statement of intent.

The axes are reviewed by **separate parallel sub-agents** and reported under **separate headings, never merged or reranked**. Code that follows every standard but implements the wrong thing must show as Standards-pass / Spec-fail — averaging the axes is how wrong-but-pretty code ships.

**Findings are NEVER produced in the main session.** The orchestrator wrote or supervised this code — it is biased toward believing the work is done and reading the diff as intended rather than as written. Both axes always run as fresh sub-agent contexts (route per `desplega:delegate-work`), even for small diffs, even when the session "already knows" the code. The orchestrator's job is the join afterwards: dedupe, verify findings against the code, discard false positives, deliver the verdict — it judges findings, it does not generate them.

## Step 1: Pin the diff

Fix the review target explicitly — never review "recent changes" by vibes:

- Phase/step review: `git diff <commit-before-phase>...HEAD` (or the phase's commit range)
- Branch/PR review: `git diff <base>...HEAD` (three-dot: merge-base, so unrelated base movement doesn't pollute the diff)
- Uncommitted work: `git diff` + `git diff --staged`

State the pinned range in the report header.

## Step 2: Find the spec source

In priority order, use the strongest statement of intent available:

1. The plan file (phase/step body + Success Criteria) — for desplega-driven implementations, including one-shot yolo plans
2. The originating issue/ticket/PR description
3. The user's request in this conversation
4. Ask via `AskUserQuestion` if none of the above pins intent

**Additionally, always:** if a design doc exists for the touched system (`thoughts/*/design-docs/<system-slug>.md`), it is a spec source **on top of** whichever ranked source applies, never a fallback — pass it to the Spec agent alongside the primary source. Its Invariants are spec, not style, and bind even when the plan doesn't restate them (see `desplega:design-docs`).

## Step 3: Fan out two sub-agents (parallel, background)

Route per `desplega:delegate-work`: **Sonnet** for routine scope, **Opus** for complex, security-sensitive, or cross-cutting diffs (and for reviewing Codex sol output). Each agent gets the pinned diff range and ONLY its own axis — separate contexts are the point; neither sees the other's brief.

**Standards agent prompt must include:** the repo's documented standards (CLAUDE.md/AGENTS.md excerpts, lint/style docs) with "repo overrides baseline"; the `desplega:engineering-standards` tests and smell table as the baseline; instruction to cite the failed test/smell by name with `file:line`.

**Spec agent prompt must include:** the spec source verbatim (or its path to read); instruction to check three failure classes — (a) requirements missing or only partially implemented, (b) behavior nobody asked for (scope creep), (c) requirements that *look* implemented but are wrong (edge cases, inverted conditions, unverified claims — read the code, don't trust names); plus verification: do the plan's automated checks actually cover the requirement, and do they pass?

## Step 4: Aggregate — separately

```markdown
## Code Review — <range>

### Standards
- [severity] file:line — finding (fails <test/smell name>)
...or: No standards findings.

### Spec
- [severity] requirement — finding (missing / scope creep / looks-done-but-wrong)
...or: Implements the spec as stated.
```

Severities: **Critical** (must fix before merge/phase close) / **Important** (should fix) / **Minor** (note it). The orchestrator judges the join: dedupe, discard false positives after reading the code yourself, then present. Sub-agent findings are advisory — the final verdict is never delegated (per `desplega:delegate-work`).

## Step 5: Resolve

- In implementing/v-implementing flows: Critical findings block the phase/step from closing; fix and re-verify before commit. Important findings: fix or get explicit user deferral. Minor: note in the report.
- Standalone reviews: present both sections, offer to fix Critical/Important findings.
- In Autopilot: fix Critical + Important automatically, log Minor; never silently drop a Critical.

## Notes

- This skill reviews **code**; `desplega:reviewing` reviews documents; `desplega:verifying` audits plan completeness after implementation. verifying answers "did we do everything the plan said"; the Spec axis here answers "is what we did actually right" — run both at final audit, they catch different failures.
- No slash command on purpose — Claude Code ships a built-in `/code-review`; this skill is invoked by name (`desplega:code-reviewing`) or automatically by the implementing skills.
