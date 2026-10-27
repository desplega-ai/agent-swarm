#!/usr/bin/env bun
// @ts-nocheck: spike code, not typechecked by the repo (imports resolve in the spike worktree only).
/**
 * Live 403 matrix for non-admin (requester / viewer) access.
 *
 * Usage:
 *   bun build-matrix.ts <swarm-checkout> <out.md> [<out.json>]
 *
 * Boots the API from <swarm-checkout> on a free port with a throwaway DB under
 * /tmp/afo-spike-non-admin/, creates users (admin, requester, viewer, other),
 * sets roles through PUT /api/users/{id}/roles, mints aswt_ tokens, then calls
 * every route of the core flows as operator, admin, requester and viewer.
 * Tokens and the API key are never printed or written: only status codes and
 * short error texts reach the output. Kills only the server it started.
 *
 * Cell format: "200" success, "403 adm" = RBAC admission wall (no verb),
 * "403 ses" = session-access wall (owner / share), "403 <text>" = other 403.
 * Any non-403 status means the request got past admission.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const [checkout, outMd, outJson] = process.argv.slice(2);
if (!checkout || !outMd) {
  console.error("usage: bun build-matrix.ts <swarm-checkout> <out.md> [<out.json>]");
  process.exit(2);
}
const TMP = "/tmp/afo-spike-non-admin";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const KEY = randomBytes(16).toString("hex");
const server = Bun.spawn(["bun", "run", "src/http.ts"], {
  cwd: checkout,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    PORT: String(port),
    DATABASE_PATH: `${TMP}/db.sqlite`,
    DESPLEGA_TELEMETRY_ENV: "test",
    SLACK_DISABLE: "true",
    GITHUB_DISABLE: "true",
    JIRA_DISABLE: "true",
    LINEAR_DISABLE: "true",
    AGENT_SWARM_API_KEY: KEY,
    API_KEY: KEY,
    RBAC_ENABLED: "true",
  },
  stdout: Bun.file(`${TMP}/server.log`),
  stderr: Bun.file(`${TMP}/server.err.log`),
});
let exiting = false;
async function cleanup() {
  if (exiting) return;
  exiting = true;
  try {
    server.kill();
    await server.exited;
  } catch {}
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

type Id = "operator" | "admin" | "requester" | "viewer";
const IDS: Id[] = ["operator", "admin", "requester", "viewer"];
const tokens: Partial<Record<Id, string>> = {};

async function raw(
  who: Id | "key",
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
  rawBody?: BodyInit,
) {
  const bearer = who === "key" || who === "operator" ? KEY : tokens[who];
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}`, ...extra };
  let payload: BodyInit | undefined = rawBody;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
const op = (m: string, p: string, b?: unknown) => raw("key", m, p, b);

async function waitUp() {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.status < 500) return;
    } catch {}
    await Bun.sleep(300);
  }
  throw new Error("server did not start; see " + TMP + "/server.err.log");
}

const uniq = randomBytes(3).toString("hex");
async function mkUser(label: string, roles?: string[]) {
  const r = await op("POST", "/api/users", { name: `afo ${label} ${uniq}`, email: `afo-${label}-${uniq}@example.invalid` });
  const id = r.json?.user?.id as string;
  if (!id) throw new Error(`create user ${label} failed: ${r.status}`);
  if (roles) {
    const rr = await op("PUT", `/api/users/${id}/roles`, { roles });
    if (rr.status !== 200) throw new Error(`set roles ${label} failed: ${rr.status} ${rr.text.slice(0, 120)}`);
  }
  return id;
}
async function mint(userId: string): Promise<string> {
  const r = await op("POST", `/api/users/${userId}/mcp-tokens`, { label: "afo-spike" });
  if (!r.json?.plaintext) throw new Error(`mint failed: ${r.status}`);
  return r.json.plaintext;
}

function classify(status: number, json: any, text: string): string {
  if (status !== 403) return String(status);
  const msg: string = (json?.error ?? json?.message ?? text ?? "").toString();
  if (/admission:/i.test(msg)) return "403 adm";
  if (/session|owner|shared|access to/i.test(msg)) return "403 ses";
  return `403 ${msg.replace(/\s+/g, " ").slice(0, 50)}`;
}

await waitUp();
const U = {
  admin: await mkUser("admin"), // default role = admin
  requester: await mkUser("requester", ["requester"]),
  viewer: await mkUser("viewer", ["viewer"]),
  other: await mkUser("other", ["requester"]),
};
tokens.admin = await mint(U.admin);
tokens.requester = await mint(U.requester);
tokens.viewer = await mint(U.viewer);
const uid: Record<Id, string | undefined> = { operator: undefined, admin: U.admin, requester: U.requester, viewer: U.viewer };

// Sanity: whoami for each identity (status only)
const whoami: Record<string, unknown> = {};
for (const id of IDS) {
  const r = await raw(id, "GET", "/api/whoami");
  whoami[id] = { status: r.status, kind: r.json?.kind, hasGrants: r.json?.grants !== undefined };
}

async function mkTask(owner: string | undefined, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await op("POST", "/api/tasks", { task: `afo spike task ${randomBytes(2).toString("hex")}`, requestedByUserId: owner, ...extra });
  if (!r.json?.id && !r.json?.task?.id) throw new Error(`mkTask failed ${r.status} ${r.text.slice(0, 160)}`);
  return (r.json.id ?? r.json.task.id) as string;
}
// Verify ownership attribution works for the operator-created fixtures.
{
  const t = await mkTask(U.requester);
  const g = await op("GET", `/api/tasks/${t}`);
  whoami["fixtureOwnerAttributed"] = g.json?.requestedByUserId === U.requester || g.json?.task?.requestedByUserId === U.requester;
}

interface Ctx {
  me: string | undefined;
  who: Id;
  own: string; // task owned by the caller
  foreign: string; // task owned by `other`
  draftOwn: string;
  throwaway: string; // a spare user
  throwaway2: string;
  configId: string;
}
interface Row {
  area: string;
  label: string;
  method: string;
  path: (c: Ctx) => string;
  body?: (c: Ctx) => unknown;
  /** raw binary body for the upload row */
  rawBody?: string;
  /** which fixtures to prepare */
  needs?: Array<"own" | "foreign" | "draftOwn" | "throwaway" | "configId">;
  note?: string;
}
const J = (s: string) => () => s;
const rows: Row[] = [
  // Home
  { area: "home", label: "whoami", method: "GET", path: J("/api/whoami") },
  { area: "home", label: "status", method: "GET", path: J("/status") },
  { area: "home", label: "stats", method: "GET", path: J("/api/stats") },
  { area: "home", label: "agents", method: "GET", path: J("/api/agents") },
  { area: "home", label: "onboarding state", method: "GET", path: J("/api/onboarding") },
  { area: "home", label: "UI telemetry relay", method: "POST", path: J("/api/telemetry/ui-event"), body: () => ({ event: "afo.unknown", properties: {} }), note: "400 for admin = got past admission (unknown event name)" },
  // Tasks
  { area: "tasks", label: "list tasks", method: "GET", path: J("/api/tasks?limit=5") },
  { area: "tasks", label: "task detail (own)", method: "GET", path: (c) => `/api/tasks/${c.own}`, needs: ["own"] },
  { area: "tasks", label: "create task", method: "POST", path: J("/api/tasks"), body: () => ({ task: "afo spike create", contextKey: `task:ui:afo:${randomBytes(4).toString("hex")}` }) },
  { area: "tasks", label: "create follow-up (parentTaskId own)", method: "POST", path: J("/api/tasks"), body: (c) => ({ task: "afo follow-up", parentTaskId: c.own }), needs: ["own"] },
  { area: "tasks", label: "create task with model override", method: "POST", path: J("/api/tasks"), body: () => ({ task: "afo model", model: "opus", allowCustomModel: true }), note: "201 for requester after the fix = handler does not clamp model/agentId/profile for user callers" },
  { area: "tasks", label: "create draft", method: "POST", path: J("/api/tasks"), body: () => ({ task: "afo draft", draft: true }) },
  { area: "tasks", label: "promote-draft (own)", method: "POST", path: (c) => `/api/tasks/${c.draftOwn}/promote-draft`, needs: ["draftOwn"] },
  { area: "tasks", label: "upload attachment (own)", method: "POST", path: (c) => `/api/fs/tasks/${c.own}/files?name=afo.txt`, rawBody: "hello", needs: ["own"] },
  { area: "tasks", label: "cancel (own)", method: "POST", path: (c) => `/api/tasks/${c.own}/cancel`, needs: ["own"] },
  { area: "tasks", label: "cancel (foreign)", method: "POST", path: (c) => `/api/tasks/${c.foreign}/cancel`, needs: ["foreign"] },
  { area: "tasks", label: "pause (own)", method: "POST", path: (c) => `/api/tasks/${c.own}/pause`, needs: ["own"], note: "task is pending, so a pass is 400 'not in_progress'" },
  { area: "tasks", label: "pause (foreign)", method: "POST", path: (c) => `/api/tasks/${c.foreign}/pause`, needs: ["foreign"] },
  { area: "tasks", label: "resume (own)", method: "POST", path: (c) => `/api/tasks/${c.own}/resume`, needs: ["own"], note: "a pass is 400 'not paused'" },
  { area: "tasks", label: "resume (foreign)", method: "POST", path: (c) => `/api/tasks/${c.foreign}/resume`, needs: ["foreign"] },
  { area: "tasks", label: "steer (own)", method: "POST", path: (c) => `/api/tasks/${c.own}/steer`, body: () => ({ message: "afo steer" }), needs: ["own"] },
  { area: "tasks", label: "steer (foreign)", method: "POST", path: (c) => `/api/tasks/${c.foreign}/steer`, body: () => ({ message: "afo steer" }), needs: ["foreign"] },
  { area: "tasks", label: "title (own)", method: "PATCH", path: (c) => `/api/tasks/${c.own}/title`, body: () => ({ title: "afo title" }), needs: ["own"] },
  // Sessions
  { area: "sessions", label: "list sessions", method: "GET", path: J("/api/sessions") },
  { area: "sessions", label: "session tree", method: "GET", path: J("/api/sessions?scope=tree") },
  { area: "sessions", label: "session detail (own root)", method: "GET", path: (c) => `/api/sessions/${c.own}`, needs: ["own"] },
  { area: "sessions", label: "share session (own)", method: "PUT", path: (c) => `/api/sessions/${c.own}/shares`, body: () => ({ everyone: "none", users: [] }), needs: ["own"], note: "body shape may 400 for admin: only the 403 split matters" },
  { area: "sessions", label: "session-triage", method: "POST", path: J("/api/session-triage"), body: () => ({ action: "read", triage: "inbox", show: "all" }) },
  { area: "sessions", label: "session-moves", method: "POST", path: J("/api/session-moves"), body: (c) => ({ rootTaskIds: [c.own], groupKey: null }), needs: ["own"] },
  { area: "sessions", label: "session-moves/prefix", method: "POST", path: J("/api/session-moves/prefix"), body: () => ({ from: "afo/x", to: null }) },
  { area: "sessions", label: "inbox-state list", method: "GET", path: (c) => `/api/inbox-state?userId=${c.me ?? U.admin}` },
  { area: "sessions", label: "inbox-state upsert", method: "PATCH", path: J("/api/inbox-state"), body: (c) => ({ userId: c.me ?? U.admin, itemType: "approval", itemId: "afo", status: "done" }) },
  { area: "sessions", label: "inbox-state upsert for ANOTHER user", method: "PATCH", path: J("/api/inbox-state"), body: () => ({ userId: U.other, itemType: "approval", itemId: "afo-x", status: "done" }), note: "any 200 for requester/viewer is a cross-user write (handler never compares body.userId to the token)" },
  { area: "sessions", label: "inbox-state bulk", method: "PATCH", path: J("/api/inbox-state/bulk"), body: (c) => ({ userId: c.me ?? U.admin, items: [{ itemType: "approval", itemId: "afo", status: "done" }] }) },
  { area: "sessions", label: "favorites set", method: "PUT", path: J("/api/favorites"), body: () => ({ itemType: "page", itemId: "afo", favorite: true }) },
  // Comb / realtime / pages
  { area: "comb", label: "realtime ticket", method: "POST", path: J("/api/realtime/ticket"), body: () => ({}) },
  { area: "comb", label: "comb review batch", method: "POST", path: J("/api/comb/review-batches"), body: () => ({ orgId: "o", driveId: "d", commentIds: ["00000000-0000-4000-8000-000000000000"], scopePath: "/" }), note: "COMB_ENABLED off: a pass is 404" },
  { area: "comb", label: "fs members invite", method: "POST", path: J("/api/fs/members/invite"), body: () => ({ email: `afo-inv-${uniq}@example.invalid`, role: "editor" }), note: "agent-fs not configured: a pass is 4xx/5xx" },
  { area: "comb", label: "rooms/get", method: "POST", path: J("/api/rooms/get"), body: () => ({ name: "afo" }) },
  { area: "comb", label: "page feedback", method: "POST", path: J("/api/pages/afo-missing/feedback"), body: () => ({ comments: [{ selector: "body", comment: "x" }] }), note: "a pass is 400/404" },
  // People
  { area: "people", label: "list users", method: "GET", path: J("/api/users") },
  { area: "people", label: "get roles (self-or-other)", method: "GET", path: (c) => `/api/users/${c.me ?? U.admin}/roles` },
  { area: "people", label: "list rbac roles", method: "GET", path: J("/api/rbac/roles") },
  { area: "people", label: "create user", method: "POST", path: J("/api/users"), body: () => ({ name: `afo made ${randomBytes(3).toString("hex")}` }) },
  { area: "people", label: "patch user", method: "PATCH", path: (c) => `/api/users/${c.throwaway}`, body: () => ({ notes: "afo" }), needs: ["throwaway"] },
  { area: "people", label: "mint token", method: "POST", path: (c) => `/api/users/${c.throwaway}/mcp-tokens`, body: () => ({ label: "afo" }), needs: ["throwaway"] },
  { area: "people", label: "add identity", method: "POST", path: (c) => `/api/users/${c.throwaway}/identities`, body: () => ({ kind: "email", externalId: `afo-${randomBytes(3).toString("hex")}@example.invalid` }), needs: ["throwaway"] },
  { area: "people", label: "merge users", method: "POST", path: (c) => `/api/users/${c.throwaway}/merge`, body: (c) => ({ sourceUserId: c.throwaway2 }), needs: ["throwaway"] },
  { area: "people", label: "set roles", method: "PUT", path: (c) => `/api/users/${c.throwaway}/roles`, body: () => ({ roles: ["viewer"] }), needs: ["throwaway"] },
  // Setup
  { area: "setup", label: "onboarding view step", method: "PUT", path: J("/api/onboarding"), body: () => ({ action: "view", step: "connect" }) },
  { area: "setup", label: "onboarding memory test", method: "POST", path: J("/api/onboarding/memory"), body: () => ({ preset: "afo-invalid" }), note: "invalid preset so admin gets 400 and no network call" },
  // Settings
  { area: "settings", label: "config list", method: "GET", path: J("/api/config") },
  { area: "settings", label: "config put", method: "PUT", path: J("/api/config"), body: () => ({ scope: "global", key: "AFO_SPIKE_NOTE", value: "x" }) },
  { area: "settings", label: "config delete", method: "DELETE", path: (c) => `/api/config/${c.configId}`, needs: ["configId"] },
  { area: "settings", label: "db-query (Debug page)", method: "POST", path: J("/api/db-query"), body: () => ({ sql: "select 1" }) },
  { area: "settings", label: "extensions list", method: "GET", path: J("/api/extensions") },
  { area: "settings", label: "telemetry enable", method: "POST", path: J("/api/telemetry/enable"), body: () => ({ via: "settings" }) },
  // Memory / apps / ranking
  { area: "memory", label: "memory keys", method: "GET", path: J("/api/memory/keys") },
  { area: "memory", label: "memory list", method: "POST", path: J("/api/memory/list"), body: () => ({}) },
  { area: "memory", label: "memory search", method: "POST", path: J("/api/memory/search"), body: () => ({ query: "afo" }) },
  { area: "apps", label: "apps list", method: "GET", path: J("/api/apps") },
  { area: "apps", label: "app detail", method: "GET", path: J("/api/apps/afo-missing"), note: "a pass is 404" },
  { area: "apps", label: "ranking", method: "GET", path: J("/api/ranking") },
];

const cells: Record<string, Record<Id, string>> = {};
const key = (r: Row) => `${r.path({ me: "{me}", who: "operator", own: "{own}", foreign: "{foreign}", draftOwn: "{draft}", throwaway: "{user}", throwaway2: "{user2}", configId: "{id}" }).split("?")[0]}`;

// identity-major order, least privileged first, so destructive admin calls cannot hide a 403.
for (const who of ["viewer", "requester", "admin", "operator"] as Id[]) {
  for (const r of rows) {
    const c: Ctx = { me: uid[who], who, own: "", foreign: "", draftOwn: "", throwaway: "", throwaway2: "", configId: "" };
    for (const n of r.needs ?? []) {
      if (n === "own") c.own = await mkTask(uid[who]);
      if (n === "foreign") c.foreign = await mkTask(U.other);
      if (n === "draftOwn") c.draftOwn = await mkTask(uid[who], { draft: true });
      if (n === "throwaway") {
        c.throwaway = await mkUser(`tmp${randomBytes(2).toString("hex")}`);
        c.throwaway2 = await mkUser(`tmp${randomBytes(2).toString("hex")}`);
      }
      if (n === "configId") {
        const cr = await op("PUT", "/api/config", { scope: "global", key: `AFO_SPIKE_${randomBytes(2).toString("hex").toUpperCase()}`, value: "x" });
        c.configId = cr.json?.id ?? cr.json?.config?.id ?? "missing";
      }
    }
    const res = await raw(who, r.method, r.path(c), r.body?.(c), {}, r.rawBody);
    const k = `${r.area}|${r.label}|${r.method} ${key(r)}`;
    cells[k] ??= {} as Record<Id, string>;
    cells[k][who] = classify(res.status, res.json, res.text);
  }
}

// Post-checks that need no extra identity: ownership of requester's own pause after 403 etc. are in the table.
const md: string[] = [];
md.push("# Live 403 matrix (non-admin spike)", "");
md.push(`Generated by build-matrix.ts against checkout \`${checkout}\` (HEAD ${(await Bun.$`git -C ${checkout} rev-parse --short HEAD`.nothrow().text()).trim() || "not a git checkout (archive copy)"}), RBAC_ENABLED=true.`);
md.push("Cell legend: `403 adm` = admission wall (route has no verb the role holds). `403 ses` = session-access wall (not owner/shared). Any other non-403 status = the request passed admission (400/404/409 come from the handler or the empty fixture).", "");
md.push(`Fixtures: whoami per identity = \`${JSON.stringify(whoami)}\`.`, "");
let area = "";
for (const [k, v] of Object.entries(cells)) {
  const [a, label, route] = k.split("|");
  if (a !== area) {
    area = a;
    md.push("", `## ${a}`, "", "| Flow | Route | operator | admin user | requester | viewer |", "|---|---|---|---|---|---|");
  }
  md.push(`| ${label} | \`${route}\` | ${v.operator} | ${v.admin} | ${v.requester} | ${v.viewer} |`);
}
md.push("", "## Row notes", "");
for (const r of rows) if (r.note) md.push(`- ${r.label}: ${r.note}`);
writeFileSync(outMd, md.join("\n") + "\n");
if (outJson) writeFileSync(outJson, JSON.stringify(cells, null, 2));
await cleanup();
console.log(`done: ${Object.keys(cells).length} rows -> ${outMd}`);
