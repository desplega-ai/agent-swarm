# Provider Model Limit Discovery Implementation Plan

**Goal:** Discover selected-credential private gateway limits once per route setup
and use the same effective limits in new embedded OpenCode sessions and telemetry.

**Architecture:** Resolve metadata after the existing per-task key splice, before
host creation. Keep sanitized, selected-alias facts in a bounded process cache;
never write discoveries into the shared catalog. Reject explicit ceiling
conflicts; use conservative input context unless the operator confirms sum
semantics. Reconcile post-activation SDK limits before prompting.

**Tech stack:** Bun 1.4.4, TypeScript, pinned OpenCode SDK 2.4.1; no new package.

## Implementation checkpoints

1. Add an unknown-alias adapter regression and observe absent host limits on
   the baseline. Keep fixtures synthetic and servers offline.
2. Implement pure exact-alias LiteLLM normalization and effective-limit merge,
   with duplicate deployment coverage and ambiguous-field tests.
3. Add bounded transport, credential/route/execution-scope isolation,
   single-flight, TTL/backoff, stale expiry and classified diagnostics.
4. Apply host limits before creation; wait for asynchronous SDK model/plugin
   activation before checking runtime ceilings. Reject unsafe runtime bounds;
   retain smaller runtime limits in the session and context-bound notes.
5. Preserve existing public catalog output facts through store/API/runtime;
   do not add a DB migration or persist discovered metadata.
6. Add configuration validation/round-trip and catalog wire scenarios, real SDK
   activation proof, runner telemetry retention tests and operator documentation.

## Verification

- Focused parser, merge, transport, SDK and adapter tests, including the original
  failing control and conservative/sum interpretation.
- `bun run e2e --only platform-config,platformb-models`
- `bun run check:local`, `bun run test:root -- --parallel=4`, `bun run e2e`,
  `bun run e2e:ui`, type checks, lint and boundary checks per `runbooks/ci.md`.
- Dashboard checks per `apps/ui/CLAUDE.md`; docs production build per
  `docs-site/CLAUDE.md`. Report unrelated/environmental failures separately.

## Scope boundary

Only embedded OpenCode routes using the existing selected-key splice are
supported. ACP/subprocess, auth-file-only and direct OpenAI credentials remain
unsupported in this PR. No production smoke test, deployment mutation, pricing
discovery, permission expansion or automatic catalog writes.
