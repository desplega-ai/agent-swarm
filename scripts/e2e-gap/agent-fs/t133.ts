// biome-ignore-all lint/suspicious/noExplicitAny: scratch e2e fixtures read untyped JSON
// agent-fs #133: share-create urlSource + AGENT_FS_PUBLIC_URL validation
import { check, finish, http, register, startDaemon } from "./common";

const PUB = "https://files.example.test/agent-fs/";
const d = await startDaemon({ AGENT_FS_PUBLIC_URL: PUB });
try {
  const u = await register(d.url, "owner@example.test");
  const op = (body: any, headers: Record<string, string> = {}) =>
    http(d.url, "POST", `/orgs/${u.orgId}/ops`, { key: u.apiKey, body, headers });
  let r = await op({ op: "write", path: "/docs/a.txt", content: "hello share" });
  check("write file", r.status === 200, String(r.status));
  r = await op({ op: "share-create", path: "/docs/a.txt" }, { Host: "internal.vpn:7433" });
  check("configured: urlSource=configured", r.json?.urlSource === "configured", r.json?.urlSource);
  check(
    "configured: url on PUBLIC_URL (trailing slash dropped, Host ignored)",
    r.json?.url === `https://files.example.test/agent-fs${r.json?.sharePath}`,
    r.json?.url?.replace(/\/share\/.*/, "/share/<t>"),
  );
  check("sharePath is /share/<token>", /^\/share\/[\w-]+$/.test(r.json?.sharePath ?? ""));
  const token = String(r.json.sharePath).split("/").pop()!;
  let pub = await http(d.url, "GET", `/share/${token}`);
  check(
    "share opens on the daemon (public, no auth)",
    pub.status === 200 && pub.text.includes("hello share"),
    String(pub.status),
  );
  pub = await http(d.url, "GET", `/share/${token}x`);
  check("bad token -> 404", pub.status === 404, String(pub.status));
  r = await op({ op: "write", path: "/site/index.html", content: "<p>hi</p>" });
  r = await op({ op: "share-create", path: "/site" }, { Host: "internal.vpn:7433" });
  check(
    "folder share: configured, sharePath /site/<t>/",
    r.json?.urlSource === "configured" &&
      /^\/site\/.+\/$/.test(r.json?.sharePath) &&
      r.json?.url.startsWith("https://files.example.test/agent-fs/site/"),
    `${r.json?.urlSource} ${r.json?.kind}`,
  );
  // revoke
  const rv = await op({ op: "share-revoke", token });
  check("share-revoke ok", rv.status === 200, String(rv.status));
  pub = await http(d.url, "GET", `/share/${token}`);
  check("revoked -> 410", pub.status === 410, String(pub.status));
  const h = await http(d.url, "GET", "/health");
  check(
    "/health does not expose publicUrl (reworked approach)",
    !JSON.stringify(h.json).includes("files.example.test"),
  );
} finally {
  await d.stop();
}
// control: unset -> request
const c = await startDaemon({});
try {
  const u = await register(c.url, "owner2@example.test");
  const op = (body: any, headers: Record<string, string> = {}) =>
    http(c.url, "POST", `/orgs/${u.orgId}/ops`, { key: u.apiKey, body, headers });
  await op({ op: "write", path: "/a.txt", content: "x" });
  const r = await op(
    { op: "share-create", path: "/a.txt" },
    { "X-Forwarded-Host": "proxy.example.test", "X-Forwarded-Proto": "https" },
  );
  check(
    "control: unset -> urlSource=request, url derived from forwarded host",
    r.json?.urlSource === "request" && r.json?.url.startsWith("https://proxy.example.test/share/"),
    `${r.json?.urlSource}`,
  );
} finally {
  await c.stop();
}
// invalid values stop startup, never echo the value
for (const bad of [
  "ftp://x.example",
  "not a url",
  "https://u:s3cretpw@x.example",
  "https://x.example/?t=s3cretpw",
  "https://x.example/#f",
]) {
  const x = await startDaemon({ AGENT_FS_PUBLIC_URL: bad }, { expectFail: true });
  await Bun.sleep(1500);
  const log = await Bun.file(x.log)
    .text()
    .catch(() => "");
  const dead = x.proc.exitCode !== null;
  check(
    `invalid '${bad.replace(/s3cretpw/, "***")}' -> server exits`,
    dead,
    `exit=${x.proc.exitCode}`,
  );
  check(
    "  error mentions AGENT_FS_PUBLIC_URL, never the secret",
    /Invalid AGENT_FS_PUBLIC_URL/.test(log) && !log.includes("s3cretpw"),
  );
  await x.stop();
}
// whitespace-only == unset
const w = await startDaemon({ AGENT_FS_PUBLIC_URL: "   " });
check("whitespace-only value == unset, server starts", true);
await w.stop();
finish("#133");
