/**
 * Fixture generator for the `fanout-research` scenario (swarm-evals plan v2, Phase 7).
 *
 * Emits `fanout-research-history.sql`: an INSERT-only seed of 45 terminal
 * `agent_tasks` rows, one incident postmortem each, split across three region
 * shards (emea 17, amer 15, apac 13). NO schema, NO `_migrations`: the schema is
 * built pre-boot from the real migrations (see bootStack in src/swarm/sandbox.ts).
 *
 * Each row's task text is a small structured record:
 *
 *   INC-2101: payments-api certificate expired     <- title
 *   region: emea
 *   service: payments-api
 *   root_cause: cert-expiry
 *   downtime_minutes: 42
 *
 * The answer key lives ONLY in these rows (never in a prompt). The dataset is
 * built so the merge is real work, not a copy:
 *   - every region's most common root cause differs from the overall one
 *     (emea cert-expiry, amer config-drift, apac capacity, overall
 *     dependency-failure), so a lead that only merges per-region "top causes"
 *     gets the overall answer wrong; it needs per-cause counts from each shard;
 *   - per-region downtime totals are distinct 3-digit numbers, so each shard's
 *     result is identifiable in a worker's output (the "delegated once" check);
 *   - the single longest incident (184 min) is unique by a wide margin.
 *
 * Deterministic: no randomness. Re-run with
 * `bun scenarios/fixtures/generate-fanout-research-history.ts` after any change,
 * then mirror the printed answer key into `scenarios/fanout-research.ts`.
 */

import { validateSqlDumpText } from "../../src/runner/index.ts";

const OUT = new URL("./fanout-research-history.sql", import.meta.url);

type Region = "emea" | "amer" | "apac";
type Cause = "cert-expiry" | "dependency-failure" | "config-drift" | "capacity" | "bad-deploy";

const SYMPTOM: Record<Cause, string> = {
  "cert-expiry": "certificate expired",
  "dependency-failure": "upstream dependency outage",
  "config-drift": "configuration drift",
  capacity: "capacity exhaustion",
  "bad-deploy": "bad deploy rolled back",
};

/** [service, root cause, downtime minutes], per region. Hand-authored. */
const ROWS: Record<Region, [string, Cause, number][]> = {
  emea: [
    ["payments-api", "cert-expiry", 42],
    ["frankfurt-gateway", "cert-expiry", 35],
    ["identity-sso", "cert-expiry", 51],
    ["billing-webhooks", "cert-expiry", 28],
    ["dublin-cdn", "cert-expiry", 64],
    ["ledger-sync", "cert-expiry", 39],
    ["search-index", "dependency-failure", 47],
    ["checkout-web", "dependency-failure", 33],
    ["notifications", "dependency-failure", 58],
    ["paris-edge", "dependency-failure", 26],
    ["orders-db", "config-drift", 22],
    ["catalog-api", "config-drift", 45],
    ["auth-proxy", "config-drift", 31],
    ["london-queue", "capacity", 54],
    ["reporting-etl", "capacity", 37],
    ["mobile-bff", "bad-deploy", 29],
    ["pricing-service", "bad-deploy", 41],
  ],
  amer: [
    ["virginia-gateway", "config-drift", 36],
    ["payments-api", "config-drift", 44],
    ["identity-sso", "config-drift", 27],
    ["orders-db", "config-drift", 53],
    ["catalog-api", "config-drift", 31],
    ["oregon-cdn", "config-drift", 48],
    ["checkout-web", "dependency-failure", 62],
    ["search-index", "dependency-failure", 38],
    ["notifications", "dependency-failure", 41],
    ["billing-webhooks", "dependency-failure", 29],
    ["toronto-edge", "dependency-failure", 57],
    ["mobile-bff", "bad-deploy", 33],
    ["pricing-service", "bad-deploy", 46],
    ["ledger-sync", "cert-expiry", 25],
    ["reporting-etl", "capacity", 71],
  ],
  apac: [
    ["tokyo-edge-cache", "capacity", 184],
    ["singapore-queue", "capacity", 96],
    ["orders-db", "capacity", 43],
    ["search-index", "capacity", 52],
    ["reporting-etl", "capacity", 38],
    ["sydney-gateway", "dependency-failure", 49],
    ["checkout-web", "dependency-failure", 34],
    ["notifications", "dependency-failure", 61],
    ["payments-api", "dependency-failure", 27],
    ["mobile-bff", "bad-deploy", 32],
    ["catalog-api", "bad-deploy", 44],
    ["identity-sso", "config-drift", 30],
    ["mumbai-cdn", "cert-expiry", 19],
  ],
};

const INC_BASE: Record<Region, number> = { emea: 2101, amer: 2401, apac: 3301 };

interface Incident {
  id: string;
  title: string;
  task: string;
  region: Region;
  cause: Cause;
  minutes: number;
  createdAt: string;
  finishedAt: string;
}

function id(n: number): string {
  return `fa0e7a5e-f000-4000-b000-${n.toString(16).padStart(12, "0")}`;
}

function ts(dayOffset: number, hour: number): string {
  return new Date(Date.UTC(2026, 6, 1 + dayOffset, hour, 0, 0)).toISOString(); // July 2026
}

const INCIDENTS: Incident[] = [];
let ordinal = 0;
for (const region of ["emea", "amer", "apac"] as Region[]) {
  ROWS[region].forEach(([service, cause, minutes], i) => {
    ordinal++;
    const title = `INC-${INC_BASE[region] + i}: ${service} ${SYMPTOM[cause]}`;
    INCIDENTS.push({
      id: id(ordinal),
      title,
      task: [
        title,
        `region: ${region}`,
        `service: ${service}`,
        `root_cause: ${cause}`,
        `downtime_minutes: ${minutes}`,
      ].join("\n"),
      region,
      cause,
      minutes,
      createdAt: ts(ordinal % 28, 8 + (ordinal % 9)),
      finishedAt: ts(ordinal % 28, 10 + (ordinal % 9)),
    });
  });
}

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Terminal, API-sourced rows; the region also rides in `tags` for tag-filtered queries. */
function insert(t: Incident): string {
  const cols =
    "id, task, status, source, priority, tags, createdAt, lastUpdatedAt, finishedAt, output";
  const vals = [
    lit(t.id),
    lit(t.task),
    lit("completed"),
    lit("api"),
    "50",
    lit(JSON.stringify(["incident", `region:${t.region}`])),
    lit(t.createdAt),
    lit(t.finishedAt),
    lit(t.finishedAt),
    lit("Postmortem filed."),
  ].join(", ");
  return `INSERT INTO agent_tasks (${cols}) VALUES (${vals});`;
}

const out = [
  "-- ==== fanout-research seed (swarm-evals Phase 7) — generated by generate-fanout-research-history.ts ====",
  "-- INSERT-only incident history; every row is terminal (completed).",
  "-- DO NOT hand-edit: re-run `bun scenarios/fixtures/generate-fanout-research-history.ts`.",
  ...INCIDENTS.map(insert),
  "-- ==== end fanout-research seed ====",
  "",
].join("\n");

const invalid = validateSqlDumpText(out);
if (invalid) throw new Error(`generated fixture is invalid: ${invalid}`);

// ---- answer key, with the properties the scenario relies on asserted ----
const regions: Region[] = ["emea", "amer", "apac"];
const byRegion = regions.map((r) => {
  const rows = INCIDENTS.filter((t) => t.region === r);
  const causes = new Map<Cause, number>();
  for (const t of rows) causes.set(t.cause, (causes.get(t.cause) ?? 0) + 1);
  const top = [...causes.entries()].sort((a, b) => b[1] - a[1]);
  return { region: r, count: rows.length, minutes: rows.reduce((s, t) => s + t.minutes, 0), top };
});
const overall = new Map<Cause, number>();
for (const t of INCIDENTS) overall.set(t.cause, (overall.get(t.cause) ?? 0) + 1);
const overallSorted = [...overall.entries()].sort((a, b) => b[1] - a[1]);
const [first, second] = overallSorted;
if (!first || !second || first[1] === second[1]) throw new Error("overall top cause is not unique");
for (const r of byRegion) {
  const [rTop, rSecond] = r.top;
  if (!rTop || (rSecond && rTop[1] === rSecond[1]))
    throw new Error(`${r.region}: tie on top cause`);
  if (rTop[0] === first[0]) throw new Error(`${r.region}: region top cause equals the overall one`);
}
if (new Set(byRegion.map((r) => r.minutes)).size !== 3) throw new Error("region totals collide");
const longest = [...INCIDENTS].sort((a, b) => b.minutes - a.minutes);
if ((longest[0]?.minutes ?? 0) - (longest[1]?.minutes ?? 0) < 30)
  throw new Error("longest not unique");

await Bun.write(OUT, out);
console.log(`wrote ${Bun.fileURLToPath(OUT)} (${INCIDENTS.length} incidents)`);
console.log("---- ANSWER KEY (mirror into scenarios/fanout-research.ts) ----");
for (const r of byRegion) {
  console.log(
    `${r.region}: ${r.count} incidents, ${r.minutes} downtime minutes, causes ${r.top.map(([c, n]) => `${c}=${n}`).join(" ")}`,
  );
}
console.log(
  `total: ${INCIDENTS.length} incidents, ${INCIDENTS.reduce((s, t) => s + t.minutes, 0)} minutes`,
);
console.log(`overall causes: ${overallSorted.map(([c, n]) => `${c}=${n}`).join(" ")}`);
console.log(`longest: "${longest[0]?.title}" (${longest[0]?.minutes} min)`);
