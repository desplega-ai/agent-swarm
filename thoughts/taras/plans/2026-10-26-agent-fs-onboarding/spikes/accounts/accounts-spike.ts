// Usage: AFS_URL=http://127.0.0.1:7499 bun accounts-spike.ts
// Proves the agent-fs account flow. Keys are held in memory and never printed.
const BASE = (process.env.AFS_URL ?? "http://127.0.0.1:7499").replace(/\/+$/, "");
const run = Math.random().toString(36).slice(2, 8);
type R = { status: number; body: any };

async function req(method: string, path: string, key?: string, body?: unknown): Promise<R> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 120) }; }
  return { status: res.status, body: json };
}
// Redact: show only shape. Never print apiKey values.
const safe = (b: any) => JSON.stringify(b, (k, v) => (k.toLowerCase().includes("apikey") ? "<redacted>" : v)).slice(0, 200);
const log = (label: string, r: R) => console.log(`${label.padEnd(58)} -> ${r.status} ${safe(r.body)}`);
const section = (s: string) => console.log(`\n=== ${s} ===`);

const adminEmail = `agent-fs-admin-spike${run}@swarm.local`;

// (1) bootstrap, same calls as ensureAgentFsSharedProvisioning / ensureSharedOrg / ensureSharedDrive
section("1. bootstrap admin");
const reg = await req("POST", "/auth/register", undefined, { email: adminEmail });
log("POST /auth/register (admin)", reg);
const adminKey: string = reg.body.apiKey;
const orgList = await req("GET", "/orgs", adminKey);
log("GET /orgs", orgList);
const orgCreate = await req("POST", "/orgs", adminKey, { name: "swarm" });
log("POST /orgs {name:swarm}", orgCreate);
const orgId: string = orgCreate.body.id ?? orgCreate.body.orgId;
const drives0 = await req("GET", `/orgs/${orgId}/drives`, adminKey);
log("GET /orgs/:o/drives", drives0);
// ensureSharedDrive: name "shared" ?? isDefault ?? first. A fresh org only has its default drive, so the
// seeder never POSTs a drive. (A drive created via POST is NOT visible to invited members: inviteToOrg
// only grants the org's isDefault drive.)
const dl = drives0.body.drives as any[];
const driveId: string = (dl.find((d) => d.name === "shared") ?? dl.find((d) => d.isDefault) ?? dl[0]).id;
console.log("shared drive = the default drive of the org:", dl.find((d) => d.id === driveId)?.name);
const members0 = await req("GET", `/orgs/${orgId}/members`, adminKey);
log("GET /orgs/:o/members", members0);

const lsShared = (key: string) => req("POST", `/orgs/${orgId}/ops`, key, { op: "ls", path: "/", driveId });
const invite = (email: string, role = "editor", key = adminKey) =>
  req("POST", `/orgs/${orgId}/members/invite`, key, { email, role });
const members = async () => ((await req("GET", `/orgs/${orgId}/members`, adminKey)).body.members ?? []) as any[];

// (2) new person
section("2. new person: register, invite, list");
const ada = `ada-${run}@x.com`;
const inviteEarly = await invite(ada);
log("invite BEFORE register (seeder boot path)", inviteEarly);
const adaReg = await req("POST", "/auth/register", undefined, { email: ada });
log("POST /auth/register (ada)", adaReg);
const adaKey: string = adaReg.body.apiKey;
log("ada ls shared BEFORE invite", await lsShared(adaKey));
log("ada GET /orgs/:o/drives BEFORE invite", await req("GET", `/orgs/${orgId}/drives`, adaKey));
log("invite ada editor (admin key)", await invite(ada));
log("ada GET /orgs/:o/drives AFTER invite", await req("GET", `/orgs/${orgId}/drives`, adaKey));
log("ada ls shared AFTER invite", await lsShared(adaKey));
log("ada GET /auth/me", await req("GET", "/auth/me", adaKey));
const writeTry = await req("POST", `/orgs/${orgId}/ops`, adaKey, { op: "write", path: "/hello.md", content: "hi", driveId });
log("ada write (editor can write)", writeTry);
log("invite ada again (idempotent?)", await invite(ada));

// (3) registered but not a member
section("3. registered, not a member");
const bob = `bob-${run}@x.com`;
const bobReg = await req("POST", "/auth/register", undefined, { email: bob });
const bobOld: string = bobReg.body.apiKey;
log("POST /auth/register (bob, first)", bobReg);
log("bob ls shared (non-member)", await lsShared(bobOld));
log("POST /auth/register (bob, again)", await req("POST", "/auth/register", undefined, { email: bob }));
log("invite bob editor", await invite(bob));
log("bob ls shared (member)", await lsShared(bobOld));
const bobRow = (await members()).find((m) => m.email === bob);
console.log("bob member row keys:", Object.keys(bobRow ?? {}).join(","), "role:", bobRow?.role);
const reset = await req("POST", `/orgs/${orgId}/members/${bobRow.userId}/reset-key`, adminKey);
log("admin reset-key for bob", reset);
const bobNew: string = reset.body.apiKey;
log("bob OLD key ls", await lsShared(bobOld));
log("bob OLD key /auth/me", await req("GET", "/auth/me", bobOld));
log("bob NEW key ls", await lsShared(bobNew));
// reset for a non-member
const eve = `eve-${run}@x.com`;
const eveReg = await req("POST", "/auth/register", undefined, { email: eve });
const eveMe = await req("GET", "/auth/me", eveReg.body.apiKey);
log("admin reset-key for NON-member eve", await req("POST", `/orgs/${orgId}/members/${eveMe.body.userId}/reset-key`, adminKey));
// viewer cannot invite / reset
log("ada (editor) tries invite", await invite(`z-${run}@x.com`, "editor", adaKey));
log("ada (editor) tries list members", await req("GET", `/orgs/${orgId}/members`, adaKey));

// (4) case
section("4. case differences");
const mixed = `Foo-${run}@x.com`;
const lower = mixed.toLowerCase();
log("register Foo (mixed)", await req("POST", "/auth/register", undefined, { email: mixed }));
log("register foo (lower)", await req("POST", "/auth/register", undefined, { email: lower }));
log("invite lower-case when account is mixed-case", await invite(lower));
log("invite exact mixed-case", await invite(mixed));
const m4 = (await members()).filter((m) => m.email.toLowerCase() === lower);
console.log("members matching case-insensitively:", JSON.stringify(m4.map((m) => ({ email: m.email, role: m.role }))));
// reverse: account lower, invite mixed
const lo2 = `bar-${run}@x.com`;
await req("POST", "/auth/register", undefined, { email: lo2 });
log("invite upper-case of lower-case account", await invite(lo2.toUpperCase()));
// whitespace
const ws = `ws-${run}@x.com`;
await req("POST", "/auth/register", undefined, { email: ws });
log("invite with trailing space", await invite(ws + " "));

// (5) person email == bootstrap email
section("5. person email equals bootstrap email");
log("register bootstrap email again", await req("POST", "/auth/register", undefined, { email: adminEmail }));
const before = (await members()).find((m) => m.email === adminEmail);
log("invite bootstrap email as editor (raw, no guard)", await invite(adminEmail, "editor"));
const after = (await members()).find((m) => m.email === adminEmail);
console.log(`bootstrap role before=${before?.role} after=${after?.role}`);
log("bootstrap admin lists members after demotion?", await req("GET", `/orgs/${orgId}/members`, adminKey));
log("register upper-case bootstrap email", await req("POST", "/auth/register", undefined, { email: adminEmail.toUpperCase() }));
