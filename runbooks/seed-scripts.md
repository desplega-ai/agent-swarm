# Seeding the built-in catalog

The swarm ships **built-in entities** so its catalogs are useful from a fresh
database instead of starting empty. Today that means the `scripts` catalog (the
`script-search` / `script-run` / `swarm-script` workflow-node surface); the
mechanism is generic so future kinds (workflows, schedules, skills, …) plug in
the same way.

## The generic seeder framework — `src/be/seed/`

```
src/be/seed/
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

## The scripts seeder — `src/be/seed-scripts/`

```
src/be/seed-scripts/
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

- **API boot** — wired into `src/http/index.ts` next to `seedPricingFromModelsDev()`.
  Every boot ensures the catalog is present; steady-state boots do no extra work.
- **On demand** — `bun run seed:scripts` (`scripts/seed-scripts.ts`). Useful for a
  fresh dev DB, after a DB reset, or after editing a catalog entry. Honors
  `DATABASE_PATH`.

## Adding a script

1. Add `src/be/seed-scripts/catalog/<name>.ts` — the script source. It may only
   import `zod` (and `swarm-sdk` / `stdlib` types); see the script SDK in
   `src/be/scripts/typecheck.ts`.
2. Text-import it in `src/be/seed-scripts/index.ts` and add a `SEED_SCRIPTS`
   manifest entry. Write a keyword-rich `description` + `intent` — they power
   `script-search` ranking.
3. `bun run test:root -- src/tests/seed-scripts.test.ts` typechecks every catalog script and
   verifies seeding + versioning. `bun run test:root -- src/tests/seed.test.ts` covers the
   generic harness.

## Adding a new seedable kind

1. Implement a `Seeder` for the kind (its own directory under `src/be/`).
2. Add it to `SEEDERS` in `src/be/seed/registry.ts`.

No harness or boot-path changes are needed.

The `catalog/` directory is excluded from Biome (`biome.json`) — the authoritative
gate for script source is the script-runtime typecheck, not the host repo's lint
rules. The files are still covered by `tsc` and the seed-scripts test.

## Live star-history SVG pages

The `star-history-refresh` seed uses the original chart renderer extracted into
`src/be/seed-scripts/catalog/star-history-renderer.ts`. The CLI generator imports
that same module (Node 22.18+ supports its erasable TypeScript); the seed manifest
inlines it into the script source because the sandbox permits no local imports.

Arguments: `{dryRun: true}` fetches and renders without publishing pages.
`{authenticated: false}` uses unauthenticated GitHub requests; the default uses
the `GITHUB_TOKEN` credential binding at `api.github.com`, in a request header only.
Both paths use per-page ETags. A failed/incomplete fetch retains the entire prior
series in KV namespace `star-history:desplega-ai/agent-swarm`, key `series`.
Without a cached series, failure publishes nothing. The result exposes `stale`
and `fetchedAt`; cached data does not acquire a false fresh timestamp.

After SVG support deploys, run `{dryRun: false}` twice under the intended schedule
creator and verify identical page IDs and `apiUrl` values. The fixed slugs are
`star-history-light` and `star-history-dark`. Public images use
`<PUBLIC_MCP_BASE_URL (or MCP_BASE_URL)>/p/<page-id>`, not the SPA `/pages/<id>` URL.
The MCP tool upserts by `(agentId, slug)`. Script schedules execute as
`createdByAgentId` (fallback `schedule`), so a Lead-created schedule publishes
Lead-owned pages, which differ from worker-owned test pages. Keep that creator
identity stable and avoid overlapping refresh runs.

The page content type is exactly `image/svg+xml`. Public responses retain raw SVG
bytes, cache for 1800 seconds, and include nosniff and a sandboxed CSP with
`default-src 'none'; style-src 'unsafe-inline'`. Protected SVGs retain the
normal page access gate and use `private, no-store`.

The live pages are published and Lead-owned:

- Light: https://api.desplega.agent-swarm.dev/p/4b5cdc17c45e4a63845fb0a71ed9609c
- Dark: https://api.desplega.agent-swarm.dev/p/e3473addceb348c0bed6cb93bd5aa532

The hourly schedule `star-history-refresh-hourly` (id
`3ef2c51c-5d21-4c1b-a19b-fd10d0c57022`) runs at `23 * * * *` UTC with
`targetType: "script"`. The schedule must stay created by Lead
`d454d1a5-4df9-49bd-8a89-e58d6a657dc3`: script schedules execute as
`createdByAgentId`, and pages upsert by `(agentId, slug)`. A different creator
mints new page ids and silently breaks the README embed.
