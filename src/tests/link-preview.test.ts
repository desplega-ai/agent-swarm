import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
afterEach(() => mock.restore());

describe("parseOpenGraph", () => {
  test("reads og tags in any attribute order and resolves a relative image", () => {
    expect(parseOpenGraph(PAGE, "https://github.com/o/r/pull/1")).toEqual({
      title: "PR title & more",
      description: "A short description",
      image: "https://github.com/og.png",
      siteName: "GitHub",
    });
  });

  test("drops an og:image URL longer than 2048 chars instead of caching it", () => {
    const long = `https://cdn.example.com/${"a".repeat(3000)}.png`;
    const parsed = parseOpenGraph(
      `<title>T</title><meta property="og:image" content="${long}">`,
      "https://example.com/",
    );
    expect(parsed.image).toBeNull();
    const ok = parseOpenGraph(
      `<meta property="og:image" content="https://cdn.example.com/og.png">`,
      "https://example.com/",
    );
    expect(ok.image).toBe("https://cdn.example.com/og.png");
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

  test(
    "an endless body stops at the 512 KB cap and still reads the title",
    async () => {
      const chunk = new Uint8Array(64 * 1024).fill(0x20);
      const head = new TextEncoder().encode("<html><head><title>Endless</title></head><body>");
      let pulled = 0;
      let first = true;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          // Endless from the reader's view; a hard stop at 4 MB keeps a broken cap from hanging the run.
          if (pulled >= 4 * 1024 * 1024) return controller.close();
          const next = first ? new Uint8Array([...head, ...chunk.subarray(head.length)]) : chunk;
          first = false;
          pulled += next.byteLength;
          controller.enqueue(next);
        },
      });
      const deps = {
        fetch: (async () => html(body as unknown as string)) as unknown as typeof fetch,
        resolve: PUBLIC,
      };
      const preview = await getLinkPreview("https://example.com/endless", deps);
      expect(preview).toMatchObject({ ok: true, title: "Endless" });
      // The reader stops at the cap: 8 chunks of 64 KB, plus at most the stream's lookahead.
      expect(pulled).toBeGreaterThanOrEqual(512 * 1024);
      expect(pulled).toBeLessThanOrEqual(512 * 1024 + 2 * 64 * 1024);
    },
    { timeout: 5_000 },
  );

  test(
    "the fetch carries the timeout signal: a fired timeout reads ok:false",
    async () => {
      const aborted = new AbortController();
      aborted.abort(new DOMException("timed out", "TimeoutError"));
      const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(aborted.signal);
      const fetchMock = (async (_input: unknown, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) return html(PAGE);
        // Honors the signal like a real fetch: rejects once it aborts, else hangs.
        return await new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }) as unknown as typeof fetch;
      const preview = await getLinkPreview("https://example.com/slow", {
        fetch: fetchMock,
        resolve: PUBLIC,
      });
      expect(timeoutSpy).toHaveBeenCalledWith(5_000);
      expect(preview).toMatchObject({ ok: false, title: null });
    },
    { timeout: 5_000 },
  );
});
