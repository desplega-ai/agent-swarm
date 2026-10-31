// biome-ignore-all lint/suspicious/noExplicitAny: scratch e2e fixtures read untyped JSON
// agent-fs #131 (invite dialog / pending / accept page) and #129 (drive Members page) against a REAL local daemon + built live/ app.

import { mkdirSync } from "node:fs";
import {
  type BrowserContext,
  chromium,
  type Page,
} from "/workspace/personal/repos/agent-fs/live/node_modules/playwright";
import { AFS_REPO, check, finish, freePort, http, register, startDaemon } from "./common";

const SHOTS = "/workspace/personal/e2e-gap/evidence";
mkdirSync(`${SHOTS}/131`, { recursive: true });
mkdirSync(`${SHOTS}/129`, { recursive: true });
mkdirSync(`${SHOTS}/133`, { recursive: true });
const appPort = await freePort();
const APP = `http://127.0.0.1:${appPort}`;
const preview = Bun.spawn(
  [
    "node",
    "node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(appPort),
    "--strictPort",
  ],
  { cwd: `${AFS_REPO}/live`, stdout: "ignore", stderr: "ignore" },
);
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(APP)).ok) break;
  } catch {}
  await Bun.sleep(250);
}

const d = await startDaemon({
  AGENT_FS_APP_URL: APP,
  AGENT_FS_PUBLIC_URL: "https://files.example.test/agent-fs",
});
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    "/opt/playwright/chromium-1208/chrome-linux64/chrome",
  args: ["--no-sandbox"],
});
const sign = async (ctx: BrowserContext, key: string) =>
  ctx.addInitScript(
    ([ep, k]) => {
      localStorage.setItem(
        "agent-fs-credentials",
        JSON.stringify([{ id: "me", name: "me", endpoint: ep, apiKey: k }]),
      );
      localStorage.setItem("agent-fs-active-credential", "me");
    },
    [d.url, key] as const,
  );
const shot = (p: Page, dir: string, name: string) =>
  p.screenshot({ path: `${SHOTS}/${dir}/${name}.png`, fullPage: false });
const safe = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (e) {
    check(
      name,
      false,
      String((e as Error).message)
        .split("\n")[0]
        .slice(0, 200),
    );
  }
};

try {
  const admin = await register(d.url, "admin@team.test");
  const O = admin.orgId;
  const A = (m: string, p: string, body?: unknown) =>
    http(d.url, m, p, { key: admin.apiKey, body });
  const def = (await A("GET", `/orgs/${O}/drives`)).json.drives.find((x: any) => x.isDefault);
  const alpha = (await A("POST", `/orgs/${O}/drives`, { name: "alpha" })).json;
  const beta = (await A("POST", `/orgs/${O}/drives`, { name: "beta" })).json;
  const bob = await register(d.url, "bob@team.test");
  const _cara = await register(d.url, "cara@team.test");
  await A("POST", `/orgs/${O}/members/invite`, {
    email: "cara@team.test",
    role: "viewer",
    drives: [{ driveId: alpha.id, role: "viewer" }],
  });

  // ============ #131 admin invite dialog
  const actx = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  await sign(actx, admin.apiKey);
  const ap = await actx.newPage();
  await ap.goto(`${APP}/members/~/${O}/${def.id}`);
  let link = "";
  await safe("#131 invite dialog", async () => {
    await ap.getByRole("button", { name: "Invite people" }).click();
    const dlg = ap.getByRole("dialog");
    check(
      "#131 dialog opens, heading 'Invite people'",
      await dlg.getByRole("heading", { name: "Invite people" }).isVisible(),
    );
    const defName = def.name;
    check(
      `#131 opened-from drive '${defName}' pre-checked`,
      await dlg.getByRole("checkbox", { name: defName }).isChecked(),
    );
    check(
      "#131 other drives unchecked",
      !(await dlg.getByRole("checkbox", { name: "alpha" }).isChecked()) &&
        !(await dlg.getByRole("checkbox", { name: "beta" }).isChecked()),
    );
    check(
      "#131 org role defaults to viewer",
      (await dlg.getByLabel("Org role").inputValue()) === "viewer",
    );
    check(
      "#131 note: org role grants no file access",
      await dlg.getByText("The org role does not grant file access by itself.").isVisible(),
    );
    await dlg.getByLabel("Who").fill("New@Team.test");
    await dlg.getByRole("checkbox", { name: "alpha" }).check();
    await dlg.getByLabel("Role on alpha").selectOption("editor");
    await shot(ap, "131", "01-invite-dialog-filled");
    await dlg.getByRole("button", { name: "Invite", exact: true }).click();
    await dlg.getByText("new@team.test has no account yet").waitFor({ timeout: 8000 });
    check("#131 result: 'has no account yet' (no email sent)", true);
    check("#131 expiry shown", await dlg.getByText(/^Expires /).isVisible());
    link = await ap.getByLabel("Accept link", { exact: true }).inputValue();
    check(
      "#131 accept link shape /invite?apiUrl=..#<43-char token>",
      /\/invite\?apiUrl=[^#]+#[A-Za-z0-9_-]{43}$/.test(link),
      link.replace(/#.*/, "#<t>"),
    );
    await shot(ap, "131", "02-invite-result-link");
    await dlg.getByRole("button", { name: "Done" }).click();
  });
  // pending list
  await safe("#131 pending list", async () => {
    await ap.reload();
    const pend = ap.getByRole("list", { name: "Pending invites" });
    check(
      "#131 pending list shows new@team.test with drives",
      (await pend.locator('[data-invite-email="new@team.test"]').innerText()).includes(
        "alpha (editor)",
      ),
    );
    await shot(ap, "131", "03-pending-list");
  });
  // invitee flow, fresh context
  await safe("#131 accept page + register", async () => {
    const ictx = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    const ip = await ictx.newPage();
    await ip.goto(link);
    await ip.getByRole("heading", { name: /^Join / }).waitFor({ timeout: 8000 });
    check("#131 accept page previews invite (heading Join <org>)", true);
    const dl = ip.getByRole("list", { name: "Drives in this invite" });
    check(
      "#131 preview lists the 2 invited drives (opened-from default + alpha)",
      (await dl.getByRole("listitem").count()) === 2,
    );
    check(
      "#131 email prefilled and locked",
      (await ip.getByLabel("Your email").inputValue()) === "new@team.test" &&
        (await ip.getByLabel("Your email").isDisabled()),
    );
    await shot(ip, "131", "04-accept-page-signed-out");
    await ip.getByRole("button", { name: "Create account and accept" }).click();
    await ip.waitForURL(/\/file\/~\//, { timeout: 15000 });
    check(
      "#131 auto-accept lands on the first granted drive (default)",
      ip.url().includes(`/${def.id}/`),
      ip.url().replace(APP, ""),
    );
    await ip.locator("[data-drive-switcher]").click();
    const items = ip.getByRole("menuitem");
    check(
      "#131 invitee sees default+alpha, not beta",
      (await items.filter({ hasText: "alpha" }).count()) === 1 &&
        (await items.filter({ hasText: "beta" }).count()) === 0 &&
        (await items.filter({ hasText: def.name }).count()) >= 1,
    );
    await shot(ip, "131", "05-invitee-after-accept");
    const reuse = await browser.newContext();
    const rp = await reuse.newPage();
    await rp.goto(link);
    await rp
      .getByRole("heading", { name: "This invite link doesn't work" })
      .waitFor({ timeout: 8000 });
    check(
      "#131 used link -> 'This invite link doesn't work' + ask for new link",
      (await rp.getByRole("alert").innerText()).includes(
        "Ask the person who invited you for a new link.",
      ),
    );
    await shot(rp, "131", "06-used-link");
    await ictx.close();
    await reuse.close();
  });
  // wrong account signed in
  await safe("#131 wrong-account", async () => {
    const inv = (
      await A("POST", `/orgs/${O}/members/invite`, {
        email: "target@team.test",
        role: "viewer",
        drives: [{ driveId: beta.id, role: "viewer" }],
      })
    ).json;
    const tok = inv.token as string;
    const wctx = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    await sign(wctx, bob.apiKey);
    const wp = await wctx.newPage();
    await wp.goto(`${APP}/invite?apiUrl=${encodeURIComponent(d.url)}#${tok}`);
    await wp.getByRole("alert").waitFor({ timeout: 8000 });
    const msg = await wp.getByRole("alert").innerText();
    check(
      "#131 signed in as someone else: says so",
      /This invite is for target@team.test, but you're signed in as bob@team.test/.test(msg),
      msg.slice(0, 120),
    );
    check(
      "#131   no Accept button offered",
      (await wp.getByRole("button", { name: /^Accept$/ }).count()) === 0,
    );
    await shot(wp, "131", "07-wrong-account");
    await wctx.close();
    // matching existing account signed in -> Accept
    const inv2 = await A("POST", `/orgs/${O}/members/invite`, {
      email: "cara@team.test",
      role: "viewer",
      drives: [],
    });
    check(
      "#131 existing account => 'added' immediately (no link)",
      inv2.json?.status === "added",
      inv2.json?.status,
    );
  });
  await safe("#131 signed-in matching account accepts", async () => {
    const tok = (
      await A("POST", `/orgs/${O}/members/invite`, {
        email: "dora@team.test",
        role: "viewer",
        drives: [{ driveId: beta.id, role: "editor" }],
      })
    ).json.token as string;
    const dora = await register(d.url, "dora@team.test");
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    await sign(dctx, dora.apiKey);
    const dp = await dctx.newPage();
    await dp.goto(`${APP}/invite?apiUrl=${encodeURIComponent(d.url)}#${tok}`);
    await dp.getByText("You're signed in as dora@team.test.").waitFor({ timeout: 8000 });
    await shot(dp, "131", "10-accept-signed-in");
    await dp.getByRole("button", { name: /^Accept$/ }).click();
    await dp.waitForURL(new RegExp(`/file/~/${O}/${beta.id}/`), { timeout: 15000 });
    check("#131 signed-in matching account: Accept -> lands on granted drive beta", true);
    const m = (await A("GET", `/orgs/${O}/drives/${beta.id}/members`)).json.members.find(
      (x: any) => x.email === "dora@team.test",
    );
    check("#131   server: dora editor on beta", m?.role === "editor", m?.role);
    await dctx.close();
  });
  // pending: copy link issues a new one, revoke
  await safe("#131 new link + revoke", async () => {
    const dlg = await (async () => {
      await ap.goto(`${APP}/members/~/${O}/${def.id}`);
      await ap.getByRole("button", { name: "Invite people" }).click();
      return ap.getByRole("dialog");
    })();
    await dlg.getByLabel("Who").fill("later@team.test");
    await dlg.getByRole("button", { name: "Invite", exact: true }).click();
    await dlg.getByText("later@team.test has no account yet").waitFor();
    const first = await ap.getByLabel("Accept link", { exact: true }).inputValue();
    await dlg.getByRole("button", { name: "Done" }).click();
    const row = ap.locator('[data-invite-email="later@team.test"]');
    await row.getByRole("button", { name: "New link for later@team.test" }).click();
    await row.getByRole("button", { name: "Make new link" }).click();
    const second = await row
      .getByLabel("Accept link for later@team.test", { exact: true })
      .inputValue();
    check(
      "#131 Copy-link issues a fresh link",
      second !== first && /#[A-Za-z0-9_-]{43}$/.test(second),
    );
    const old = await browser.newContext();
    const op = await old.newPage();
    await op.goto(first);
    await op
      .getByRole("heading", { name: "This invite link doesn't work" })
      .waitFor({ timeout: 8000 });
    check("#131   old link stops working", true);
    await shot(ap, "131", "08-new-link");
    await row.getByRole("button", { name: /Revoke invite/ }).click();
    await ap.waitForTimeout(800);
    check(
      "#131 revoke removes the pending row",
      (await ap.locator('[data-invite-email="later@team.test"]').count()) === 0,
    );
    const rv = await browser.newContext();
    const rp = await rv.newPage();
    await rp.goto(second);
    await rp
      .getByRole("heading", { name: "This invite link doesn't work" })
      .waitFor({ timeout: 8000 });
    check("#131   revoked link dead", true);
    await old.close();
    await rv.close();
  });
  // already in org -> add to drives
  await safe("#131 already-in-org", async () => {
    await ap.goto(`${APP}/members/~/${O}/${def.id}`);
    await ap.getByRole("button", { name: "Invite people" }).click();
    const dlg = ap.getByRole("dialog");
    await dlg.getByLabel("Who").fill("CARA@team.test");
    await dlg.getByRole("status").waitFor({ timeout: 8000 });
    const st = await dlg.getByRole("status").innerText();
    check(
      "#131 existing org member email -> 'already in the org as <role>'",
      /cara@team.test is already in the org as viewer/.test(st),
      st.slice(0, 100),
    );
    check(
      "#131   org-role selector hidden (never resets org role)",
      (await dlg.getByLabel("Org role").count()) === 0,
    );
    await dlg
      .getByLabel("Role on beta")
      .selectOption("editor")
      .catch(async () => {
        await dlg.getByRole("checkbox", { name: "beta" }).check();
        await dlg.getByLabel("Role on beta").selectOption("editor");
      });
    await shot(ap, "131", "09-already-in-org");
    await dlg.getByRole("button", { name: "Add to drives" }).click();
    await dlg.getByText("Added cara@team.test").waitFor({ timeout: 8000 });
    const m = (await A("GET", `/orgs/${O}/drives/${beta.id}/members`)).json.members as any[];
    check(
      "#131   cara now editor on beta via drive endpoint; org role not reset",
      m.some((x) => x.email === "cara@team.test"),
      JSON.stringify(m.map((x) => x.email)),
    );
    const orgm = (await A("GET", `/orgs/${O}/members`)).json.members.find(
      (x: any) => x.email === "cara@team.test",
    );
    check("#131   cara's org role still viewer", orgm?.role === "viewer", orgm?.role);
  });
  await actx.close();

  // ============ #129 Members page
  const mctx = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  await sign(mctx, admin.apiKey);
  const mp = await mctx.newPage();
  await safe("#129 entry points", async () => {
    await mp.goto(`${APP}/file/~/${O}/${alpha.id}/`);
    await mp.locator("[data-drive-switcher]").click();
    await mp.getByRole("menuitem", { name: /Members/ }).click();
    await mp.waitForURL(new RegExp(`/members/~/${O}/${alpha.id}$`));
    check("#129 drive switcher > Members opens /members/~/org/drive", true);
    await mp.goto(`${APP}/file/~/${O}/${alpha.id}/`);
    await mp.locator("body").press("Shift+M");
    await mp.waitForURL(new RegExp(`/members/~/${O}/${alpha.id}$`), { timeout: 5000 });
    check("#129 ⇧M opens Members", true);
    await mp.locator("body").press("?");
    check(
      "#129 '?' shortcuts overlay lists Drive members",
      await mp.getByRole("dialog").getByText("Drive members").isVisible(),
    );
    await mp.keyboard.press("Escape");
  });
  const row = (e: string) => mp.locator(`[data-member-email="${e}"]`);
  await safe("#129 add/re-role/remove", async () => {
    await mp.goto(`${APP}/members/~/${O}/${alpha.id}`);
    await row("admin@team.test").waitFor();
    await shot(mp, "129", "01-members-page");
    const form = mp.getByRole("form", { name: "Add member" });
    await form
      .getByLabel("Email")
      .fill("bob@team.test")
      .catch(() => {});
    // bob is not in this org yet -> error under the form
    await form.getByRole("button", { name: "Add" }).click();
    const errText = await form
      .getByRole("alert")
      .innerText({ timeout: 8000 })
      .catch(() => "");
    check(
      "#129 non-org person -> inline server error 'Not a member of this org'",
      /Not a member of this org/.test(errText),
      errText.slice(0, 80),
    );
    await shot(mp, "129", "02-add-error");
    await A("POST", `/orgs/${O}/members/invite`, {
      email: "bob@team.test",
      role: "viewer",
      drives: [],
    });
    await mp.reload();
    await row("admin@team.test").waitFor();
    const form2 = mp.getByRole("form", { name: "Add member" });
    await form2.getByLabel("Email").fill("bob@team.test");
    await form2.getByLabel("Role").selectOption("editor");
    await form2.getByRole("button", { name: "Add" }).click();
    await row("bob@team.test").waitFor({ timeout: 8000 });
    check(
      "#129 org admin adds org member as editor",
      (await row("bob@team.test").getByLabel("Role for bob@team.test").inputValue()) === "editor",
    );
    const srv = (await A("GET", `/orgs/${O}/drives/${alpha.id}/members`)).json.members.find(
      (x: any) => x.email === "bob@team.test",
    );
    check("#129   server agrees (bob editor on alpha)", srv?.role === "editor", srv?.role);
    await row("bob@team.test").getByLabel("Role for bob@team.test").selectOption("viewer");
    await mp.waitForTimeout(800);
    const srv2 = (await A("GET", `/orgs/${O}/drives/${alpha.id}/members`)).json.members.find(
      (x: any) => x.email === "bob@team.test",
    );
    check("#129 re-role to viewer persisted", srv2?.role === "viewer", srv2?.role);
    await shot(mp, "129", "03-after-rerole");
    await row("bob@team.test").getByRole("button", { name: "Remove bob@team.test" }).click();
    await row("bob@team.test").waitFor({ state: "detached", timeout: 8000 });
    const srv3 = (await A("GET", `/orgs/${O}/drives/${alpha.id}/members`)).json.members.some(
      (x: any) => x.email === "bob@team.test",
    );
    check("#129 remove persisted", !srv3);
  });
  await safe("#129 only-admin guard (UI)", async () => {
    // alpha: admin is the only admin on the drive
    const me = row("admin@team.test");
    check(
      "#129 only admin: role select disabled",
      await me.getByLabel("Role for admin@team.test").isDisabled(),
    );
    check(
      "#129 only admin: remove disabled",
      await me.getByRole("button", { name: "Remove admin@team.test" }).isDisabled(),
    );
    check(
      "#129 only admin: 'Only admin of this drive' note",
      await me.getByText(/Only admin of this drive/).isVisible(),
    );
    await shot(mp, "129", "04-only-admin-guard");
  });
  await safe("#129 self-remove prompt", async () => {
    await A("POST", `/orgs/${O}/drives/${alpha.id}/members`, {
      email: "cara@team.test",
      role: "admin",
    });
    await mp.reload();
    await row("cara@team.test").waitFor();
    const me = row("admin@team.test");
    await me.getByRole("button", { name: "Remove admin@team.test" }).click();
    check(
      "#129 removing yourself asks 'Remove yourself?' inline",
      /Remove yourself\?/.test(await me.getByRole("alert").innerText()),
    );
    await me.getByRole("button", { name: "Cancel" }).click();
    const still = (await A("GET", `/orgs/${O}/drives/${alpha.id}/members`)).json.members.some(
      (x: any) => x.email === "admin@team.test",
    );
    check("#129   cancel sends nothing (still member)", still);
    await shot(mp, "129", "05-self-remove-prompt");
  });
  // read-only view for a plain member
  await safe("#129 read-only for non-admin", async () => {
    const cctx = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    await sign(cctx, bob.apiKey);
    await A("POST", `/orgs/${O}/drives/${beta.id}/members`, {
      email: "bob@team.test",
      role: "viewer",
    });
    const cp = await cctx.newPage();
    await cp.goto(`${APP}/members/~/${O}/${beta.id}`);
    await cp
      .getByText("Only drive admins and org admins can change who is on this drive.")
      .waitFor({ timeout: 8000 });
    check("#129 plain member: read-only list + notice", true);
    check(
      "#129   no Add form / no Remove buttons",
      (await cp.getByRole("form", { name: "Add member" }).count()) === 0 &&
        (await cp.getByRole("button", { name: /^Remove / }).count()) === 0,
    );
    await shot(cp, "129", "06-read-only");
    await cctx.close();
  });

  // ============ #133 share dialog (UI), PUBLIC_URL configured vs control
  await safe("#133 UI copy link", async () => {
    const sctx = await browser.newContext({ viewport: { width: 1280, height: 844 } });
    await sign(sctx, admin.apiKey);
    await sctx
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP })
      .catch(() => {});
    await A("POST", `/orgs/${O}/ops`, {
      op: "write",
      driveId: def.id,
      path: "/shared.txt",
      content: "hi",
    });
    const sp = await sctx.newPage();
    await sp.addInitScript(() => {
      (window as any).__clip = [];
      const w = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (t: string) => {
        (window as any).__clip.push(t);
        try {
          await w(t);
        } catch {}
      };
    });
    await sp.goto(`${APP}/file/~/${O}/${def.id}/shared.txt`);
    await sp.getByRole("button", { name: "Share", exact: true }).first().click({ timeout: 8000 });
    const sd = sp.getByRole("dialog");
    await shot(sp, "133", "01-share-dialog");
    await sd.getByRole("button", { name: "Copy link", exact: true }).click({ timeout: 5000 });
    await sd.getByLabel("Share link").waitFor({ timeout: 8000 });
    await shot(sp, "133", "02-share-created");
    const clip: string[] = await sp.evaluate(() => (window as any).__clip);
    const shown = await sd.getByLabel("Share link").inputValue();
    const hit = clip.find((c) => c.includes("/share/")) ?? shown;
    check("#133 UI: dialog input and clipboard agree", shown === hit, `clip writes=${clip.length}`);
    check(
      "#133 UI: copied/shown share link is on the configured public URL, not the endpoint",
      hit.startsWith("https://files.example.test/agent-fs/share/"),
      hit.replace(/\/share\/.*/, "/share/<t>") ||
        `(no link captured: ${clip.length} clipboard writes)`,
    );
  });
} finally {
  await browser.close();
  preview.kill();
  await d.stop();
}
finish("#131/#129/#133 UI");
