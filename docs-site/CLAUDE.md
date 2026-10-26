# Agent Swarm Docs Site

Fumadocs v16 + Next.js 16 documentation site. Content is MDX under `content/docs/`. Package manager: **pnpm**. Deploys to **Vercel**.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install deps (runs `fumadocs-mdx` postinstall to generate `.source/`) |
| `pnpm dev` | Dev server with hot reload |
| `pnpm build` | Production build — run this before pushing to catch what Vercel will catch |
| `pnpm exec tsc --noEmit` | Type check (no `typecheck` script defined in this workspace) |
| `pnpm generate-docs` | Regenerate `content/docs/api-reference/**` from `../openapi.json` |

No `lint` script in this workspace. Root Biome linting does not cover `docs-site/`.

<important if="you are writing or editing an MDX file under content/docs/">

## MDX authoring rules

- **Frontmatter:** `title` + `description` (both required by convention). API-reference pages also set `full: true`.
- **`agent` frontmatter (playbooks and opted-in guides):** feeds the docs index in the seeded `swarm-docs` skill, which the lead uses to offer a page. Every page under `playbooks/` needs `agent.when` unless it sets `agent.offer: false`; a guide opts in with `agent.offer: true` plus `when`. Write `when` as one sentence of the user's intent in their words ("Someone wants deploy frequency and lead time reported weekly"), not the feature name. Optional: `notWhen` (when not to offer) and `template` (a local template id such as `community/dora-metrics`). After any frontmatter change, run `bun run build:docs-index` from the repo root; CI fails on drift.
- **Globally available components** (no import needed): `Callout`, `Mermaid`, `APIPage`. Registered by `fumadocs-ui/mdx` defaults + `mdx-components.tsx`.
- **Must be imported explicitly at the top of the MDX file** — anything else from Fumadocs, notably `Tab` / `Tabs`:
  ```mdx
  import { Tab, Tabs } from "fumadocs-ui/components/tabs";
  ```
  If you use a component without importing it, the MDX still compiles but the component renders as a plain HTML tag — silent failure. Reference files: `guides/harness-providers.mdx`, `guides/x402-payments.mdx`.
- **Page ordering:** add new pages to the sibling `meta.json` `pages` array. Files not listed still render but won't appear in the sidebar at the intended position.
- **Verify before pushing:** run `pnpm build`. A failed import, missing component, or malformed frontmatter only surfaces at build time — and will fail the Vercel deploy if pushed unverified.

</important>

<important if="you are modifying content under content/docs/api-reference/ or anything that affects API documentation">

## API reference is generated

Every file under `content/docs/api-reference/` is produced by `scripts/generate-docs.ts` from `../openapi.json`. Each file carries a `{/* This file was generated ... Do not edit manually. */}` banner.

- **Never hand-edit** these files — your change will be wiped on the next regeneration.
- To change an API page, change the underlying route definition (`src/http/` in the root project), then run `bun run docs:openapi` from the repo root (updates `openapi.json` **and** the docs-site files — see root CLAUDE.md).
- If `openapi.json` already changed and you only need to regenerate the docs-site MDX: `pnpm generate-docs`.

</important>
