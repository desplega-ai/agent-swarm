---
date: 2026-06-26T15:10:00-08:00
researcher: Claude
git_commit: 0c1b5405
branch: main
repository: agent-swarm
topic: "Next/Vite apps on Bun — install + build spike (Bun-sole-PM vs pnpm-workspaces)"
tags: [research, spike, bun, pnpm, monorepo, frontend, ui, templates-ui, build]
status: complete
autonomy: verbose
last_updated: 2026-06-26
last_updated_by: Claude
---

# Next/Vite apps on Bun — install + build spike

**Date:** 2026-06-26
**Question:** Can Bun (as package manager AND builder/runner) cleanly install + build the two frontend apps in agent-swarm (`ui/`, `templates-ui/`), which currently use pnpm? This decides **Bun-sole-PM vs pnpm-workspaces** for the monorepo migration.
**Method:** Empirical. Throwaway detached-HEAD git worktree off `main` (`agent-swarm-nextbun-spike`). For each app: `rm -f pnpm-lock.yaml` → `bun install` → `bun run build`. Worktree removed after.
**Toolchain:** Bun 1.3.11 (system `bun`).

> **Note / scope correction:** the task framed both as "Next.js apps." Only `templates-ui/` is Next.js. **`ui/` is a Vite 7 + React Router 7 SPA** (`build: "tsc -b && vite build"`), not Next. Both were still tested end-to-end under Bun.

---

## Per-app results

### `templates-ui/` — Next.js 16.2.6 (Turbopack), React 19.2.3

- **`bun install`: OK** (exit 0). 516 packages in ~13s. Lockfile written. `node_modules/.bin/next` present.
  - 1 blocked postinstall: **`unrs-resolver@1.12.2`** (Bun's default lifecycle-script blocking). It's the oxc native resolver pulled in via `eslint-config-next` — used by **`next lint`/eslint, not by the build**. The build succeeded with it blocked. To make lint fully functional under Bun, add `unrs-resolver` to `trustedDependencies` (or `bun pm trust unrs-resolver`).
- **`bun run build` (`next build`): OK** (exit 0). Turbopack compiled in ~2.2s, TypeScript checked, **49 static pages generated**, `.next/BUILD_ID` present. The `prebuild` (`cp -r ../templates ./src/data/templates`) resolved (worktree has `../templates`).
  - Warnings only (non-fatal):
    1. **Multi-lockfile workspace-root inference** — Next saw both the root `bun.lock` and the per-app `templates-ui/bun.lock` and warned about the inferred root. **This is an artifact of running `bun install` per-app in a repo that already has a root `bun.lock`. Under a real Bun workspace (sole root lockfile, apps as members) this warning disappears.** Can also be silenced via `turbopack.root` in next config.
    2. NFT trace warning on `next.config.ts` (dynamic fs ops in `src/lib/templates.ts` import trace) — pre-existing app characteristic, not Bun-related.

### `ui/` — Vite 7 + React Router 7, React 19.2 (NOT Next.js)

- **`bun install`: OK** (exit 0). 473 packages in ~10s. `node_modules/.bin/{vite,tsc}` present. **No blocked postinstalls** (`esbuild` ships prebuilt binaries; Bun handles it without a lifecycle script).
- **`bun run build` (`tsc -b && vite build`): OK** (exit 0). **`tsc -b` passed clean (no TS errors)**, vite built in ~5s, **`dist/index.html` present**. The `ui/src/lib/modelsdev-cache.json` → `../../../src/be/modelsdev-cache.json` **symlink resolved correctly** (it materializes as the 2.2 MB `agent-runtime-models-*.js` chunk in `dist/`, proving the parent-repo file was read at build time).
  - Warning only: standard Rollup "chunks larger than 500 kB" advisory (ag-grid, mermaid, recharts, models cache). **Pre-existing, identical under pnpm — not a Bun issue.**

### Cross-repo build dependencies

- `grep` for `../../src` / `@/../` imports in `ui/src`: **none**. The only build-time dependency on the parent repo `src/` is the **`modelsdev-cache.json` symlink** (resolved fine under Bun).
- `templates-ui` depends on the sibling `../templates` data dir via its `prebuild` copy step (resolved fine).
- Implication for workspace layout: neither app imports parent TS source at build time, so they can live as workspace members without needing the parent `src/` on their module graph. The two cross-tree file references (symlink + prebuild copy) are path-relative and survive any layout that keeps relative positions intact.

---

## VERDICT

**Bun-sole-PM is VIABLE for both apps. No blockers found.** Both `bun install` and `bun run build` succeed for `templates-ui` (Next 16 / Turbopack) and `ui` (Vite 7), producing valid build artifacts (`.next/BUILD_ID`, `dist/index.html`). Nothing in either app requires pnpm specifically.

The only items surfaced are minor and **not** blockers:

1. **`unrs-resolver` blocked postinstall** (templates-ui) — cosmetic for builds; only matters for `next lint`. Fix = add to `trustedDependencies`. (Not a reason to choose pnpm; pnpm has the analogous `onlyBuiltDependencies` mechanism — `ui` already lists `esbuild` there.)
2. **Multi-lockfile / workspace-root warning** (templates-ui) — an artifact of per-app `bun install` alongside the existing root `bun.lock`. **A proper Bun workspace (one root lockfile, apps as members) eliminates it.** This actually argues *for* consolidating on a single Bun workspace.

### Recommendation

**Go Bun-sole-PM.** The repo already uses Bun as its primary runtime/PM (root `bun.lock`, `bun:sqlite`, Bun-first CLAUDE.md rules); folding `ui/` and `templates-ui/` into a single Bun workspace removes the pnpm dependency entirely, unifies the lockfile, and clears the multi-lockfile warning as a side effect. pnpm-workspaces is **not** required as a fallback — the empirical builds give no technical justification for it.

Migration follow-ups (small):
- Add `ui` + `templates-ui` to the root `package.json` `workspaces` array; delete per-app `pnpm-lock.yaml` and any per-app lockfiles (single root `bun.lock`).
- Move `templates-ui`'s `unrs-resolver` (and re-confirm `ui`'s `esbuild`) into root `trustedDependencies` if lint needs the native binary.
- Optionally set `turbopack.root` in `templates-ui` next config to silence the root-inference warning explicitly.
- Update CI (`merge-gate.yml`) frontend steps that currently call `pnpm install --frozen-lockfile` / `pnpm lint` / `pnpm exec tsc -b` to the Bun equivalents.
