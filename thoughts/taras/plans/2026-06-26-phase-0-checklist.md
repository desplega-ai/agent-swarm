---
date: 2026-06-26
status: ready-to-execute (intended for a fresh session)
phase: 0
plan-of-record: thoughts/taras/plans/2026-06-26-monorepo-collapsed-first.md
spike: thoughts/taras/research/2026-06-26-next-on-bun-spike.md
---

# Phase 0 — Workspace Scaffold (handoff checklist)

**Goal:** turn the repo into a workspace + Turbo monorepo where the *existing* apps (`ui/`, `templates-ui/`, `evals/`, `evals/ui`) become workspace members **without moving a single line of `src/`**. Everything must pass byte-identically. This is the foundation for Phases 1–6 (see the plan of record §8).

**Scope rule:** Phase 0 changes ONLY root config + the two Next apps' package manager. No `src/` moves, no path-alias changes, no Docker, no CI-to-Turbo conversion. If a step needs `src/` to move, it belongs to a later phase — stop.

---

## 0. Branch / worktree
```bash
git -C /Users/taras/Documents/code/agent-swarm fetch origin
git worktree add ../agent-swarm-phase-0 -b chore/monorepo-phase-0-scaffold origin/main
cd ../agent-swarm-phase-0
ln -sfn /Users/taras/Documents/code/agent-swarm/.env .env   # if tests need it
```

## 1. PM decision gate — **RESOLVED: Bun-sole (spike passed 2026-06-26)**
The Next-on-Bun spike (`thoughts/taras/research/2026-06-26-next-on-bun-spike.md`) confirmed **Bun-sole-PM is viable with no blockers** (Bun 1.3.11, empirical in a throwaway worktree):
- `templates-ui/` — **Next.js 16.2.6 + Turbopack**, React 19.2: `bun install` + `bun run build` → OK (49 static pages, `.next/BUILD_ID` present).
- `ui/` — **Vite 7 + React Router 7 (NOT Next.js)**, `build: tsc -b && vite build`: `bun install` + `bun run build` → OK (`dist/index.html`).
- No cross-repo `src/` build imports except the `ui/src/lib/modelsdev-cache.json` symlink, which resolves fine under Bun.

→ **Take the Bun-sole path (§2A). The §2B pnpm fallback is NOT needed** (kept below only as a historical note; there is no technical justification for it).

Two non-blockers to handle while doing §2A:
- Add `unrs-resolver` to a root `trustedDependencies` array (its blocked postinstall only affects `next lint`, not the build).
- The per-app "multiple lockfiles / workspace-root" Next warning **disappears** under the single-root Bun workspace — it argues *for* consolidating, not against.

## 2A. Bun-sole path (primary)
1. Root `package.json` — add:
   ```jsonc
   "workspaces": ["ui", "templates-ui", "evals", "evals/ui"],
   "catalog": {
     // pin the cross-cutting shared deps so members don't drift
     "react": "^19.2.3", "zod": "^4.2.1", "typescript": "^5",
     "@opentelemetry/api": "^1.9.1", "@anthropic-ai/sdk": "^0.93.0"
     // (extend as real shared deps surface; packages/* + apps/* globs are added in later phases)
   }
   ```
2. `rm ui/pnpm-lock.yaml templates-ui/pnpm-lock.yaml`
3. `bun install` at root → single `bun.lock`.
4. Confirm both Next apps build under the workspace (see §4).

## 2B. pnpm-workspaces fallback (only if the spike blocks Bun)
- Add `pnpm-workspace.yaml` listing `ui`, `templates-ui` (Next apps stay pnpm); keep `bun.lock` for the root + `evals`.
- Document the dual-PM boundary in CONTRIBUTING. Turbo still orchestrates both.
- Everything below is identical except install commands per member.

## 3. Turborepo
```bash
bun add -D turbo            # (or pin via catalog)
```
`turbo.json` (root) — passthrough tasks only for now:
```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "typecheck": { "dependsOn": ["^typecheck"], "cache": true },
    "test":      { "cache": true },
    "lint":      { "cache": true },
    "dev":       { "cache": false, "persistent": true }
  }
}
```
Add root scripts that delegate (keep ALL existing scripts working):
`"mono:build": "turbo run build"`, `"mono:test": "turbo run test"`, etc. (Don't rename the existing `start:http`, `worker`, `lead`, `lint`, `tsc:check`, etc. — Phase 6 rewires CI.)

## 4. Verification — every one must pass (byte-identical behavior)
```bash
bun install --frozen-lockfile
bun run tsc:check
bun run lint                                   # CI runs read-only `biome check`
bun test
bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh
bun scripts/check-sdk-tool-registration.ts
# Next apps build under the new workspace (THE de-risk):
( cd ui && bun run build )
( cd templates-ui && bun run build )
# evals is its own bun package — adding it as a member must not break its isolated deps:
( cd evals && bun test )
# Docker untouched in Phase 0 — prove it still builds:
docker build -f Dockerfile . && docker build -f Dockerfile.worker .
# Turbo graph wiring (no execution):
bunx turbo run build --dry-run
```

## 5. CI (minimal in Phase 0 — full Turbo cutover is Phase 6)
- Keep `merge-gate.yml` jobs as-is. Only fix install steps made stale by the PM change:
  - Search `.github/workflows/*` for `pnpm` (the `cd ui && pnpm install` / `cd templates-ui && pnpm install` steps + the qa-use gate). On the Bun-sole path, switch those to a single root `bun install --frozen-lockfile`.
  - The `qa-use` frontend gate still applies to `ui/`/`templates-ui/` changes — this PR touches their lockfiles, so include a qa-use session/screenshots per the merge gate.
- Do NOT convert per-task steps to Turbo yet.

## 6. PR
- One PR: **"chore(monorepo): Phase 0 — workspaces + Turbo scaffold (no code moves)"**.
- Body: link the plan of record + spike; state explicitly "no `src/` moved, behavior byte-identical"; paste the §4 gate results.
- **Merging `main` auto-deploys to prod** — confirm the API + worker images build and boot before merge. This PR is config-only, but treat the merge as a deploy.

## Watch-items / risks
- **Next-on-Bun** — the spike gates §1; if it fails, §2B, no heroics.
- **CI pnpm references** — the two Next-app install steps + qa-use must move to `bun install` (Bun-sole path).
- **evals isolation** — `evals/` has its own deps (`@libsql/client`, etc.); after adding it as a member, `cd evals && bun test` MUST still pass (hoisting can change resolution).
- **`bunfig.toml` `pathIgnorePatterns = ["evals/**"]`** stays correct (root `bun test` still must not glob evals).
- **catalog drift** — only pin deps that are genuinely shared; over-pinning fights member-specific versions.

## Next (Phase 1, separate PR/session)
tsconfig `tsconfig.base.json` + the `@/* → packages` path-alias bridge + the ts-morph codemod tool + `packages.map.json` manifest. No code moves yet. (Plan of record §8 Phase 1.)
