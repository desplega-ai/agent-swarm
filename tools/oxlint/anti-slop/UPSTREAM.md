# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22`, `src/` only. MIT, see `LICENSE`.

Local changes:

- Removed the Effect rules (`effect/`). This repo does not use Effect.
- Removed the `*.test.ts` RuleTester suites. `bun test` would collect them, and the oxlint `RuleTester` does not run under Bun. Get them from upstream when you edit a rule.
- `shared/dictionary-types.ts`: `unsafeMembers[0] ?? null`, so the file typechecks under this repo's `noUncheckedIndexedAccess`.

`oxlint.config.ts` at the repo root turns on a subset of rules. `bun run lint:slop` runs it, and the merge gate runs it in the Lint and Type Check job.

## Rules not yet on

Counts are for `src`, `apps/evals` and `packages` on 2026-10-10.

| Rule | Hits | Why it is off |
|---|---|---|
| `no-chained-type-assertions` | 63 prod, 363 test | Good next candidate. Fix `as unknown as` casts or add a reason. |
| `no-array-filter-map` | 80 | Taste. The fix uses iterator helpers. |
| `no-reflect-get`, `no-reflect-apply` | 6 | Every hit is a `Proxy` trap, where `Reflect` is the correct idiom. |
| `no-module-mocking` | 0 | Checks Vitest/Jest only. It does not see `bun:test` `mock.module`. |
| `no-shape-in-symbol-names` | 319 | Conflicts with the Zod `*Shape` naming convention. |
| `require-readable-spacing` | 41k | Style only. Autofixable, and Biome keeps the result. |
| `require-safety-comment-for-type-assertion` | 5.8k | Too much churn. |
| `no-runtime-typeof`, `no-unknown-*`, `no-unsafe-dictionary-type`, `no-known-value-widening`, `no-conditional-empty-object-spread` | 300 to 1.7k each | Conflict with how we parse MCP and JSON input. |
