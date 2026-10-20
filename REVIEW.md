# Reviewing agent-swarm PRs

Repo-specific checks for the reviewer. The format, tags and posting gate live in the `code-quality` skill. Cite every finding with `file:line`.

## What blocks here

The general blocking categories in the `code-quality` skill always apply: red or unexecuted CI, a missing or non-failing regression test, a correctness, security or data-loss bug, or a spec miss. This repo adds:

- Red or unexecuted CI on the exact head you review.
- A behavior change in root `src/` without a test that names the regression it catches (the test gate below).
- A test that matches the junk list below.
- A migration that breaks the migration checks below.
- A broken architecture invariant from `CLAUDE.md`: worker code importing `src/be/db` or `bun:sqlite`, or reading the API key without `getApiKey()`.

A finding outside the general categories and this list is a nit (at most 3) or nothing.

## Skip

Do not review generated or vendored files line by line: `openapi.json`, `docs-site/content/docs/api-reference/**`, `templates/skills/*/SKILL.md`, `src/be/seed-skills/bundled-files.generated.json`, `src/scripts-runtime/types/*.d.ts`, `claude-mod/vendor/**`, `bun.lock`, and the vendored ai-toolbox skills listed in `templates/ai-toolbox.manifest.json` (review those upstream). Check only that the generator ran.

## Test gate (root `src/`)

This gate covers production changes and tests under root `src/` only; `apps/ui/` and `apps/evals/` are out of scope for now. Documentation-only, configuration-only and dependency-bump PRs are exempt.

Before adding or changing a root `src/` test, answer all four questions:

- What observable behavior, invariant, or independent contract does it protect?
- What credible regression would make it fail?
- Why would existing coverage miss that regression? Give each contract one primary test owner at its strongest boundary. Another layer needs a distinct risk the owner cannot reach. Prefer extending a table-driven case or shared fixture over a near-duplicate.
- Does it need a production seam (export, flag, wrapper, or injection hook) that no production caller needs? If so, move the test to the real boundary.

A regression test must fail on the pre-fix code for the intended reason and pass after the repair. A regression test that never demonstrably failed does not prove the fix.

## Junk tests

Reject tests that match these patterns:

- Assertion-free coverage probes.
- Self-comparisons and identity copiers.
- Copied fixtures, inventories, manifests, or export lists.
- Exact source, import, or string greps.
- Private predicate or call-shape tests duplicated at real boundaries.
- Duplicate invocations of the same contract.
- Provider-local replays of shared helpers.
- Tests whose only purpose is preserving test-only exports, globals, or wrappers.
- Dead production code whose only callers are tests.
- Expected values produced by the helper or renderer under test.
- Mocks that implement the asserted behavior, or one identical mock standing in for different APIs.
- Fixtures that supply the receipt, admission, or callback ordering the owner should produce, or persistence asserted against a store the path never writes.
- Capability tests that restate declared flags instead of exercising the delivery or acknowledgement the flag promises.
- Negative controls that pass for an unrelated reason, such as denial from a different guard or a rejection the production path never reaches.
- Test names or fixtures that promise more than the input exercises.

## Migration checks

- A new file in `src/be/migrations/` sorts strictly above `main`'s tail and shares no ordinal with another open PR.
- An applied migration is never edited; a fix is a new migration.
- When the head merged or rebased `main`, re-check the numbering and order against `main` and grep the diff for stale migration numbers.
