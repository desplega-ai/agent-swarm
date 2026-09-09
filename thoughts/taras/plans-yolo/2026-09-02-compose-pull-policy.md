---
date: 2026-09-02T14:15:00Z
topic: "Configurable onboarding Compose pull policy"
status: done
---

# Configurable onboarding Compose pull policy

## Goal

The onboarding CLI accepts an explicit Docker Compose pull policy, defaults to `always`, and writes the selected value to every generated service. The CLI reference documents the option and generator tests cover the default and supported overrides.

## Decisions

- Use an onboard CLI flag because `--preset`, `--yes`, and `--dry-run` are already the onboarding configuration convention. (assumed)
- Keep `always` as the state default so interactive and non-interactive callers retain current behavior. (required)
- Reject values outside `always`, `missing`, and `never` at the onboarding boundary. (required)

## Todo

- [x] Thread the typed pull policy from CLI arguments into onboarding state.
- [x] Render the selected policy for the API and every worker service.
- [x] Add generator coverage for the default and supported overrides.
- [x] Update onboarding CLI documentation and help.
- [x] Run focused and repository verification, then review the diff.

## Verification

- `bun test src/tests/onboard-compose.test.ts`
- `bun run lint`
- `bun run tsc:check`
- `bun run test:root`

The focused tests, lint, and typecheck pass. The full suite was attempted and hit the existing Bun 1.4.0 `eval-harness.ts` abort in workflow/app-sync tests; `bun test src/tests/workflow-swarm-script.test.ts` reproduces the same 5-pass/16-fail runtime crash on the original main checkout.
