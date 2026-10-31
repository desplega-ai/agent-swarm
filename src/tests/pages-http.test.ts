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
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { Page } from "../types";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-pages-http.sqlite";
let baseUrl = "";

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;

    const handled = await handlePages(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

describe("Pages HTTP API", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "X-Agent-ID": agentId,
  };

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);

    server = createTestServer();
    const port = await listenOnFreePort(server);
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("POST /api/pages creates an authed page by default and returns {id, version}", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Hello",
        contentType: "text/html",
        body: "<h1>hi</h1>",
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; version: number };
    expect(json.id).toMatch(/^[0-9a-f]{32}$/);
    expect(json.version).toBe(1);

    // Round-trip via GET
    const got = await fetch(`${baseUrl}/api/pages/${json.id}`, { headers });
    expect(got.status).toBe(200);
    const page = (await got.json()) as Page;
    expect(page.title).toBe("Hello");
    expect(page.body).toBe("<h1>hi</h1>");
    expect(page.agentId).toBe(agentId);
    expect(page.slug).toBe("hello"); // auto-slug from title
    expect(page.contentType).toBe("text/html");
    expect(page.authMode).toBe("authed");
  });

  test("POST /api/pages can explicitly opt in to public auth", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Public",
        contentType: "text/html",
        authMode: "public",
        body: "<h1>public</h1>",
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const got = await fetch(`${baseUrl}/api/pages/${json.id}`, { headers });
    const page = (await got.json()) as Page;
    expect(page.authMode).toBe("public");
  });

  test("POST /api/pages with full HTML document body is stored verbatim", async () => {
    const fullDoc =
      "<!doctype html><html><head><title>x</title></head><body><h1>hi</h1></body></html>";
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "full-doc",
        title: "Full Doc",
        contentType: "text/html",
        authMode: "public",
        body: fullDoc,
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers });
    const page = (await got.json()) as Page;
    expect(page.body).toBe(fullDoc);
  });

  test("POST /api/pages with password hashes the password", async () => {
    const password = "example-open-sesame-9";
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "pw-page",
        title: "Pw",
        contentType: "text/html",
        authMode: "password",
        password,
        body: "<h1>secret</h1>",
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers });
    const page = (await got.json()) as Page;
    expect(page.passwordHash).toBeDefined();
    expect(page.passwordHash).not.toBe(password);
    expect(await Bun.password.verify(password, page.passwordHash!)).toBe(true);
  });

  test("POST /api/pages with duplicate slug → 409", async () => {
    const body = {
      slug: "dup-slug",
      title: "First",
      contentType: "text/html" as const,
      authMode: "public" as const,
      body: "<h1>1</h1>",
    };
    const first = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(409);
  });

  test("POST /api/pages without X-Agent-ID → 400", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Anonymous",
        contentType: "text/html",
        authMode: "public",
        body: "<h1>hi</h1>",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/pages with bad contentType → 400", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Bad",
        contentType: "image/png",
        authMode: "public",
        body: "x",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/pages/:id → 404 for unknown id", async () => {
    const res = await fetch(`${baseUrl}/api/pages/${"0".repeat(32)}`, { headers });
    expect(res.status).toBe(404);
  });

  // Regression coverage for CWE-639 (high-70bc9231): GET/PUT/DELETE
  // /api/pages/:id used to call getPage(id) and return/modify/delete it
  // without ever comparing the caller's agent to page.agentId — so any
  // agent-authenticated caller could read, overwrite, or delete another
  // agent's page (including password-protected bodies/hashes).
  describe("object-level authorization across agents", () => {
    const ownerId = crypto.randomUUID();
    const attackerId = crypto.randomUUID();
    const ownerHeaders = { "Content-Type": "application/json", "X-Agent-ID": ownerId };
    const attackerHeaders = { "Content-Type": "application/json", "X-Agent-ID": attackerId };

    async function createOwnedPage(): Promise<string> {
      const res = await fetch(`${baseUrl}/api/pages`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          slug: `owned-${crypto.randomUUID().slice(0, 8)}`,
          title: "Owner's page",
          contentType: "text/html",
          authMode: "authed",
          body: "<h1>owner only</h1>",
        }),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      return id;
    }

    // Must-reject: cross-agent read.
    test("GET as a different agent → 403", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}`, { headers: attackerHeaders });
      expect(res.status).toBe(403);
    });

    // Must-reject: cross-agent overwrite (would also enable stored XSS via a
    // tampered body per the finding's impact).
    test("PUT as a different agent → 403, page left untouched", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}`, {
        method: "PUT",
        headers: attackerHeaders,
        body: JSON.stringify({ body: "<script>pwned</script>" }),
      });
      expect(res.status).toBe(403);

      const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers: ownerHeaders });
      const page = (await got.json()) as Page;
      expect(page.body).toBe("<h1>owner only</h1>");
    });

    // Must-reject: cross-agent delete.
    test("DELETE as a different agent → 403, page still exists", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}`, {
        method: "DELETE",
        headers: attackerHeaders,
      });
      expect(res.status).toBe(403);

      const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers: ownerHeaders });
      expect(got.status).toBe(200);
    });

    // Must-reject: cross-agent version-history read (same info-disclosure
    // class as GET — sibling code path fixed alongside the headline finding).
    test("GET /versions as a different agent → 403", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}/versions`, {
        headers: attackerHeaders,
      });
      expect(res.status).toBe(403);
    });

    // Positive path: the owning agent keeps full read/write/delete access.
    test("owner retains GET/PUT/DELETE access to its own page", async () => {
      const id = await createOwnedPage();

      const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers: ownerHeaders });
      expect(got.status).toBe(200);

      const put = await fetch(`${baseUrl}/api/pages/${id}`, {
        method: "PUT",
        headers: ownerHeaders,
        body: JSON.stringify({ title: "Updated by owner" }),
      });
      expect(put.status).toBe(200);

      const del = await fetch(`${baseUrl}/api/pages/${id}`, {
        method: "DELETE",
        headers: ownerHeaders,
      });
      expect(del.status).toBe(204);
    });

    // Positive path: operator/dashboard callers (no X-Agent-ID) keep full
    // access, matching the existing convention in src/http/tasks.ts.
    test("operator caller (no X-Agent-ID) can still read/write any page", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}`, {
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("design fields (theme, themeTokens, designVersion)", () => {
    const shadcnTokens = {
      light: {
        "--primary": "oklch(0.55 0.2 260)",
        background: "oklch(1 0 0)",
        radius: "0.5rem",
        "--sidebar": "oklch(0.9 0 0)",
      },
      dark: { "--primary": "oklch(0.7 0.15 260)" },
    };
    const normalizedShadcnTokens = {
      light: {
        "--color-primary": "oklch(0.55 0.2 260)",
        "--color-background": "oklch(1 0 0)",
        "--radius-sm": "calc(0.5rem - 4px)",
        "--radius-md": "calc(0.5rem - 2px)",
        "--radius-lg": "0.5rem",
        "--radius-xl": "calc(0.5rem + 4px)",
      },
      dark: { "--color-primary": "oklch(0.7 0.15 260)" },
    };

    function postDesignPage(extra: Record<string, unknown> = {}) {
      return fetch(`${baseUrl}/api/pages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: `design-${crypto.randomUUID().slice(0, 8)}`,
          title: "Design page",
          contentType: "text/html",
          authMode: "public",
          body: "<h1>hi</h1>",
          ...extra,
        }),
      });
    }

    function putPage(id: string, body: Record<string, unknown>) {
      return fetch(`${baseUrl}/api/pages/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
    }

    async function getDesignPage(id: string): Promise<Page> {
      const res = await fetch(`${baseUrl}/api/pages/${id}`, { headers });
      expect(res.status).toBe(200);
      return (await res.json()) as Page;
    }

    async function versionCount(id: string): Promise<number> {
      const res = await fetch(`${baseUrl}/api/pages/${id}/versions`, { headers });
      return ((await res.json()) as { versions: unknown[] }).versions.length;
    }

    test("a new page gets design version 2 with no theme and no tokens", async () => {
      const res = await postDesignPage();
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        id: string;
        ignoredTokens?: string[];
        designVersion?: number;
      };
      expect(created.ignoredTokens).toBeUndefined();
      expect(created.designVersion).toBe(2);

      const page = await getDesignPage(created.id);
      expect(page.designVersion).toBe(2);
      expect(page.theme).toBeNull();
      expect(page.themeTokens).toBeNull();
    });

    test("POST stores a preset theme and an explicit design version", async () => {
      const res = await postDesignPage({ theme: "paper", designVersion: 1 });
      expect(res.status).toBe(201);
      const { id, designVersion } = (await res.json()) as { id: string; designVersion?: number };
      expect(designVersion).toBe(1);
      const page = await getDesignPage(id);
      expect(page.theme).toBe("paper");
      expect(page.designVersion).toBe(1);
    });

    test("POST with a design version other than 1 or 2 → 400", async () => {
      for (const designVersion of [0, 3, "2", null]) {
        const res = await postDesignPage({ designVersion });
        expect(res.status).toBe(400);
      }
    });

    test("POST with an unknown theme → 400 that lists the presets, and no page is created", async () => {
      const slug = `unknown-theme-${crypto.randomUUID().slice(0, 8)}`;
      const res = await postDesignPage({ slug, theme: "neon" });
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain('Unknown theme "neon"');
      for (const id of ["hive", "paper", "github"]) expect(error).toContain(id);

      const resolved = await fetch(`${baseUrl}/api/pages/resolve?slug=${slug}&agentId=${agentId}`, {
        headers,
      });
      expect(resolved.status).toBe(404);
    });

    test("POST stores shadcn-style tokens normalized and reports the ignored names", async () => {
      const res = await postDesignPage({ themeTokens: shadcnTokens });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; ignoredTokens?: string[] };
      expect(created.ignoredTokens).toEqual(["--sidebar"]);

      const page = await getDesignPage(created.id);
      expect(page.themeTokens).toEqual(normalizedShadcnTokens);
    });

    test("POST accepts the css format", async () => {
      const css = `
        :root { --primary: 222.2 47.4% 11.2%; --radius: 0.625rem; --shadow-2xs: 0 1px 2px #0000; }
        .dark { --primary: 210 40% 98%; --sidebar-primary: red; }
      `;
      const res = await postDesignPage({ themeTokens: { format: "css", css } });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; ignoredTokens?: string[] };
      expect([...(created.ignoredTokens ?? [])].sort()).toEqual([
        "--shadow-2xs",
        "--sidebar-primary",
      ]);

      const page = await getDesignPage(created.id);
      expect(page.themeTokens).toEqual({
        light: {
          "--color-primary": "hsl(222.2 47.4% 11.2%)",
          "--radius-sm": "calc(0.625rem - 4px)",
          "--radius-md": "calc(0.625rem - 2px)",
          "--radius-lg": "0.625rem",
          "--radius-xl": "calc(0.625rem + 4px)",
        },
        dark: { "--color-primary": "hsl(210 40% 98%)" },
      });
    });

    test("POST with bad themeTokens → 400 that names the problem", async () => {
      const unsafe = await postDesignPage({
        themeTokens: { light: { "--color-primary": "red; } body { display: none" } },
      });
      expect(unsafe.status).toBe(400);
      const unsafeError = ((await unsafe.json()) as { error: string }).error;
      expect(unsafeError).toContain("Invalid themeTokens");
      expect(unsafeError).toContain("--color-primary");

      const missingCss = await postDesignPage({ themeTokens: { format: "css" } });
      expect(missingCss.status).toBe(400);
      expect(((await missingCss.json()) as { error: string }).error).toContain(
        "Invalid themeTokens",
      );

      const noBlocks = await postDesignPage({ themeTokens: { format: "css", css: "body { }" } });
      expect(noBlocks.status).toBe(400);
      expect(((await noBlocks.json()) as { error: string }).error).toContain(
        "no :root, .dark, or @theme block",
      );
    });

    test("POST with an unknown themeTokens format or field → 400", async () => {
      const format = await postDesignPage({ themeTokens: { format: "dtcg", light: {} } });
      expect(format.status).toBe(400);
      expect(((await format.json()) as { error: string }).error).toContain("themeTokens");

      const field = await postDesignPage({ themeTokens: { lite: { "--color-primary": "red" } } });
      expect(field.status).toBe(400);
      expect(((await field.json()) as { error: string }).error).toContain("themeTokens");
    });

    test("PUT keeps the design fields it does not mention", async () => {
      const created = await postDesignPage({ theme: "paper", themeTokens: shadcnTokens });
      const { id } = (await created.json()) as { id: string };

      const res = await putPage(id, { body: "<h1>v2</h1>" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { designVersion?: number }).designVersion).toBe(2);
      const page = await getDesignPage(id);
      expect(page.body).toBe("<h1>v2</h1>");
      expect(page.theme).toBe("paper");
      expect(page.themeTokens).toEqual(normalizedShadcnTokens);
      expect(page.designVersion).toBe(2);
    });

    test("PUT sets a new theme, replaces the tokens, and moves the design version", async () => {
      const created = await postDesignPage({ designVersion: 1, themeTokens: shadcnTokens });
      const { id } = (await created.json()) as { id: string };

      const res = await putPage(id, {
        theme: "github",
        designVersion: 2,
        themeTokens: { light: { "--color-ring": "oklch(0.6 0.2 30)", "--spacing": "4px" } },
      });
      expect(res.status).toBe(200);
      const updated = (await res.json()) as { ignoredTokens?: string[]; designVersion?: number };
      expect(updated.ignoredTokens).toEqual(["--spacing"]);
      expect(updated.designVersion).toBe(2);

      const page = await getDesignPage(id);
      expect(page.theme).toBe("github");
      expect(page.designVersion).toBe(2);
      // The new tokens replace the old set, they do not merge into it.
      expect(page.themeTokens).toEqual({
        light: { "--color-ring": "oklch(0.6 0.2 30)" },
        dark: {},
      });
    });

    test("PUT reports the design version the page keeps", async () => {
      const created = await postDesignPage({ designVersion: 1 });
      const { id } = (await created.json()) as { id: string };
      const res = await putPage(id, { body: '<main class="swarm-page">v2</main>' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { designVersion?: number }).designVersion).toBe(1);
    });

    test("POST reports a reference outside the contract with the reference", async () => {
      const res = await postDesignPage({
        themeTokens: {
          format: "css",
          css: ":root { --font-sans: var(--font-geist-sans); --primary: red; } body { --ring: blue; }",
        },
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { ignoredTokens?: string[] };
      expect(created.ignoredTokens).toEqual([
        "--font-sans (references --font-geist-sans)",
        "--ring (in body)",
      ]);
    });

    test("PUT with null clears the theme and the tokens", async () => {
      const created = await postDesignPage({ theme: "paper", themeTokens: shadcnTokens });
      const { id } = (await created.json()) as { id: string };

      const res = await putPage(id, { theme: null, themeTokens: null });
      expect(res.status).toBe(200);
      const page = await getDesignPage(id);
      expect(page.theme).toBeNull();
      expect(page.themeTokens).toBeNull();
      expect(page.designVersion).toBe(2);
    });

    test("PUT with a bad theme or bad tokens → 400, and the page and its history stay as they were", async () => {
      const created = await postDesignPage({ theme: "paper" });
      const { id } = (await created.json()) as { id: string };

      const badTheme = await putPage(id, { theme: "neon", body: "<h1>changed</h1>" });
      expect(badTheme.status).toBe(400);
      expect(((await badTheme.json()) as { error: string }).error).toContain(
        'Unknown theme "neon"',
      );

      const badTokens = await putPage(id, {
        themeTokens: { light: { "--color-primary": "url(https://example.test/x)" } },
        body: "<h1>changed</h1>",
      });
      expect(badTokens.status).toBe(400);
      expect(((await badTokens.json()) as { error: string }).error).toContain(
        "Invalid themeTokens",
      );

      const page = await getDesignPage(id);
      expect(page.body).toBe("<h1>hi</h1>");
      expect(page.theme).toBe("paper");
      expect(await versionCount(id)).toBe(0);
    });

    test("PUT with a design version other than 1 or 2 → 400", async () => {
      const created = await postDesignPage();
      const { id } = (await created.json()) as { id: string };
      const res = await putPage(id, { designVersion: 3 });
      expect(res.status).toBe(400);
    });

    test("GET resolve returns the design fields", async () => {
      const slug = `resolve-${crypto.randomUUID().slice(0, 8)}`;
      const created = await postDesignPage({ slug, theme: "paper", designVersion: 1 });
      expect(created.status).toBe(201);
      const res = await fetch(`${baseUrl}/api/pages/resolve?slug=${slug}&agentId=${agentId}`, {
        headers,
      });
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page;
      expect(page.theme).toBe("paper");
      expect(page.designVersion).toBe(1);
      expect(page.themeTokens).toBeNull();
    });

    test("the list leaves the design fields out unless fields=full", async () => {
      const ownerId = crypto.randomUUID();
      const ownerHeaders = { "Content-Type": "application/json", "X-Agent-ID": ownerId };
      const created = await fetch(`${baseUrl}/api/pages`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          slug: "listed",
          title: "Listed",
          contentType: "text/html",
          authMode: "public",
          body: "<h1>hi</h1>",
          theme: "paper",
          themeTokens: shadcnTokens,
        }),
      });
      expect(created.status).toBe(201);

      const slimRes = await fetch(`${baseUrl}/api/pages?agentId=${ownerId}`, {
        headers: ownerHeaders,
      });
      expect(slimRes.status).toBe(200);
      const [slim] = ((await slimRes.json()) as { pages: Array<Record<string, unknown>> }).pages;
      expect(slim?.slug).toBe("listed");
      for (const field of ["body", "theme", "themeTokens", "designVersion"]) {
        expect(field in slim!).toBe(false);
      }

      const fullRes = await fetch(`${baseUrl}/api/pages?agentId=${ownerId}&fields=full`, {
        headers: ownerHeaders,
      });
      expect(fullRes.status).toBe(200);
      const [full] = ((await fullRes.json()) as { pages: Page[] }).pages;
      expect(full?.theme).toBe("paper");
      expect(full?.themeTokens).toEqual(normalizedShadcnTokens);
      expect(full?.designVersion).toBe(2);
    });
  });
});
