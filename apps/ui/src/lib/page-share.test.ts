import { describe, expect, test } from "bun:test";
import ogHandler from "../../api/og";
import vercelConfig from "../../vercel.json";
import {
  buildPageShareHtml,
  fetchPageShareInfo,
  isPageId,
  pageCardUrl,
  parseOgParams,
  resolveShareApiUrl,
} from "./page-share";

const PAGE_ID = "f675b80e6c24486daba80d47e71b6b41";
const API = "https://api.example.com";

function meta(html: string, key: string): string | null {
  const m = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html);
  return m ? (m[1] ?? null) : null;
}

/** A fetch stub that answers `/p/:id/og` for one public page. */
function apiStub(calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === `${API}/p/${PAGE_ID}/og`) {
      return Response.json({
        id: PAGE_ID,
        title: "Helmcode × Agent Swarm: model benchmark",
        description: "Open models on 14 tasks.",
      });
    }
    return Response.json({ error: "Page not found" }, { status: 404 });
  }) as typeof fetch;
}

describe("resolveShareApiUrl", () => {
  test("prefers SWARM_API_URL, falls back to VITE_API_URL, rejects non-URLs", () => {
    expect(
      resolveShareApiUrl({ SWARM_API_URL: "https://a.dev/", VITE_API_URL: "https://b.dev" }),
    ).toBe("https://a.dev");
    expect(resolveShareApiUrl({ VITE_API_URL: " https://b.dev/base/ " })).toBe(
      "https://b.dev/base",
    );
    expect(resolveShareApiUrl({ SWARM_API_URL: "not a url", VITE_API_URL: "" })).toBeNull();
    expect(resolveShareApiUrl({ SWARM_API_URL: "javascript:alert(1)" })).toBeNull();
    expect(resolveShareApiUrl({})).toBeNull();
  });
});

describe("fetchPageShareInfo", () => {
  test("returns title and description for a public page", async () => {
    expect(await fetchPageShareInfo(API, PAGE_ID, { fetchImpl: apiStub() })).toEqual({
      title: "Helmcode × Agent Swarm: model benchmark",
      description: "Open models on 14 tasks.",
    });
  });

  test("a 404, a bad body, a thrown fetch or a bad id is a miss", async () => {
    expect(await fetchPageShareInfo(API, "other", { fetchImpl: apiStub() })).toBeNull();
    const bad = (async () => Response.json({ title: 3 })) as unknown as typeof fetch;
    expect(await fetchPageShareInfo(API, PAGE_ID, { fetchImpl: bad })).toBeNull();
    const boom = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await fetchPageShareInfo(API, PAGE_ID, { fetchImpl: boom })).toBeNull();
    const calls: string[] = [];
    expect(await fetchPageShareInfo(API, "../api/pages", { fetchImpl: apiStub(calls) })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a slow API times out into a miss", async () => {
    const slow = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(await fetchPageShareInfo(API, PAGE_ID, { fetchImpl: slow, timeoutMs: 20 })).toBeNull();
  });
});

describe("buildPageShareHtml", () => {
  test("a public page gets its own title, description and card", async () => {
    const { html, matched } = await buildPageShareHtml({
      origin: "https://app.example.com",
      id: PAGE_ID,
      apiUrl: API,
      fetchImpl: apiStub(),
    });
    expect(matched).toBe(true);
    expect(meta(html, "og:title")).toBe("Helmcode × Agent Swarm: model benchmark");
    expect(meta(html, "og:description")).toBe("Open models on 14 tasks.");
    expect(meta(html, "og:url")).toBe(`https://app.example.com/pages/${PAGE_ID}`);
    expect(meta(html, "twitter:card")).toBe("summary_large_image");
    const image = new URL((meta(html, "og:image") ?? "").replace(/&amp;/g, "&"));
    expect(image.origin + image.pathname).toBe("https://app.example.com/api/og");
    expect(image.searchParams.get("title")).toBe("Helmcode × Agent Swarm: model benchmark");
    expect(image.searchParams.get("subtitle")).toBe("Open models on 14 tasks.");
  });

  test("a private or unknown page, or no API, gets the generic card", async () => {
    for (const [id, apiUrl] of [
      ["0123456789abcdef", API],
      [PAGE_ID, null],
      [null, API],
    ] as const) {
      const { html, matched } = await buildPageShareHtml({
        origin: "https://app.example.com",
        id,
        apiUrl,
        fetchImpl: apiStub(),
      });
      expect(matched).toBe(false);
      expect(meta(html, "og:title")).toBe("Agent Swarm Dashboard");
      expect(meta(html, "og:image")).toBe("https://app.example.com/og-image.png");
    }
  });

  test("titles are escaped", async () => {
    const evil = (async () =>
      Response.json({
        title: `"><script>x</script>`,
        description: null,
      })) as unknown as typeof fetch;
    const { html } = await buildPageShareHtml({
      origin: "https://a.dev",
      id: PAGE_ID,
      apiUrl: API,
      fetchImpl: evil,
    });
    expect(html).not.toContain("<script>");
    expect(meta(html, "og:title")).toBe("&quot;&gt;&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("card text", () => {
  test("accent is the phrase after a linking word, else the last third", () => {
    const linked = parseOgParams(new URLSearchParams({ title: "Agents that ship code" }));
    expect(linked.accent).toEqual(["ship", "code"]);
    const plain = parseOgParams(
      new URLSearchParams({ title: "Helmcode × Agent Swarm: model benchmark" }),
    );
    expect(plain.accent).toEqual(["model", "benchmark"]);
    expect(parseOgParams(new URLSearchParams({ description: "d" })).subtitle).toBe("d");
    expect(parseOgParams(new URLSearchParams()).title).toBe("Agent Swarm");
  });

  test("card URLs clip long text", () => {
    const url = new URL(pageCardUrl("https://a.dev/", "t ".repeat(200), "d ".repeat(200)));
    expect((url.searchParams.get("title") ?? "").length).toBeLessThanOrEqual(121);
    expect((url.searchParams.get("subtitle") ?? "").length).toBeLessThanOrEqual(161);
  });

  test("/api/og renders a 1200x630 PNG", async () => {
    const res = await ogHandler(
      new Request("https://a.dev/api/og?title=Helmcode%20%C3%97%20Agent%20Swarm&subtitle=x"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = new DataView(await res.arrayBuffer());
    expect(png.getUint32(0)).toBe(0x89504e47);
    expect([png.getUint32(16), png.getUint32(20)]).toEqual([1200, 630]);
  }, 30_000);
});

describe("vercel.json crawler rewrite", () => {
  const rewrites = vercelConfig.rewrites as {
    source: string;
    destination: string;
    has?: { type: string; key: string; value: string }[];
  }[];
  const bot = rewrites.find((r) => r.destination.startsWith("/api/page-share"));
  const botUa = new RegExp(`^${bot?.has?.[0]?.value ?? "$^"}$`);

  test("comes before the SPA catch-all, which leaves /api alone", () => {
    expect(bot).toBeDefined();
    const spa = rewrites.findIndex((r) => r.destination === "/index.html");
    expect(rewrites.indexOf(bot!)).toBeLessThan(spa);
    const catchAll = new RegExp(`^${rewrites[spa]!.source}$`);
    expect(catchAll.test("/pages/x")).toBe(true);
    expect(catchAll.test("/api/og")).toBe(false);
    expect(catchAll.test("/assets/x.js")).toBe(false);
  });

  test("matches link-preview crawlers and not browsers", () => {
    for (const ua of [
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "Twitterbot/1.0",
      "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "WhatsApp/2.23.20.0",
      "TelegramBot (like TwitterBot)",
    ]) {
      expect(botUa.test(ua)).toBe(true);
    }
    expect(
      botUa.test(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(isPageId(PAGE_ID)).toBe(true);
  });
});
