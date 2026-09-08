---
date: 2026-09-08T15:00:00Z
topic: "Public operator skill and README simplification"
status: done
---

# Public operator skill and README simplification

## Goal

Implement PR 1 from the README brainstorm. Publish one discoverable operator skill, simplify the README, and guard its distribution in CI.
The landing repository remains a later PR.

## Decisions

- Use three phases within public documentation and skill distribution (assumed).
- Follow the explicit HEAD request for docs links, with two retries (specified).
- Preserve the staged internal skill move and both symlinks (specified).
- Verify command sources against main at `40f17a958191ca81e05dc2c145d3d02712df4b7b`, fetched on September 8, 2026.
- No applicable design document exists. The swarm-apps design document describes a different system.

## Phase 1: Verify sources and write operator documentation

- [x] Resolve integration, embedding, and agent-fs minimums from code.
- [x] Replace the public skill placeholder and add detailed references.
- [x] Rewrite README and correct the Helm TL;DR.

### Verification

- Compare command source files with `git diff HEAD origin/main -- <source-files>`.
- Render the chart with `helm template swarm charts/agent-swarm --set auth.existingSecret=agent-swarm-secrets`.
- Validate Compose with `docker compose -f docker-compose.example.yml --env-file <scratch-env> config --quiet`.

## Phase 2: Guard distribution and document delivery

- [x] Add the public skill guard and wire it into package.json and Merge Gate.
- [x] Document the fourth delivery path in CLAUDE.md and runbooks/skills.md.
- [x] Preserve and verify the internal skill symlinks.

### Verification

- `bun run check:operator-skill`
- From a scratch directory: `npx -y skills@latest add /Users/taras/.t3/worktrees/agent-swarm/t3code-1acfa297 --agent claude-code -y`
- Confirm exactly one installed skill and its bundled reference files.

## Phase 3: Review and submit

- [x] Run required acceptance checks and applicable PR checks.
- [x] Review the diff with separate Standards and Spec agents. Resolve important findings.
Handoff: commit the verified changes, execute plugin/commands/create-pr.md, and stop for Taras's review.

### Verification

- `bun run lint`
- `bun run tsc:check`
- `git diff --check`
- Run the applicable commands from runbooks/ci.md before PR creation.

## Evidence

- Main command sources match this checkout. The published unversioned Helm command resolves chart `1.142.0`.
- `helm template` and Compose `config --quiet` pass with fixture credentials and generated UUIDs.
- README has 100 lines. Its Mermaid diagram matches the original exactly.
- Scratch installer found and installed exactly one skill, `agent-swarm`. All six Markdown files matched the source at installation.
- Scratch directory: `/private/tmp/agent-swarm-skill-install.X9EreJ`.
- A fresh Claude session invoked the Skill tool for `swarm-local-e2e` and loaded the original heading through the symlink.
- Root lint and typecheck pass. UI lint, build-mode typecheck, and E2E typechecks pass.
- The API contract suite passes: 9 scenarios. The UI suite passes: 40 tests, 17 expected skips.
- API, worker-slim, and eval Docker builds pass.
- Bun version, database boundary, API-key boundary, RBAC boundary, test-spawn boundary, audit columns, RBAC coverage, response coverage, and dependency graph checks pass.
- The live guard passed all 24 documentation URLs. Isolated fixtures cover retries, failure exit, fragment deduplication, malformed frontmatter, missing targets, and missing skill directory.
- The initial sandboxed test run could not bind local ports. A rerun with socket access exposed three tests affected by ambient provider credentials.
- Those three tests pass without ambient provider credentials. The complete isolated suite then reported 8342 passing, 12 skipped, and one Slack timestamp-ordering failure.
- The failing Slack file passes alone. A second complete run reproduced the same existing failure. At that point, no runtime or test code changed.

## Review decisions

- Standards: added the guard to the CI runbook and removed a single-use helper.
- Standards: retained the specified guard contract. Exactly-one installation is the acceptance check for this PR, not a ban on future public skills.
- Standards: retained the required network check in Merge Gate. Any tracked target can disappear in an unrelated file change.
- Standards minor: compact HTML keeps the README at 100 lines while preserving the original diagram and badge content.

- Spec review: no Critical, Important, or Minor findings.
- Final guard: 6 files, 31 tracked GitHub targets, 24 documentation URLs.
- Taras requested the Slack test fix before submission. The test now asserts exactly one new task by ID without relying on timestamp ordering.

## Slack test correction

- [x] Replace timestamp ordering with task identity and assert exactly one new task.
- [x] Verify the focused file: 25 passing tests.
- [x] Verify the complete unit suite after the correction: 8343 passed, 12 skipped, 0 failed.
- Standards and Spec reviews both approved the test correction. Runtime code and test inventory remain unchanged.

The final full run passed without concurrent Docker builds. A prior concurrent run timed out in three provider tests.
Final Docker builds, lint, and typecheck also pass. Final installer evidence: `/private/tmp/agent-swarm-skill-final.Ovpq1o`.

## Manual E2E

- `bun run e2e --only health,auth` checks the real API using the LOCAL_TESTING.md recipe.
- `curl -fsS http://localhost:3013/health` checks an operator deployment after Compose or Helm installation.
- `curl -fsS -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/agents` checks agent registration.
- Fresh Claude session: confirm `/swarm-local-e2e` still resolves through the symlink without executing the deployment procedure.
