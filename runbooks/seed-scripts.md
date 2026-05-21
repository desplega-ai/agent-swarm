# Seed scripts catalog

The swarm `scripts` catalog (the `script-search` / `script-run` / `swarm-script`
workflow-node surface) ships with a set of **built-in global scripts** so the
catalog is useful from a fresh database instead of starting empty.

## Where it lives

```
src/be/seed-scripts/
  index.ts            # SEED_SCRIPTS manifest + seedGlobalScripts()
  catalog/<name>.ts   # one real TypeScript file per script (the runtime source)
```

Each `catalog/<name>.ts` is a normal swarm script — `export default async function(args, ctx)`
plus an `export const argsSchema` (Zod) for validation/introspection. `index.ts`
text-imports each file so the source ships embedded in the compiled API binary.

## How it is applied

`seedGlobalScripts()` mirrors the `/api/scripts/upsert` pipeline (import
allowlist → typecheck → signature + argsSchema extraction → upsert at `global`
scope). It is **idempotent**: a script whose content hash is unchanged is
skipped before the expensive steps run.

It runs in two places:

- **API boot** — wired into `src/http/index.ts` next to `seedPricingFromModelsDev()`.
  Every boot ensures the catalog is present; steady-state boots do no extra work.
- **On demand** — `bun run seed:scripts` (`scripts/seed-scripts.ts`). Useful for a
  fresh dev DB, after a DB reset, or after editing a catalog script.
  Honors `DATABASE_PATH`.

## Adding a script

1. Add `src/be/seed-scripts/catalog/<name>.ts` — the script source. It may only
   import `zod` (and `swarm-sdk` / `stdlib` types); see the script SDK in
   `src/be/scripts/typecheck.ts`.
2. Text-import it in `src/be/seed-scripts/index.ts` and add a `SEED_SCRIPTS`
   manifest entry. Write a keyword-rich `description` + `intent` — they power
   `script-search` ranking.
3. `bun test src/tests/seed-scripts.test.ts` typechecks every catalog script and
   verifies the seed is idempotent.

The `catalog/` directory is excluded from Biome (`biome.json`) — the authoritative
gate for script source is the script-runtime typecheck, not the host repo's lint
rules. The files are still covered by `tsc` and the seed-scripts test.
