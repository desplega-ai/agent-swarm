/**
 * The self-hosted dashboard's page previews, end to end: the shipped
 * `apps/ui/nginx.conf` and `apps/ui/nginx-page-share.sh` (the image's
 * 40-page-share.sh) on a real nginx, in front of the real `/p/:id/share`
 * handler with default API settings (no APP_URL, no PUBLIC_MCP_BASE_URL).
 *
 *   - a bot on a public /pages/:id gets the page's tags, with og:url on the
 *     dashboard origin it reached (the X-Swarm-Dashboard-Origin header)
 *   - nginx resolves SWARM_API_URL per request: an unresolvable host still
 *     starts nginx and serves the generic card
 *   - an out-of-range port or an invalid URL writes no proxy and logs why
 *
 * Needs an nginx binary (`NGINX_BIN`, else `nginx` on PATH or /usr/sbin/nginx;
 * GitHub's Ubuntu runners ship one). Skipped locally without one; under CI a
 * missing binary fails the run so the coverage never goes silently dark.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "../be/db";
import { handlePages } from "../http/pages";
import { handlePagesPublic } from "../http/pages-public";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { getFreePort, listenOnFreePort } from "./test-net";
import { runChild } from "./test-proc";

const REPO = join(import.meta.dir, "..", "..");
const SHARE_SCRIPT = join(REPO, "apps/ui/nginx-page-share.sh");
const NGINX =
  process.env.NGINX_BIN ||
  Bun.which("nginx") ||
  ["/usr/sbin/nginx", "/usr/local/sbin/nginx"].find((p) => existsSync(p)) ||
  "";
const TEST_DB_PATH = "./test-pages-share-nginx.sqlite";
const BOT = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
const GENERIC_INDEX = `<!doctype html><html><head><meta property="og:image" content="/og-image.png"></head><body>spa</body></html>`;

function metaContent(html: string, key: string): string | null {
  const m = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html);
  return m ? (m[1] ?? null) : null;
}

test("CI has an nginx binary for the dashboard proxy tests", () => {
  if (process.env.CI) expect(NGINX).not.toBe("");
});

describe.skipIf(!NGINX)("self-hosted dashboard nginx: page previews", () => {
  let api: Server;
  let apiBase = "";
  let work = "";
  const agentId = crypto.randomUUID();
  const running: Array<{ proc: ReturnType<typeof Bun.spawn>; base: string }> = [];
  const ORIG = {
    APP_URL: process.env.APP_URL,
    DASHBOARD_URL: process.env.DASHBOARD_URL,
    MCP_BASE_URL: process.env.MCP_BASE_URL,
    PUBLIC_MCP_BASE_URL: process.env.PUBLIC_MCP_BASE_URL,
  };

  /**
   * Run the shipped entrypoint script with `swarmApiUrl`, then start nginx on
   * the shipped server block (paths moved into a temp dir). Returns the
   * dashboard base URL plus the script's stderr.
   */
  async function startDashboard(
    swarmApiUrl: string,
    resolvConf = "/etc/resolv.conf",
  ): Promise<{ base: string; log: string; conf: string | null }> {
    const dir = await mkdtemp(join(work, "ui-"));
    const shareDir = join(dir, "share");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NGINX_PAGE_SHARE_DIR: shareDir,
      NGINX_PAGE_SHARE_RESOLV_CONF: resolvConf,
      SWARM_API_URL: swarmApiUrl,
    };
    const script = await runChild(["sh", SHARE_SCRIPT], { env });
    expect(script.exitCode).toBe(0);
    const conf = existsSync(join(shareDir, "api.conf"))
      ? await readFile(join(shareDir, "api.conf"), "utf8")
      : null;

    const port = await getFreePort();
    await mkdir(join(dir, "html"), { recursive: true });
    await writeFile(join(dir, "html", "index.html"), GENERIC_INDEX);
    await writeFile(join(dir, "html", "og-image.png"), "png");
    const server = (await readFile(join(REPO, "apps/ui/nginx.conf"), "utf8"))
      .replace("listen 8080;", `listen 127.0.0.1:${port};`)
      .replace("root /usr/share/nginx/html;", `root ${join(dir, "html")};`)
      .replace("include /tmp/nginx-page-share/*.conf;", `include ${shareDir}/*.conf;`)
      .replace(/access_log \/var\/log\/nginx\/access\.log ui_noquery;/, "access_log off;");
    await writeFile(join(dir, "server.conf"), server);
    await writeFile(
      join(dir, "nginx.conf"),
      `daemon off;
pid ${join(dir, "nginx.pid")};
error_log stderr warn;
events { worker_connections 64; }
http {
  types { text/html html; image/png png; }
  default_type application/octet-stream;
  client_body_temp_path ${dir}/client_temp;
  proxy_temp_path ${dir}/proxy_temp;
  fastcgi_temp_path ${dir}/fastcgi_temp;
  uwsgi_temp_path ${dir}/uwsgi_temp;
  scgi_temp_path ${dir}/scgi_temp;
  include ${join(dir, "server.conf")};
}
`,
    );
    const proc = Bun.spawn([NGINX, "-e", "stderr", "-p", dir, "-c", join(dir, "nginx.conf")], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const base = `http://127.0.0.1:${port}`;
    running.push({ proc, base });
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) break;
      try {
        if ((await fetch(`${base}/healthz`)).ok) break;
      } catch {}
      await Bun.sleep(50);
    }
    if (proc.exitCode !== null) {
      throw new Error(`nginx exited ${proc.exitCode}: ${await new Response(proc.stderr).text()}`);
    }
    return { base, log: script.stderr + script.stdout, conf };
  }

  async function botView(base: string, id: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/pages/${id}`, { headers: { "User-Agent": BOT, ...headers } });
    return { status: res.status, cache: res.headers.get("cache-control"), html: await res.text() };
  }

  async function createPublicPage(title: string): Promise<string> {
    const res = await fetch(`${apiBase}/api/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
      body: JSON.stringify({
        contentType: "text/html",
        title,
        description: "Shared from a self-hosted dashboard.",
        authMode: "public",
        body: "<p>body</p>",
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"])
      await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
    // Default API settings: no dashboard URL, no public API URL.
    for (const key of Object.keys(ORIG)) delete process.env[key];
    initDb(TEST_DB_PATH);
    api = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const pathSegments = getPathSegments(req.url || "");
      const queryParams = parseQueryParams(req.url || "");
      if (await handlePagesPublic(req, res, pathSegments, queryParams)) return;
      const agent = req.headers["x-agent-id"] as string | undefined;
      if (await handlePages(req, res, pathSegments, queryParams, agent)) return;
      res.writeHead(404);
      res.end("not found");
    });
    apiBase = `http://127.0.0.1:${await listenOnFreePort(api, "127.0.0.1")}`;
    work = await mkdtemp(join(tmpdir(), "pages-share-nginx-"));
  });

  afterAll(async () => {
    for (const { proc } of running) proc.kill("SIGKILL");
    await Promise.all(running.map(({ proc }) => proc.exited));
    await new Promise<void>((resolve) => api.close(() => resolve()));
    closeDb();
    for (const [key, value] of Object.entries(ORIG)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const suffix of ["", "-wal", "-shm"])
      await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
    if (work) await rm(work, { recursive: true, force: true });
  });

  test("a bot on a public /pages/:id gets its tags, linked to the dashboard it reached", async () => {
    const id = await createPublicPage("Self-hosted share");
    const { base, log, conf } = await startDashboard(`${apiBase}/`);
    expect(log).toContain(`page link previews from ${apiBase}`);
    expect(conf).toContain("proxy_pass $page_share_upstream;");

    const view = await botView(base, id);
    expect(view.status).toBe(200);
    expect(view.cache).toBe("private, no-store");
    expect(metaContent(view.html, "og:title")).toBe("Self-hosted share");
    // APP_URL unset: og:url and canonical are the dashboard origin, never localhost:5274.
    expect(metaContent(view.html, "og:url")).toBe(`${base}/pages/${id}`);
    expect(view.html).toContain(`<link rel="canonical" href="${base}/pages/${id}">`);
    expect(view.html).not.toContain("localhost:5274");
    // The card stays on the API's own origin.
    expect(metaContent(view.html, "og:image")).toBe(`${apiBase}/p/${id}/og.png`);

    // Behind a TLS proxy: the forwarded proto and host win.
    const proxied = await botView(base, id, {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "dash.example.com",
    });
    expect(metaContent(proxied.html, "og:url")).toBe(`https://dash.example.com/pages/${id}`);

    // APP_URL still wins over the request's origin.
    process.env.APP_URL = "https://app.example.com";
    try {
      const configured = await botView(base, id);
      expect(metaContent(configured.html, "og:url")).toBe(`https://app.example.com/pages/${id}`);
    } finally {
      delete process.env.APP_URL;
    }

    // A browser gets the SPA; a private or missing page gets the generic card.
    const browser = await (await fetch(`${base}/pages/${id}`)).text();
    expect(browser).toBe(GENERIC_INDEX);
    expect((await botView(base, "missing-page")).html).toBe(GENERIC_INDEX);
  }, 30_000);

  test("an unresolvable SWARM_API_URL host still starts nginx and serves the generic card", async () => {
    const id = await createPublicPage("Unresolvable API");
    // A nameserver that answers nothing: resolution fails per request, not at start.
    const resolv = join(work, "resolv.conf");
    await writeFile(resolv, "nameserver 127.0.0.1\n");
    const { base, conf } = await startDashboard("http://no-such-api.invalid:3013", resolv);
    expect(conf).toContain("resolver 127.0.0.1 valid=30s;");
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const view = await botView(base, id);
    expect(view.status).toBe(200);
    expect(view.html).toBe(GENERIC_INDEX);
  }, 30_000);

  test("an out-of-range port or an invalid URL writes no proxy, logs why, and keeps the SPA", async () => {
    const id = await createPublicPage("Bad port");
    for (const [url, reason] of [
      ["http://127.0.0.1:99999", "port '99999' is out of range"],
      ["http://127.0.0.1:0", "port '0' is out of range"],
      ["http://-bad-.example.com", "is not a valid hostname"],
      ["ftp://api.example.com", "is not a plain http(s) URL"],
    ] as const) {
      const { base, log, conf } = await startDashboard(url);
      expect(log).toContain(reason);
      expect(log).toContain("page links keep the generic preview");
      expect(conf).toBeNull();
      expect((await botView(base, id)).html).toBe(GENERIC_INDEX);
    }
  }, 30_000);
});
