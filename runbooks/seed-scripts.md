# Seeding the built-in catalog

The swarm ships **built-in entities** so its catalogs are useful from a fresh
database instead of starting empty. Today that means the `scripts` catalog (the
`script-search` / `script-run` / `swarm-script` workflow-node surface); the
mechanism is generic so future kinds (workflows, schedules, skills, …) plug in
the same way.

## The generic seeder framework — `apps/swarm/src/be/seed/`

```
apps/swarm/src/be/seed/
  types.ts      # Seeder interface + SeedItem + SeederResult
  runner.ts     # runSeeder / runSeeders — the harness
  state-db.ts   # seed_state accessors (getSeedState / recordSeedState)
  registry.ts   # SEEDERS list + runAllSeeders()
  index.ts      # barrel
```

A **`Seeder`** declares one entity *kind*. It exposes three things:

- `items()` — the version-controlled source-of-truth records, each a `SeedItem`
  with a stable `key` and a deterministic `contentHash`.
- `upstreamHash(item)` — the content hash of the *live upstream* entity, or
  `null` if it does not exist. Must use the same hashing scheme as
  `SeedItem.contentHash`.
- `apply(item, action)` — create or update the upstream entity.

Register the seeder in `registry.ts` and the harness picks it up — adding a new
kind never touches `runner.ts`.

### Versioning rule (pristine vs user-modified)

Re-seeding is **not** a blind overwrite. The harness records, per `(kind, key)`,
the hash it last seeded (`seed_state` table, migration `069`). On each run, per
item:

| upstream state                          | source state | action       |
|------------------------------------------|--------------|--------------|
| absent                                   | —            | **create**   |
| pristine (matches last-seeded hash)       | changed      | **update**   |
| pristine                                  | unchanged    | no-op        |
| user-modified (≠ last-seeded hash)        | any          | **preserve** |

"Pristine" = the live copy still hashes identically to what the framework last
wrote. A user edit makes the upstream hash diverge, so it is never clobbered —
even if the source definition also changed. With no recorded state (a
pre-existing entity, or the first run after this framework landed), an entity is
treated as pristine only when it is byte-identical to the source; otherwise it
is conservatively preserved.

## The scripts seeder — `apps/swarm/src/be/seed-scripts/`

```
apps/swarm/src/be/seed-scripts/
  index.ts            # SEED_SCRIPTS manifest + scriptsSeeder (the concrete Seeder)
  catalog/<name>.ts   # one real TypeScript file per script (the runtime source)
```

Each `catalog/<name>.ts` is a normal swarm script — `export default async function(args, ctx)`
plus an `export const argsSchema` (Zod) for validation/introspection. `index.ts`
text-imports each file so the source ships embedded in the compiled API binary.

`scriptsSeeder` uses the script name as `key` and the same SHA-256 of the source
the `scripts` table stores in `contentHash` — so a pristine upstream row hashes
identically to its catalog source, and the harness needs no script-specific
logic. `apply` mirrors the `/api/scripts/upsert` pipeline (import allowlist →
typecheck → signature + argsSchema extraction → upsert at `global` scope).

## How it is applied

`runAllSeeders()` runs every registered seeder. It runs in two places:

- **API boot** — wired into `apps/swarm/src/http/index.ts` next to `seedPricingFromModelsDev()`.
  Every boot ensures the catalog is present; steady-state boots do no extra work.
- **On demand** — `bun run seed:scripts` (`scripts/seed-scripts.ts`). Useful for a
  fresh dev DB, after a DB reset, or after editing a catalog entry. Honors
  `DATABASE_PATH`.

## Adding a script

1. Add `apps/swarm/src/be/seed-scripts/catalog/<name>.ts` — the script source. It may only
   import `zod` (and `swarm-sdk` / `stdlib` types); see the script SDK in
   `apps/swarm/src/be/scripts/typecheck.ts`.
2. Text-import it in `apps/swarm/src/be/seed-scripts/index.ts` and add a `SEED_SCRIPTS`
   manifest entry. Write a keyword-rich `description` + `intent` — they power
   `script-search` ranking.
3. `bun test apps/swarm/src/tests/seed-scripts.test.ts` typechecks every catalog script and
   verifies seeding + versioning. `bun test apps/swarm/src/tests/seed.test.ts` covers the
   generic harness.

## Adding a new seedable kind

1. Implement a `Seeder` for the kind (its own directory under `apps/swarm/src/be/`).
2. Add it to `SEEDERS` in `apps/swarm/src/be/seed/registry.ts`.

No harness or boot-path changes are needed.

The `catalog/` directory is excluded from Biome (`biome.json`) — the authoritative
gate for script source is the script-runtime typecheck, not the host repo's lint
rules. The files are still covered by `tsc` and the seed-scripts test.
