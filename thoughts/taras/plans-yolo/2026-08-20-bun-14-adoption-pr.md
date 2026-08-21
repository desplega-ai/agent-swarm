---
date: 2026-08-20T22:11:54Z
topic: "Bun 1.4 adoption: one PR (version pin, parallel tests, runtime items)"
status: done
---

# Bun 1.4 adoption: one PR

Source: `thoughts/taras/research/2026-08-20-bun-14-adoption.md` (sections "The plan: one PR", "Worth a small PR", "Decisions", and the appended "Outcome" section).

## Goal

The repo pins Bun 1.4.0 everywhere (`packageManager`, three Dockerfiles plus the worker runtime install, CI via `packageManager`). The root test suite runs under `bun test --parallel=4` in 2 CI shards with committed timings, with no fixed test ports and a cached preload template. The pre-push hook runs only changed tests. The scripts-runtime harness child runs with `--no-orphans`, the worker binary is bytecode-compiled, the artifact servers stop without waiting on hung clients, and releases carry a license inventory. Docs and the research doc land in the same PR.

## Decisions

- Scope gate: this is bigger than a normal one-shot (4 areas). Taras chose `/one-shot` with this exact scope after the research review, so it proceeds as one PR (asked, via the prompt).
- "6 hard-coded 3013 binds" from the research doc do not exist: every spawned `src/http.ts` sets `PORT`, and 3013 appears in tests only inside URL strings. Scope for ports = every fixed or random literal port in `src/tests` (52 files). (assumed, verified by grep)
- `process.pid % 1000` and `Math.random()` port variants also move to `getFreePort()` / `port: 0`. (assumed)
- Lockfile stays `lockfileVersion: 1`: Bun 1.4.0 rewrites an existing v1 lockfile as v1 (verified with `bun add` + `bun remove`); forcing v2 means deleting the lockfile and re-resolving versions. (verified)
- Timings: first landed as a committed `test-timings.json` (macOS numbers); Taras chose the cache-based pattern from Bun's docs instead (actions/cache restore-keys + per-shard `--update-timings` + a `save-timings` merge job). Nothing committed, Linux numbers, self-refreshing. (asked)
- Preload cache key covers migrations, `db.ts`, `seed-prompt-templates.ts`, `preload.ts`, the prompt registry JSON, and `Bun.version`, because `initDb` bakes the prompt registry into the template. Cache hit must also warm the encryption-key cache (one test depended on that side effect). (verified by a failing test)
- `bun dedupe --check` NOT added to the gate: it fails today (31 duplicates) and `bun dedupe` would bump Biome 2.3.10 -> 2.4.5, zod, openai. Documented in `runbooks/ci.md` as a deliberate separate PR. (assumed)
- Per-test `{ retry }`: none of the plan's candidates needed it (watchdog = deterministic macOS-only failure; watermark = real ms race, fixed). Linux CI later surfaced one genuinely racy test (`claude-managed-adapter` tool-loop, fire-and-forget `/tmp` read-modify-write) which got `{ timeout: 30_000, retry: 2 }` plus a wider event gap; the other CI flakes were budget/window bumps. (verified on CI)
- API binary stays plain; worker binary gets `--bytecode --format=esm`. (from prompt)
- `Bun.markdown.render()` for `markdownToSlack`: skipped; a parser cannot pass the exact-output regex tests unchanged. (from prompt's condition)
- `--asset` refactor: out of scope. (from prompt)
- Port migration delegated to four Sonnet sub-agents (Codex auth on this machine returns 401; `codex login` needed) with strict file fences, same worktree, no commits. Diffs reviewed by the orchestrator.

## Todo

- [x] 1. Version alignment: packageManager, engines, Dockerfiles (+ worker runtime pin), workflows, `scripts/check-bun-version.ts` in the gate
- [x] 2. Ports: every fixed literal port in `src/tests` -> `getFreePort()` / `port: 0` (52 files)
- [x] 3. Preload template cache keyed by content hash, atomic write, kill switch env
- [x] 4. Boot deadline 15s -> 60s in the 9 `waitForServer` helpers
- [x] 5. CI: 2 shards x `--parallel=4 --shard=N/2` in merge-gate.yml and ci.yml, `--timings` from the actions cache + `save-timings` job; ci-timings total 2
- [x] 6. prek: one `test` hook via `scripts/pre-push-tests.sh` (`--changed=<merge-base>` or full run); `; true` dropped; `bun-version` hook
- [x] 7. Retry: global `retry = 3` removed; seed-scripts catalog test timeout 30s; watermark ms race fixed
- [x] 8. Runtime: `--no-orphans` in `buildSandboxedCommand` (+ test); worker bytecode build; artifact `stop(true)`; `bun pm licenses` release artifact; `bun audit fix` + dedupe notes in ci.md
- [x] 9. Bun.markdown: skipped with a note (see Decisions)
- [x] 10. Docs: LOCAL_TESTING.md, runbooks/ci.md, runbooks/docker-images.md, CLAUDE.md (ports rule, checklist, --no-orphans)
- [x] 11. Docker builds (API, worker-slim, evals) green locally (51 s / 115 s / 45 s; slim 2.11 GB, API 350 MB; bun 1.4.0 inside; bytecode binary runs)
- [x] 12. Two-axis code review (Opus x2), findings fixed (see Review notes); commit + PR; CI: see PR

## Verification

- `bun run lint` PASS (1 pre-existing warning: unused suppression in openapi-response-contract.test.ts)
- `bun run tsc:check` PASS
- `bun run check:bun-version` PASS (4 pins)
- `check-db-boundary`, `check-api-key-boundary`, `check-rbac-boundary`, `check-audit-columns`, `check:rbac-coverage`, `check:openapi-response-coverage`, `check:dep-graph`, `check-sdk-tool-registration`, `check:script-types` all PASS
- `bun install --frozen-lockfile` on 1.4.0 PASS (no lockfile change)
- Full suite `bun run test:root -- --parallel=4`: 78 s, 7855 pass / 5 fail. The 5 are the known macOS-only set (ulimit x2, drain-deadline, truncated-stdout, sandboxed-bash watchdog); all pass on Linux CI today.
- Shards with timings: 1/2 = 45 s, 4094 pass / 0 fail; 2/2 = 36 s, the same 5 known failures (+ the watermark flake, since fixed; 6/6 green on re-run).
- `bun test --parallel=4 --changed=$(git merge-base origin/main HEAD)`: 356 files for this branch. Docs-only = 0 files verified in the research; re-check after commit with `--changed=HEAD` on a clean tree.
- Docker: all three builds pass locally.
- After review fixes: full `--parallel=4` 72 s, 7854 pass / 6 fail (known 5 + one load flake in scripts-runtime-identity, passes alone); shards 32 s + 32 s, only the known 5 in shard 2; lint/tsc/all check scripts green.

## Review notes

Standards (Opus) + Spec (Opus), separate contexts. Fixed: inert 60 s boot deadline (20 s hook cap) -> `SERVER_BOOT_HOOK_TIMEOUT_MS`; 40x `server.address()` + 9x `waitForServer` duplication -> `src/tests/test-net.ts`; preload cache-hit parity (prompt resolver DI etc.) -> `initDb` fast path on hit; prune by age; `prek.toml` overlapping hooks -> `scripts/pre-push-tests.sh`; env-hygiene filter narrowed to the one key; `check-bun-version.ts` anchored regex / no `required` knob / missing-file report; `--timeout 10000` parity in merge-gate; `check:bun-version` in ci.yml + prek; `test-timings.json` in TEST filter; release license steps `continue-on-error`; docs (size table, "four pins", `runbooks/testing.md` rule 4, dangling pointers, cache wording, engines sentence).

Not changed, with reasons: `engines.bun` stays `>=1.3.12` (Taras's instruction; 1.4-only commands run only in CI); the watermark `Bun.sleep(2)` stays (sleep guarantees >= 2 ms wall clock, matches the file's two existing sleeps; changing the query to `>=` is a production semantics change); `bun dedupe --check` stays out of the gate; the 25 pre-existing local `listen()` helpers in untouched files stay (diff test); `--no-orphans` test covers the `run` form only (the `-e` form goes through the same insertion).

Follow-ups (not in this PR): fold the 25 remaining local `listen()` helpers into `test-net.ts`; a scheduled job to refresh `test-timings.json` from Linux; `bun dedupe` in its own PR.
