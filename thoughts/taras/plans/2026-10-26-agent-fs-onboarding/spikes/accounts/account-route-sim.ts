// Usage: AFS_URL=http://127.0.0.1:7499 bun account-route-sim.ts
// HTTP-level simulation of the proposed swarm handler POST /api/fs/me/account.
// Same agent-fs calls the handler would make with the bootstrap key. Keys are never printed.
const BASE = (process.env.AFS_URL ?? "http://127.0.0.1:7499").replace(/\/+$/, "");
const run = Math.random().toString(36).slice(2, 8);
type R = { status: number; body: any };
async function req(method: string, path: string, key?: string, body?: unknown): Promise<R> {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  let j: any = {};
  try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 100) }; }
  return { status: res.status, body: j };
}

// ---- bootstrap (as the seeder does) ----
const bootstrapEmail = `agent-fs-admin-sim${run}@swarm.local`;
const adminKey: string = (await req("POST", "/auth/register", undefined, { email: bootstrapEmail })).body.apiKey;
const orgId: string = (await req("POST", "/orgs", adminKey, { name: "swarm" })).body.id;
const driveId: string = ((await req("GET", `/orgs/${orgId}/drives`, adminKey)).body.drives as any[])[0].id;
const rank = { viewer: 0, editor: 1, admin: 2 } as Record<string, number>;

// ---- the handler ----
type Result =
  | { code: 400 | 409; error: string }
  | { code: 200; status: "created" | "exists" | "recovered" | "registered-uninvited"; email: string; role?: string; apiKey?: string; invited: boolean };

let failNextInvite = false; // test hook only

async function createOrRecover(emailIn: string, opts: { recover?: boolean; role?: "viewer" | "editor" | "admin" } = {}): Promise<Result> {
  const role = opts.role ?? "editor";
  const email = emailIn.trim();
  const lower = email.toLowerCase();
  // 1. guards
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { code: 400, error: "invalid email" };
  if (lower === bootstrapEmail.toLowerCase()) return { code: 409, error: "reserved: bootstrap account" };
  if (lower.endsWith("@swarm.local")) return { code: 409, error: "reserved: agent account domain" };
  // 2. existing member? (case-insensitive over the admin members list; use the stored spelling afterwards)
  const list = async () => ((await req("GET", `/orgs/${orgId}/members`, adminKey)).body.members ?? []) as any[];
  let hit = (await list()).filter((m) => m.email.toLowerCase() === lower);
  if (hit.length > 1) hit = hit.filter((m) => m.email === email).concat(hit); // prefer exact spelling
  const resetFor = async (m: any) => {
    const r = await req("POST", `/orgs/${orgId}/members/${m.userId}/reset-key`, adminKey);
    return r.status === 200 ? (r.body.apiKey as string) : undefined;
  };
  if (hit.length) {
    const m = hit[0];
    if (!opts.recover) return { code: 200, status: "exists", email: m.email, role: m.role, invited: true };
    const k = await resetFor(m);
    if (!k) return { code: 409, error: "reset failed" };
    return { code: 200, status: "recovered", email: m.email, role: m.role, apiKey: k, invited: true };
  }
  // 3. not a member: register (public). 409 means an account exists without membership.
  const reg = await req("POST", "/auth/register", undefined, { email: lower });
  let key: string | undefined = reg.status === 200 ? reg.body.apiKey : undefined;
  if (reg.status !== 200 && reg.status !== 409) return { code: 409, error: `register failed ${reg.status}` };
  // 4. invite with the exact spelling that was registered
  let invited = true;
  if (failNextInvite) { failNextInvite = false; invited = false; }
  else invited = (await req("POST", `/orgs/${orgId}/members/invite`, adminKey, { email: lower, role })).status === 200;
  if (key) {
    // fresh account: hand the key back exactly once, even when the invite failed
    return { code: 200, status: invited ? "created" : "registered-uninvited", email: lower, role, apiKey: key, invited };
  }
  // 409 path: account existed, no key to give
  if (!invited) return { code: 200, status: "registered-uninvited", email: lower, invited };
  if (!opts.recover) return { code: 200, status: "exists", email: lower, role, invited };
  const m = (await list()).find((x) => x.email === lower);
  key = m ? await resetFor(m) : undefined;
  return key ? { code: 200, status: "recovered", email: lower, role, apiKey: key, invited } : { code: 409, error: "reset failed" };
}

const ls = async (k?: string) => (k ? (await req("POST", `/orgs/${orgId}/ops`, k, { op: "ls", path: "/", driveId })).status : "no-key");
const show = async (label: string, r: Result) => {
  const k = "apiKey" in r ? r.apiKey : undefined;
  const { apiKey, ...rest } = r as any;
  console.log(`${label.padEnd(52)} ${JSON.stringify(rest)} hasKey=${!!k} keyLsStatus=${await ls(k)}`);
  return k;
};

console.log("--- scenarios ---");
const ada = `Ada-${run}@x.com`;
const k1 = await show("A new person (typed mixed case)", await createOrRecover(ada));
await show("A again, no recover (idempotent)", await createOrRecover(ada));
await show("A typed lower-case, no recover", await createOrRecover(ada.toLowerCase()));
const k2 = await show("A recover=true", await createOrRecover(ada, { recover: true }));
console.log("  old key still works after recover?", await ls(k1), " new key:", await ls(k2));

// B: registered elsewhere (e.g. via Comb on another browser) but not a member
const bob = `bob-${run}@x.com`;
const bobKey = (await req("POST", "/auth/register", undefined, { email: bob })).body.apiKey;
await show("B registered, not member, no recover", await createOrRecover(bob));
console.log("  bob original key now sees drive?", await ls(bobKey));
// C: registered non-member, wants recover directly
const cy = `cy-${run}@x.com`;
await req("POST", "/auth/register", undefined, { email: cy });
await show("C registered non-member, recover=true", await createOrRecover(cy, { recover: true }));
// D: invite fails right after a fresh register
failNextInvite = true;
const dee = `dee-${run}@x.com`;
const dk = await show("D fresh register, invite fails", await createOrRecover(dee));
await show("D retry (409 path, invite now ok)", await createOrRecover(dee));
await show("D retry with recover", await createOrRecover(dee, { recover: true }));
// E: guards
await show("E bootstrap email", await createOrRecover(bootstrapEmail));
await show("E bootstrap email upper-case", await createOrRecover(bootstrapEmail.toUpperCase()));
await show("E agent domain", await createOrRecover("00000000-0000-4000-8000-000000000000@swarm.local"));
await show("E invalid email", await createOrRecover("nope"));
await show("E trailing space is trimmed", await createOrRecover(` ${ada} `));
// F: pre-existing mixed-case account that is a member (Comb registered as typed)
const mixed = `Eli-${run}@x.com`;
const mk = (await req("POST", "/auth/register", undefined, { email: mixed })).body.apiKey;
await req("POST", `/orgs/${orgId}/members/invite`, adminKey, { email: mixed, role: "editor" });
await show("F member stored mixed, user types lower", await createOrRecover(mixed.toLowerCase()));
console.log("  original Comb key still fine?", await ls(mk));
// bootstrap admin still admin?
console.log("bootstrap still lists members:", (await req("GET", `/orgs/${orgId}/members`, adminKey)).status);
