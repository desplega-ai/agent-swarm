/**
 * Share previews for pages:
 *   - `/p/:id` injects Open Graph + Twitter tags into a PUBLIC html page, with
 *     the dashboard card URL only when an app URL is configured
 *   - a body that sets its own `og:title` keeps its tags
 *   - `/p/:id/og` returns title + description for public pages and the same
 *     404 for missing, password and authed pages
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, initDb } from "../be/db";
import { handlePages } from "../http/pages";
import { handlePagesPublic } from "../http/pages-public";
import { getPathSegments, parseQueryParams } from "../http/utils";
import {
  buildPageShareMeta,
  clipText,
  declaresOpenGraph,
  pageOgImageUrl,
  renderPageShareMeta,
} from "../pages/page-og";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-pages-og.sqlite";
let BASE = "";

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handlePagesPublic(req, res, pathSegments, queryParams)) return;
    if (await handlePages(req, res, pathSegments, queryParams, myAgentId)) return;
    res.writeHead(404);
    res.end("not found");
  });
}

function metaContent(html: string, key: string): string | null {
  const m = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html);
  return m ? (m[1] ?? null) : null;
}

describe("page-og helpers", () => {
  test("card URL carries title and subtitle as the landing /api/og params", () => {
    const url = new URL(
      pageOgImageUrl("https://app.example.com/", "Helmcode × Agent Swarm", "A benchmark."),
    );
    expect(url.origin + url.pathname).toBe("https://app.example.com/api/og");
    expect(url.searchParams.get("title")).toBe("Helmcode × Agent Swarm");
    expect(url.searchParams.get("subtitle")).toBe("A benchmark.");
    expect(new URL(pageOgImageUrl("https://a.dev", "T", null)).searchParams.has("subtitle")).toBe(
      false,
    );
  });

  test("clipText cuts at a word boundary", () => {
    expect(clipText("short", 10)).toBe("short");
    expect(clipText("one two three four", 12)).toBe("one two…");
  });

  test("tags escape attribute values and pick the card type", () => {
    const html = renderPageShareMeta(
      buildPageShareMeta({ title: `A "quoted" <b>`, description: "x & y" }, "https://a.dev"),
    );
    expect(metaContent(html, "og:title")).toBe("A &quot;quoted&quot; &lt;b&gt;");
    expect(metaContent(html, "og:description")).toBe("x &amp; y");
    expect(metaContent(html, "twitter:card")).toBe("summary_large_image");
    const bare = renderPageShareMeta(buildPageShareMeta({ title: "T", description: null }, null));
    expect(metaContent(bare, "og:image")).toBeNull();
    expect(metaContent(bare, "og:description")).toBeNull();
    expect(metaContent(bare, "twitter:card")).toBe("summary");
  });

  test("declaresOpenGraph spots an author og:title", () => {
    expect(declaresOpenGraph(`<meta property="og:title" content="x">`)).toBe(true);
    expect(declaresOpenGraph(`<META content="x" PROPERTY='og:title'>`)).toBe(true);
    expect(declaresOpenGraph(`<meta name="description" content="og:title">`)).toBe(false);
  });
});

describe("GET /p/:id share tags and /p/:id/og", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Agent-ID": agentId };
  const ORIG_APP = process.env.APP_URL;
  const ORIG_DASHBOARD = process.env.DASHBOARD_URL;

  async function createPage(body: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ contentType: "text/html", ...body }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    server = createTestServer();
    BASE = `http://localhost:${await listenOnFreePort(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    if (ORIG_APP === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = ORIG_APP;
    if (ORIG_DASHBOARD === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = ORIG_DASHBOARD;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("a public html page gets its own og tags and the dashboard card", async () => {
    process.env.APP_URL = "https://app.example.com";
    delete process.env.DASHBOARD_URL;
    const id = await createPage({
      slug: "og-public",
      title: "Helmcode × Agent Swarm: model benchmark",
      description: "Open models on 14 tasks.",
      authMode: "public",
      body: "<!doctype html><html><head><title>X</title></head><body>hi</body></html>",
    });
    const html = await (await fetch(`${BASE}/p/${id}`)).text();
    expect(metaContent(html, "og:title")).toBe("Helmcode × Agent Swarm: model benchmark");
    expect(metaContent(html, "og:description")).toBe("Open models on 14 tasks.");
    expect(metaContent(html, "twitter:card")).toBe("summary_large_image");
    const image = metaContent(html, "og:image")?.replace(/&amp;/g, "&") ?? "";
    const imageUrl = new URL(image);
    expect(imageUrl.origin + imageUrl.pathname).toBe("https://app.example.com/api/og");
    expect(imageUrl.searchParams.get("title")).toBe("Helmcode × Agent Swarm: model benchmark");
    // The tags land inside <head>, before the body.
    expect(html.indexOf('property="og:title"')).toBeLessThan(html.indexOf("<body>"));
  });

  test("without an app URL the tags omit the card image", async () => {
    delete process.env.APP_URL;
    delete process.env.DASHBOARD_URL;
    const id = await createPage({
      slug: "og-no-app",
      title: "No app",
      authMode: "public",
      body: "<html><head></head><body>x</body></html>",
    });
    const html = await (await fetch(`${BASE}/p/${id}`)).text();
    expect(metaContent(html, "og:title")).toBe("No app");
    expect(metaContent(html, "og:image")).toBeNull();
    expect(metaContent(html, "twitter:card")).toBe("summary");
  });

  test("a body with its own og:title keeps only the author tags", async () => {
    process.env.APP_URL = "https://app.example.com";
    const id = await createPage({
      slug: "og-author",
      title: "Swarm title",
      authMode: "public",
      body: `<html><head><meta property="og:title" content="Author title"></head><body>x</body></html>`,
    });
    const html = await (await fetch(`${BASE}/p/${id}`)).text();
    expect(html.match(/property="og:title"/g)?.length).toBe(1);
    expect(metaContent(html, "og:title")).toBe("Author title");
  });

  test("/p/:id/og returns title and description for a public page only", async () => {
    const pub = await createPage({
      slug: "og-meta-public",
      title: "Shared",
      description: "Desc",
      authMode: "public",
      body: "<p>secret body</p>",
    });
    const res = await fetch(`${BASE}/p/${pub}/og`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: pub, title: "Shared", description: "Desc" });

    const noDesc = await createPage({
      slug: "og-meta-nodesc",
      title: "Bare",
      authMode: "public",
      body: "<p>x</p>",
    });
    expect(await (await fetch(`${BASE}/p/${noDesc}/og`)).json()).toEqual({
      id: noDesc,
      title: "Bare",
      description: null,
    });
  });

  test("a page made private stops answering at once, and no response was storable", async () => {
    process.env.APP_URL = "https://app.example.com";
    const id = await createPage({
      slug: "og-goes-private",
      title: "Soon private title",
      description: "Soon private description",
      authMode: "public",
      body: "<html><head></head><body>x</body></html>",
    });
    const before = await fetch(`${BASE}/p/${id}/og`);
    expect(before.status).toBe(200);
    // A shared cache may store neither the metadata nor the tagged HTML.
    expect(before.headers.get("cache-control")).toBe("no-store");
    const page = await fetch(`${BASE}/p/${id}`);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(metaContent(await page.text(), "og:title")).toBe("Soon private title");

    const update = await fetch(`${BASE}/api/pages/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ authMode: "authed" }),
    });
    expect(update.status).toBe(200);

    const after = await fetch(`${BASE}/p/${id}/og`);
    expect(after.status).toBe(404);
    expect(after.headers.get("cache-control")).toBe("no-store");
    expect(await after.text()).not.toContain("Soon private");
    const gated = await (await fetch(`${BASE}/p/${id}`)).text();
    expect(gated).not.toContain("Soon private");
  });

  test("password and authed pages expose nothing: 404 on /og, no tags on /p/:id", async () => {
    process.env.APP_URL = "https://app.example.com";
    const authed = await createPage({
      slug: "og-authed",
      title: "Private authed title",
      description: "Private authed description",
      authMode: "authed",
      body: "<html><head></head><body>x</body></html>",
    });
    const locked = await createPage({
      slug: "og-password",
      title: "Private password title",
      description: "Private password description",
      authMode: "password",
      password: "hunter22-hunter22",
      body: "<html><head></head><body>x</body></html>",
    });
    for (const id of [authed, locked, crypto.randomUUID()]) {
      const res = await fetch(`${BASE}/p/${id}/og`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain("Private");
    }
    // Unlock the password page: the served body still carries no share tags.
    const unlocked = await fetch(`${BASE}/p/${locked}?key=hunter22-hunter22`);
    expect(unlocked.status).toBe(200);
    const html = await unlocked.text();
    expect(html).not.toContain("og:title");
    expect(html).not.toContain("Private password");
  });
});
