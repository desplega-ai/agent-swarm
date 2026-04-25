# Agent Swarm Docs Site

Fumadocs v16 + Next.js 16 documentation site. Content is MDX under `content/docs/`. Package manager: **pnpm**. Deploys to **Vercel**.

## Project map

```
app/                     # Next.js App Router (layout, docs route, llms.txt, sitemap, robots)
content/docs/
  (documentation)/       # Route group: guides, concepts, architecture, reference, releases
  api-reference/         # AUTO-GENERATED from ../openapi.json — do not hand-edit
components/mdx/          # Custom MDX components (Mermaid, etc.)
lib/                     # source.ts (Fumadocs source), openapi.ts, content-negotiation.ts
scripts/generate-docs.ts # Regenerates content/docs/api-reference/ from OpenAPI spec
source.config.ts         # Fumadocs MDX config
mdx-components.tsx       # Global MDX component registry
```

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
