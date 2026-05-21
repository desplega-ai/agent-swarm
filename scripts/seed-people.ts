#!/usr/bin/env bun
/**
 * Seed varied human users + a handful of Unmapped triage entries for local
 * dev / demo of the People page (PR #500).
 *
 * Run against a running local API server (default http://localhost:3013).
 * Users are created via HTTP `POST /api/users` — the API boundary is respected
 * for every user mutation. Unmapped kv entries are written directly to the
 * SQLite DB because there's no public kv HTTP endpoint and `scripts/seed.ts`
 * already establishes the precedent of direct `bun:sqlite` access inside the
 * scripts/ tree (which `scripts/check-db-boundary.sh` exempts).
 *
 * Idempotent: re-running the script does not duplicate users (lookup by email)
 * and uses `INSERT OR REPLACE` for the kv rows.
 *
 * Usage:
 *   MCP_BASE_URL=http://localhost:3013 bun run seed:people
 *   AGENT_SWARM_API_KEY=123123 bun run seed:people
 *   bun run seed:people --clear   # also wipe prior @example.com QA users
 *                                  # younger than 7 days (raw sqlite — destructive)
 *
 * The script never touches users without an `@example.com` email and never
 * deletes users older than the safety threshold. Real users are untouched.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { getApiKey } from "../src/utils/api-key";

// ─── CLI args ────────────────────────────────────────────────────────────────

const CLEAR = process.argv.includes("--clear");
const HELP = process.argv.includes("--help") || process.argv.includes("-h");

if (HELP) {
  console.log(`Usage: bun run seed:people [--clear]

  --clear   Wipe prior QA users (email LIKE '%@example.com', lastUpdatedAt
            within the last 7 days) and prior unmapped kv rows BEFORE seeding.
            Destructive — uses direct sqlite. Real users are never touched.

Env:
  MCP_BASE_URL          API base (default http://localhost:3013)
  AGENT_SWARM_API_KEY   Swarm API key (default 123123 for local dev)
`);
  process.exit(0);
}

const API_URL = process.env.MCP_BASE_URL ?? "http://localhost:3013";
const API_KEY = getApiKey() || "123123";
const DB_PATH = resolve(process.cwd(), "agent-swarm-db.sqlite");
const CLEAR_MAX_AGE_DAYS = 7;

// ─── Seed dataset ────────────────────────────────────────────────────────────

type SeedIdentity = { kind: "slack" | "github" | "linear" | "gitlab"; externalId: string };

type SeedUser = {
  name: string;
  email: string;
  role?: string;
  notes?: string;
  emailAliases?: string[];
  preferredChannel?: string;
  timezone?: string;
  dailyBudgetUsd?: number | null;
  status?: "invited" | "active" | "suspended";
  identities?: SeedIdentity[];
};

const SEED_USERS: SeedUser[] = [
  // 1. Admin with all 4 identities — like Ada in the QA fixtures.
  {
    name: "Ada Sandoval",
    email: "ada.sandoval@example.com",
    role: "admin",
    notes:
      "Founding admin. Owns operator tooling and integrations. Trusted to merge unmapped identities and adjust budgets.",
    preferredChannel: "slack",
    timezone: "Europe/Madrid",
    dailyBudgetUsd: null, // unlimited
    status: "active",
    identities: [
      { kind: "slack", externalId: "U_ADA_DEMO" },
      { kind: "github", externalId: "ada-sandoval" },
      { kind: "linear", externalId: "1f2c44e0-aa11-4d12-9f7a-ada000000001" },
      { kind: "gitlab", externalId: "ada-sandoval" },
    ],
  },

  // 2. Engineer — github + slack.
  {
    name: "Bryn Kovac",
    email: "bryn.kovac@example.com",
    role: "engineer",
    preferredChannel: "slack",
    timezone: "Europe/Berlin",
    dailyBudgetUsd: 50,
    status: "active",
    identities: [
      { kind: "slack", externalId: "U_BRYN_DEMO" },
      { kind: "github", externalId: "bryn-kovac" },
    ],
  },

  // 3. Engineer — slack + linear, no github.
  {
    name: "Cleo Park",
    email: "cleo.park@example.com",
    role: "engineer",
    preferredChannel: "slack",
    timezone: "America/Los_Angeles",
    dailyBudgetUsd: 75,
    status: "active",
    identities: [
      { kind: "slack", externalId: "U_CLEO_DEMO" },
      { kind: "linear", externalId: "2a3b55f1-bb22-4d23-8e6b-cleo000000002" },
    ],
  },

  // 4. Engineer — github only.
  {
    name: "Dario Mensah",
    email: "dario.mensah@example.com",
    role: "engineer",
    preferredChannel: "slack",
    timezone: "Africa/Accra",
    dailyBudgetUsd: 40,
    status: "active",
    identities: [{ kind: "github", externalId: "dario-mensah" }],
  },

  // 5. Designer — daily budget set, no notes.
  {
    name: "Esme Lindqvist",
    email: "esme.lindqvist@example.com",
    role: "designer",
    preferredChannel: "slack",
    timezone: "Europe/Stockholm",
    dailyBudgetUsd: 25,
    status: "active",
    identities: [
      { kind: "slack", externalId: "U_ESME_DEMO" },
      { kind: "linear", externalId: "3b4c66e2-cc33-4d34-7d5c-esme000000003" },
    ],
  },

  // 6. Ops — suspended, longer notes.
  {
    name: "Finch Oduya",
    email: "finch.oduya@example.com",
    role: "ops",
    notes:
      "Suspended 2026-05-12 after rotating credentials during an incident. Re-enable once the on-call rotation is finalized and the post-mortem (INC-2412) closes. Primary on PagerDuty schedule 'Platform A'. Owns the cluster-credential pool and the ngrok tunnel for staging webhooks. Slack DM preferred — Linear notifications go unread.",
    preferredChannel: "slack",
    timezone: "Africa/Nairobi",
    dailyBudgetUsd: 10,
    status: "suspended",
    identities: [
      { kind: "slack", externalId: "U_FINCH_DEMO" },
      { kind: "github", externalId: "finch-oduya" },
    ],
  },

  // 7. Invited — no identities yet.
  {
    name: "Greta Halvorsen",
    email: "greta.halvorsen@example.com",
    role: "engineer",
    preferredChannel: "slack",
    timezone: "Europe/Oslo",
    dailyBudgetUsd: null,
    status: "invited",
    identities: [],
  },

  // 8. Email aliases (work + personal + alias).
  {
    name: "Hari Bhattacharya",
    email: "hari.bhattacharya@example.com",
    role: "engineer",
    emailAliases: [
      "hari@example.com",
      "h.bhattacharya@example.com",
      "hari.personal@example.org",
    ],
    preferredChannel: "slack",
    timezone: "Asia/Kolkata",
    dailyBudgetUsd: 60,
    status: "active",
    identities: [
      { kind: "slack", externalId: "U_HARI_DEMO" },
      { kind: "github", externalId: "hari-bhatt" },
    ],
  },

  // 9. Active but no identities — fallback "manual" account, role missing for em-dash demo.
  {
    name: "Indi Whitlock",
    email: "indi.whitlock@example.com",
    // role intentionally omitted — exercises the em-dash fallback on the People list.
    preferredChannel: "slack",
    timezone: "Europe/London",
    dailyBudgetUsd: 15,
    status: "active",
    identities: [],
  },

  // 10. PM with linear + slack, mid-tier budget.
  {
    name: "Jules Avraham",
    email: "jules.avraham@example.com",
    role: "pm",
    preferredChannel: "linear",
    timezone: "America/New_York",
    dailyBudgetUsd: 30,
    status: "active",
    notes: "Drives the operator-tooling roadmap. Async DM-friendly; prefers Linear over Slack for status.",
    identities: [
      { kind: "slack", externalId: "U_JULES_DEMO" },
      { kind: "linear", externalId: "4c5d77f3-dd44-4d45-6c4d-jule000000004" },
    ],
  },
];

// ─── Unmapped kv dataset ─────────────────────────────────────────────────────

type UnmappedSeed = {
  kind: "slack" | "github" | "linear" | "gitlab";
  externalId: string;
  displayName: string;
  sampleEventType: string;
  count: number;
  // hours ago for lastSeenAt
  hoursAgo: number;
};

const SEED_UNMAPPED: UnmappedSeed[] = [
  {
    kind: "slack",
    externalId: "U07XYZDEMO1",
    displayName: "Mei Tanaka",
    sampleEventType: "message",
    count: 12,
    hoursAgo: 2,
  },
  {
    kind: "slack",
    externalId: "@kova",
    displayName: "@kova",
    sampleEventType: "message",
    count: 5,
    hoursAgo: 6,
  },
  {
    kind: "github",
    externalId: "octo-stranger",
    displayName: "octo-stranger",
    sampleEventType: "pull_request",
    count: 2,
    hoursAgo: 26,
  },
  {
    kind: "github",
    externalId: "rin-x-99",
    displayName: "rin-x-99",
    sampleEventType: "pull_request",
    count: 1,
    hoursAgo: 49,
  },
  {
    kind: "linear",
    externalId: "@nina.r",
    displayName: "@nina.r",
    sampleEventType: "issue_assigned",
    count: 5,
    hoursAgo: 12,
  },
  {
    kind: "gitlab",
    externalId: "yusuf-demo",
    displayName: "yusuf-demo",
    sampleEventType: "merge_request",
    count: 1,
    hoursAgo: 72,
  },
];

const UNMAPPED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches src/be/unmapped-identities.ts

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function http<T = unknown>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${method} ${path} → ${r.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// ─── Idempotent user-create ──────────────────────────────────────────────────

type UserResp = {
  id: string;
  name: string;
  email: string | null;
  status: string;
  identities: { kind: string; externalId: string }[];
};

async function listExistingUsers(): Promise<Map<string, UserResp>> {
  const j = await http<{ users: UserResp[] }>("GET", "/api/users");
  const byEmail = new Map<string, UserResp>();
  for (const u of j.users ?? []) {
    if (u.email) byEmail.set(u.email.toLowerCase(), u);
  }
  return byEmail;
}

async function upsertUser(
  seed: SeedUser,
  existing: Map<string, UserResp>,
): Promise<{ created: boolean; user: UserResp }> {
  const found = existing.get(seed.email.toLowerCase());
  if (found) {
    return { created: false, user: found };
  }
  const j = await http<{ user: UserResp }>("POST", "/api/users", seed);
  return { created: true, user: j.user };
}

// ─── kv (unmapped) seeding via raw sqlite ────────────────────────────────────

function seedUnmappedRows(db: Database): number {
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let wrote = 0;
  for (const row of SEED_UNMAPPED) {
    const ns = `integration:unmapped:${row.kind}`;
    const lastSeenAt = new Date(now - row.hoursAgo * 60 * 60 * 1000).toISOString();
    const firstSeenAt = new Date(now - row.hoursAgo * 60 * 60 * 1000 - 6 * 60 * 60 * 1000).toISOString();
    const expiresAt = now + UNMAPPED_TTL_MS;
    const metaPayload = {
      lastSeenAt,
      firstSeenAt,
      sampleEventType: row.sampleEventType,
      sampleContext: `${row.displayName} — seeded for People-page demo`,
      displayName: row.displayName,
    };
    upsert.run(
      ns,
      `${row.externalId}:meta`,
      JSON.stringify(metaPayload),
      "json",
      expiresAt,
      now,
      now,
    );
    upsert.run(
      ns,
      `${row.externalId}:count`,
      String(row.count),
      "integer",
      expiresAt,
      now,
      now,
    );
    wrote++;
  }
  return wrote;
}

// ─── --clear (destructive, sqlite-only) ──────────────────────────────────────

function clearPriorQa(db: Database): { users: number; kvRows: number } {
  const cutoff = new Date(Date.now() - CLEAR_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  // Safety net — only nuke obviously-fake QA users, only if recently touched.
  const deleted = db
    .prepare(
      `DELETE FROM users
        WHERE email LIKE '%@example.com'
          AND lastUpdatedAt >= ?`,
    )
    .run(cutoff);

  // user_external_ids cascades via FK; tasks.requestedByUserId is SET NULL.
  // Drop all unmapped kv rows we own (any kind).
  const kv = db
    .prepare(
      `DELETE FROM kv_entries
        WHERE namespace LIKE 'integration:unmapped:%'`,
    )
    .run();

  return { users: Number(deleted.changes), kvRows: Number(kv.changes) };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`→ seed-people: API=${API_URL}`);

  // Open DB only for kv writes + --clear. Read-only for the rest of the world;
  // the API server already has WAL so concurrent writes from this script are
  // safe.
  const db = new Database(DB_PATH);

  if (CLEAR) {
    const { users, kvRows } = clearPriorQa(db);
    console.log(`  --clear: removed ${users} QA user(s), ${kvRows} unmapped kv row(s)`);
  }

  // 1. Users via HTTP.
  const existing = await listExistingUsers();
  let createdCount = 0;
  let skippedCount = 0;
  for (const seed of SEED_USERS) {
    try {
      const { created, user } = await upsertUser(seed, existing);
      if (created) {
        createdCount++;
        console.log(`  ✓ created ${user.name} <${user.email}>`);
      } else {
        skippedCount++;
        console.log(`  · skip   ${user.name} <${user.email}> (already exists)`);
      }
    } catch (err) {
      console.error(`  ✗ failed ${seed.email}:`, err instanceof Error ? err.message : err);
    }
  }

  // 2. Unmapped kv via raw sqlite.
  const wroteUnmapped = seedUnmappedRows(db);

  db.close();

  console.log(
    `\n✅ Done. seeded ${createdCount} user(s) (${skippedCount} skipped), ${wroteUnmapped} unmapped entry pair(s).`,
  );
  console.log(`   People page: http://localhost:5274/people`);
}

main().catch((err) => {
  console.error("seed-people failed:", err);
  process.exit(1);
});
