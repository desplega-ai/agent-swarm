import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  clearLinkPreviewCache,
  getLinkPreview,
  LinkPreviewRefusedError,
  parseOpenGraph,
} from "../be/link-preview";

const PUBLIC = async () => ["93.184.216.34"];

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

const PAGE = `<html><head>
<title>Fallback title</title>
<meta content="PR title &amp; more" property="og:title">
<meta property='og:description' content='A short description'>
<meta property="og:image" content="/og.png">
<meta property="og:site_name" content="GitHub">
</head></html>`;

beforeEach(() => clearLinkPreviewCache());

describe("parseOpenGraph", () => {
  test("reads og tags in any attribute order and resolves a relative image", () => {
    expect(parseOpenGraph(PAGE, "https://github.com/o/r/pull/1")).toEqual({
      title: "PR title & more",
      description: "A short description",
      image: "https://github.com/og.png",
      siteName: "GitHub",
    });
  });

  test("falls back to <title> and meta description, drops a non-http image", () => {
    const parsed = parseOpenGraph(
      `<title> Plain  page </title><meta name="description" content="Desc"><meta property="og:image" content="javascript:alert(1)">`,
      "https://example.com/",
    );
    expect(parsed).toEqual({
      title: "Plain page",
      description: "Desc",
      image: null,
      siteName: null,
    });
  });
});

describe("getLinkPreview", () => {
  test("returns the parsed preview and caches it", async () => {
    const fetchMock = mock(async () => html(PAGE));
    const deps = { fetch: fetchMock as unknown as typeof fetch, resolve: PUBLIC };
    const first = await getLinkPreview("https://example.com/a#frag", deps);
    expect(first).toMatchObject({
      ok: true,
      title: "PR title & more",
      url: "https://example.com/a",
    });
    await getLinkPreview("https://example.com/a", deps);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a network failure reads ok:false, not an error", async () => {
    const deps = {
      fetch: (async () => {
        throw new TypeError("connection reset");
      }) as unknown as typeof fetch,
      resolve: PUBLIC,
    };
    expect(await getLinkPreview("https://example.com/down", deps)).toMatchObject({
      ok: false,
      title: null,
      image: null,
    });
  });

  test("an HTTP error or a non-HTML body reads ok:false", async () => {
    const notFound = {
      fetch: (async () => html("nope", { status: 404 })) as unknown as typeof fetch,
      resolve: PUBLIC,
    };
    expect((await getLinkPreview("https://example.com/404", notFound)).ok).toBe(false);
    const pdf = {
      fetch: (async () =>
        new Response("%PDF", {
          headers: { "content-type": "application/pdf" },
        })) as unknown as typeof fetch,
      resolve: PUBLIC,
    };
    expect((await getLinkPreview("https://example.com/file.pdf", pdf)).ok).toBe(false);
  });

  test("refuses loopback, private and metadata literals without fetching", async () => {
    const fetchMock = mock(async () => html(PAGE));
    for (const url of [
      "http://127.0.0.1/",
      "http://localhost:3013/health",
      "http://10.1.2.3/",
      "http://192.168.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "ftp://example.com/",
    ]) {
      await expect(
        getLinkPreview(url, { fetch: fetchMock as unknown as typeof fetch, resolve: PUBLIC }),
      ).rejects.toBeInstanceOf(LinkPreviewRefusedError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses a public name that resolves to a private address", async () => {
    const fetchMock = mock(async () => html(PAGE));
    await expect(
      getLinkPreview("https://rebind.example.com/", {
        fetch: fetchMock as unknown as typeof fetch,
        resolve: async () => ["10.0.0.5"],
      }),
    ).rejects.toBeInstanceOf(LinkPreviewRefusedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses a redirect to a loopback host", async () => {
    const fetchMock = mock(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3013/" } }),
    );
    await expect(
      getLinkPreview("https://example.com/redirect", {
        fetch: fetchMock as unknown as typeof fetch,
        resolve: PUBLIC,
      }),
    ).rejects.toBeInstanceOf(LinkPreviewRefusedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
