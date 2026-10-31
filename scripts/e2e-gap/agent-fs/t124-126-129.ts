// biome-ignore-all lint/suspicious/noExplicitAny: scratch e2e fixtures read untyped JSON
// agent-fs #124 (drive-aware invites), #126 (pending invites + accept), #129 (drive member API behind the Members page)
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { check, finish, http, register, startDaemon } from "./common";

const APP = "https://app.example.test";
const d = await startDaemon({ AGENT_FS_APP_URL: APP });
const U = d.url;
try {
  const admin = await register(U, "admin@team.test");
  const O = admin.orgId;
  const A = (m: string, p: string, body?: unknown) => http(U, m, p, { key: admin.apiKey, body });
  const health = await http(U, "GET", "/health");
  check(
    "#124 /health advertises drive-invites",
    (health.json?.features ?? []).includes("drive-invites"),
    JSON.stringify(health.json?.features),
  );
  // drives: default + 2 new
  const drives = (await A("GET", `/orgs/${O}/drives`)).json.drives as any[];
  const def = drives.find((x) => x.isDefault) ?? drives[0];
  const dA = (await A("POST", `/orgs/${O}/drives`, { name: "alpha" })).json;
  const dB = (await A("POST", `/orgs/${O}/drives`, { name: "beta" })).json;
  for (const dr of [def, dA, dB])
    await http(U, "POST", `/orgs/${O}/ops`, {
      key: admin.apiKey,
      body: { op: "write", driveId: dr.id, path: "/secret.txt", content: `secret-${dr.name}` },
    });
  const readAs = (key: string, drive: string) =>
    http(U, "POST", `/orgs/${O}/ops`, {
      key,
      body: { op: "cat", driveId: drive, path: "/secret.txt" },
    });
  const writeAs = (key: string, drive: string) =>
    http(U, "POST", `/orgs/${O}/ops`, {
      key,
      body: { op: "write", driveId: drive, path: "/x.txt", content: "nope" },
    });

  // ---- #124: existing account, chosen drives
  const bob = await register(U, "bob@team.test");
  // bob has his own org; he is not in O yet
  let r = await A("POST", `/orgs/${O}/members/invite`, {
    email: " Bob@Team.Test ",
    role: "viewer",
    drives: [{ driveId: dA.id, role: "viewer" }],
  });
  check(
    "#124 invite existing account (email case/space-insensitive) -> status added",
    r.status === 200 && r.json?.status === "added" && r.json?.userId === bob.userId,
    `${r.status} ${r.json?.status}`,
  );
  check(
    "#124 result lists only the chosen drive",
    r.json?.drives?.length === 1 && r.json.drives[0].driveId === dA.id,
  );
  r = await readAs(bob.apiKey, dA.id);
  check(
    "#124 positive: bob reads granted drive alpha",
    r.status === 200 && JSON.stringify(r.json).includes("secret-alpha"),
    String(r.status),
  );
  r = await readAs(bob.apiKey, dB.id);
  check("#124 negative: bob cannot read beta", r.status >= 400, String(r.status));
  r = await readAs(bob.apiKey, def.id);
  check(
    "#124 negative: bob cannot read default drive (not granted)",
    r.status >= 400,
    String(r.status),
  );
  r = await writeAs(bob.apiKey, dA.id);
  check("#124 negative: viewer cannot write", r.status >= 400, String(r.status));
  const bobDrives = await http(U, "GET", `/orgs/${O}/drives`, { key: bob.apiKey });
  check(
    "#124 bob's default drive listing = alpha only",
    bobDrives.json?.drives?.length === 1 && bobDrives.json.drives[0].id === dA.id,
    JSON.stringify((bobDrives.json?.drives ?? []).map((x: any) => x.name)),
  );
  // omitted drives -> default drive with org role
  const _cara = await register(U, "cara@team.test");
  r = await A("POST", `/orgs/${O}/members/invite`, { email: "cara@team.test", role: "editor" });
  check(
    "#124 drives omitted -> default drive with org role",
    r.json?.drives?.length === 1 &&
      r.json.drives[0].driveId === def.id &&
      r.json.drives[0].role === "editor",
    JSON.stringify(r.json?.drives),
  );
  // [] -> org only
  const dan = await register(U, "dan@team.test");
  r = await A("POST", `/orgs/${O}/members/invite`, {
    email: "dan@team.test",
    role: "viewer",
    drives: [],
  });
  check(
    "#124 drives [] -> org only, no drive grants",
    r.json?.status === "added" && r.json?.drives?.length === 0,
    JSON.stringify(r.json?.drives),
  );
  r = await readAs(dan.apiKey, def.id);
  check("#124 org-only member cannot read default drive", r.status >= 400, String(r.status));
  // drive ids checked against org before any write (atomic)
  const eve = await register(U, "eve@team.test");
  const otherDrive = (await http(U, "GET", `/orgs/${bob.orgId}/drives`, { key: bob.apiKey })).json
    .drives[0];
  r = await A("POST", `/orgs/${O}/members/invite`, {
    email: "eve@team.test",
    role: "viewer",
    drives: [
      { driveId: dA.id, role: "viewer" },
      { driveId: otherDrive.id, role: "viewer" },
    ],
  });
  check("#124 foreign drive id -> 404, nothing written", r.status === 404, String(r.status));
  r = await readAs(eve.apiKey, dA.id);
  check("#124   eve got no partial grant on alpha", r.status >= 400, String(r.status));
  const m = await A("GET", `/orgs/${O}/members`);
  check(
    "#124   eve not added to the org",
    !(m.json?.members ?? []).some((x: any) => x.email === "eve@team.test"),
  );
  // member add (existing org member -> another drive)
  r = await A("POST", `/orgs/${O}/drives/${dB.id}/members`, {
    email: "bob@team.test",
    role: "editor",
  });
  check(
    "#124 drive add existing org member -> 201 created",
    r.status === 201 && r.json?.created === true,
    `${r.status}`,
  );
  r = await readAs(bob.apiKey, dB.id);
  check("#124   bob now reads beta", r.status === 200, String(r.status));
  r = await A("POST", `/orgs/${O}/drives/${dB.id}/members`, {
    email: "bob@team.test",
    role: "editor",
  });
  check(
    "#124 repeat add -> 200 (not created)",
    r.status === 200 && r.json?.created === false,
    `${r.status}`,
  );
  r = await A("POST", `/orgs/${O}/drives/${dB.id}/members`, {
    email: "stranger@nowhere.test",
    role: "viewer",
  });
  const r2 = await A("POST", `/orgs/${O}/drives/${dB.id}/members`, {
    email: "eve@team.test",
    role: "viewer",
  });
  check(
    "#124 non-member and unknown email get the same 404 'Not a member of this org'",
    r.status === 404 && r2.status === 404 && r.json?.message === r2.json?.message,
    `${r.status}/${r2.status} ${r.json?.message}`,
  );
  // manageable scope
  r = await A("GET", `/orgs/${O}/drives?scope=manageable`);
  check(
    "#124 scope=manageable lists every drive with myRole for org admin",
    r.json?.drives?.length === 3 && r.json.drives.every((x: any) => x.myRole),
    JSON.stringify((r.json?.drives ?? []).map((x: any) => x.myRole)),
  );
  r = await http(U, "GET", `/orgs/${O}/drives?scope=manageable`, { key: bob.apiKey });
  check(
    "#124 scope=manageable for bob (editor on beta, viewer alpha) lists none he cannot manage",
    (r.json?.drives ?? []).length === 0,
    JSON.stringify((r.json?.drives ?? []).map((x: any) => x.name)),
  );
  // non-admin cannot invite / add
  r = await http(U, "POST", `/orgs/${O}/members/invite`, {
    key: bob.apiKey,
    body: { email: "eve@team.test", role: "viewer" },
  });
  check("#124 negative: non-admin cannot invite", r.status === 403, String(r.status));

  // ---- #129 API behind Members page
  r = await A("GET", `/orgs/${O}/drives/${dA.id}/members`);
  check(
    "#129 drive members list shows admin + bob(viewer)",
    (r.json?.members ?? []).length === 2,
    JSON.stringify((r.json?.members ?? []).map((x: any) => [x.email, x.role])),
  );
  r = await A("PATCH", `/orgs/${O}/drives/${dA.id}/members/${bob.userId}`, { role: "editor" });
  check("#129 re-role bob viewer->editor", r.status === 200, String(r.status));
  r = await writeAs(bob.apiKey, dA.id);
  check("#129   bob can now write on alpha", r.status === 200, String(r.status));
  r = await A("PATCH", `/orgs/${O}/drives/${dA.id}/members/${bob.userId}`, { role: "viewer" });
  r = await writeAs(bob.apiKey, dA.id);
  check("#129   demoted back: write denied", r.status >= 400, String(r.status));
  r = await A("DELETE", `/orgs/${O}/drives/${dA.id}/members/${bob.userId}`);
  check("#129 remove bob from alpha", r.status === 200, String(r.status));
  r = await readAs(bob.apiKey, dA.id);
  check("#129   bob loses alpha access", r.status >= 400, String(r.status));
  r = await readAs(bob.apiKey, dB.id);
  check("#129   bob keeps beta (other drive untouched)", r.status === 200, String(r.status));
  // last admin guard
  r = await A("PATCH", `/orgs/${O}/drives/${dA.id}/members/${admin.userId}`, { role: "viewer" });
  check(
    "#129 INFO server has no last-admin guard on PATCH (UI guard is what the PR claims); demote -> status",
    true,
    `${r.status}`,
  );
  await A("PATCH", `/orgs/${O}/drives/${dA.id}/members/${admin.userId}`, { role: "admin" });
  r = await A("DELETE", `/orgs/${O}/drives/${dA.id}/members/${admin.userId}`);
  check(
    "#129 INFO server has no last-admin guard on DELETE; remove -> status",
    true,
    `${r.status}`,
  );
  await A("POST", `/orgs/${O}/drives/${dA.id}/members`, {
    email: "admin@team.test",
    role: "admin",
  });
  // non-admin sees 403 (page falls back to read-only)
  r = await http(U, "GET", `/orgs/${O}/drives/${dB.id}/members`, { key: bob.apiKey });
  check("#129 non-admin member gets 403 on admin endpoint", r.status === 403, String(r.status));
  // drive admin (non org admin) can add
  await A("PATCH", `/orgs/${O}/drives/${dB.id}/members/${bob.userId}`, { role: "admin" });
  r = await http(U, "POST", `/orgs/${O}/drives/${dB.id}/members`, {
    key: bob.apiKey,
    body: { email: "cara@team.test", role: "viewer" },
  });
  check(
    "#129 drive admin (not org admin) can add an org member by email",
    r.status === 201,
    String(r.status),
  );
  r = await http(U, "GET", `/orgs/${O}/drives?scope=manageable`, { key: bob.apiKey });
  check(
    "#129 drive admin's manageable list = beta only",
    (r.json?.drives ?? []).length === 1 && r.json.drives[0].id === dB.id,
    JSON.stringify((r.json?.drives ?? []).map((x: any) => x.name)),
  );

  // ---- #126 pending invites
  const db = new Database(join(d.home, "agent-fs.db"), { readonly: true });
  r = await A("POST", `/orgs/${O}/members/invite`, {
    email: "newbie@team.test",
    role: "viewer",
    drives: [{ driveId: dA.id, role: "editor" }],
  });
  check(
    "#126 unknown email -> status pending + token + acceptUrl (fragment form /invite#<token>) on APP_URL",
    r.status === 200 &&
      r.json?.status === "pending" &&
      !!r.json?.token &&
      String(r.json?.acceptUrl).startsWith(`${APP}/invite#`),
    `${r.status} ${r.json?.status} ${String(r.json?.acceptUrl).replace(/invite#.*/, "invite#<t>")}`,
  );
  const tok1 = r.json.token as string;
  check("#126 acceptUrl ends with the token", String(r.json.acceptUrl).endsWith(`/invite#${tok1}`));
  const row = db.query("select * from org_invites").all() as any[];
  check(
    "#126 only a hash stored (token not in DB)",
    row.length === 1 && !JSON.stringify(row).includes(tok1),
    `rows=${row.length}`,
  );
  r = await http(U, "GET", `/invites/${tok1}`);
  check(
    "#126 GET /invites/:token public preview (org, inviter, email, drives, expiry)",
    r.status === 200 &&
      r.json?.email === "newbie@team.test" &&
      !!r.json?.expiresAt &&
      !!r.json?.drives,
    `${r.status} keys=${Object.keys(r.json ?? {}).join(",")}`,
  );
  const pend = await A("GET", `/orgs/${O}/invites`);
  check("#126 admin pending list has 1", (pend.json?.invites ?? []).length === 1);
  // re-invite replaces
  r = await A("POST", `/orgs/${O}/members/invite`, {
    email: "newbie@team.test",
    role: "viewer",
    drives: [{ driveId: dB.id, role: "viewer" }],
  });
  const tok2 = r.json.token as string;
  const old = await http(U, "GET", `/invites/${tok1}`);
  check("#126 re-invite: old link dead (404)", old.status === 404, String(old.status));
  check(
    "#126 re-invite: still exactly one open invite",
    ((await A("GET", `/orgs/${O}/invites`)).json?.invites ?? []).length === 1,
  );
  // accept: wrong account
  const wrong = await register(U, "someoneelse@team.test");
  r = await http(U, "POST", `/invites/${tok2}/accept`, { key: wrong.apiKey });
  check(
    "#126 negative: accept with a different account refused",
    r.status >= 400,
    `${r.status} ${r.json?.message}`,
  );
  r = await http(U, "POST", `/invites/${tok2}/accept`);
  check("#126 negative: accept without signing in -> 401", r.status === 401, String(r.status));
  // newbie registers and accepts
  const nb = await register(U, "NewBie@Team.test");
  r = await http(U, "POST", `/invites/${tok2}/accept`, { key: nb.apiKey });
  check(
    "#126 positive: matching account (case-variant email) accepts",
    r.status === 200 && r.json?.ok === true,
    `${r.status} ${r.json?.message ?? ""}`,
  );
  r = await readAs(nb.apiKey, dB.id);
  check("#126   newbie reads the invited drive beta", r.status === 200, String(r.status));
  r = await readAs(nb.apiKey, dA.id);
  check("#126   newbie cannot read alpha (replaced invite)", r.status >= 400, String(r.status));
  r = await http(U, "POST", `/invites/${tok2}/accept`, { key: nb.apiKey });
  check("#126 token single-use: second accept refused", r.status >= 400, String(r.status));
  r = await http(U, "GET", `/invites/${tok2}`);
  check("#126   used token preview -> same 404", r.status === 404, String(r.status));
  check(
    "#126   pending list now empty",
    ((await A("GET", `/orgs/${O}/invites`)).json?.invites ?? []).length === 0,
  );
  // revoke
  r = await A("POST", `/orgs/${O}/members/invite`, { email: "revoked@team.test", role: "viewer" });
  const tok3 = r.json.token;
  const id3 = (await A("GET", `/orgs/${O}/invites`)).json.invites[0].id;
  r = await A("DELETE", `/orgs/${O}/invites/${id3}`);
  check("#126 admin revokes pending invite", r.status === 200, String(r.status));
  r = await http(U, "GET", `/invites/${tok3}`);
  check("#126   revoked token -> 404", r.status === 404, String(r.status));
  // expiry: make an invite 8 days old via DB
  r = await A("POST", `/orgs/${O}/members/invite`, { email: "late@team.test", role: "viewer" });
  const tok4 = r.json.token;
  const rw = new Database(join(d.home, "agent-fs.db"));
  const cols = (rw.query("pragma table_info(org_invites)").all() as any[]).map((c) => c.name);
  const expCol = cols.find((c) => /expire/i.test(c))!;
  const sample = (
    rw.query(`select ${expCol} as v from org_invites where email='late@team.test'`).get() as any
  ).v;
  const past =
    typeof sample === "number" && sample < 1e12
      ? Math.floor(Date.now() / 1000) - 86400
      : Date.now() - 86400_000;
  rw.query(`update org_invites set ${expCol}=? where email='late@team.test'`).run(past);
  rw.close();
  r = await http(U, "GET", `/invites/${tok4}`);
  check("#126 expired token -> 404 (expiry forced via DB)", r.status === 404, String(r.status));
  const late = await register(U, "late@team.test");
  r = await http(U, "POST", `/invites/${tok4}/accept`, { key: late.apiKey });
  check("#126   expired accept refused", r.status >= 400, String(r.status));
  // direct add after register revokes open invite
  r = await A("POST", `/orgs/${O}/members/invite`, { email: "later@team.test", role: "viewer" });
  const tok5 = r.json.token;
  await register(U, "later@team.test");
  r = await A("POST", `/orgs/${O}/members/invite`, { email: "later@team.test", role: "viewer" });
  check(
    "#126 re-invite after registration = direct add",
    r.json?.status === "added",
    String(r.json?.status),
  );
  r = await http(U, "GET", `/invites/${tok5}`);
  check("#126   direct add revoked the open invite", r.status === 404, String(r.status));
  db.close();
} finally {
  await d.stop();
}
// control: no APP_URL -> no acceptUrl
const c = await startDaemon({});
try {
  const a = await register(c.url, "a@x.test");
  const r = await http(c.url, "POST", `/orgs/${a.orgId}/members/invite`, {
    key: a.apiKey,
    body: { email: "z@x.test", role: "viewer" },
  });
  check(
    "#126 control: no AGENT_FS_APP_URL -> pending w/o acceptUrl",
    r.json?.status === "pending" && r.json?.acceptUrl === undefined,
    String(r.json?.acceptUrl),
  );
} finally {
  await c.stop();
}
finish("#124/#126/#129 API");
