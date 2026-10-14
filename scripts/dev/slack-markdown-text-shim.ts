/**
 * Web API shim in front of `@desplega.ai/slack-mock` for Chat SDK tests and
 * local QA.
 *
 * The Chat SDK Slack adapter posts markdown as `markdown_text` (Slack renders
 * it natively). slack-mock 0.4.0 does not know `markdown_text` and answers
 * `no_text`. The shim copies `markdown_text` into `text` when `text` is
 * missing and forwards every request to the mock unchanged otherwise.
 * Socket Mode is not proxied: the mock builds the `apps.connections.open`
 * WebSocket URL from the forwarded Host, which is the mock's own address.
 *
 * Point the API at it with
 * `CHAT_SDK_API_URL_OVERRIDES='{"slack":"http://127.0.0.1:<port>/api/"}'`.
 *
 * Run standalone: `bun scripts/dev/slack-markdown-text-shim.ts <mock api url>`
 * (for example `http://127.0.0.1:4040/api/`; `PORT` picks the listen port,
 * default free). Prints the shim API URL.
 */

export interface SlackMarkdownTextShim {
  /** Base Web API URL to hand to the adapter, ending in `/api/`. */
  apiUrl: string;
  port: number;
  stop: () => Promise<void>;
}

function rewriteBody(contentType: string, body: string): string {
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed.markdown_text === "string" && parsed.text === undefined) {
        return JSON.stringify({ ...parsed, text: parsed.markdown_text });
      }
    } catch {
      // Not JSON after all: forward as-is.
    }
    return body;
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(body);
    const markdown = params.get("markdown_text");
    if (markdown !== null && !params.has("text")) {
      params.set("text", markdown);
      return params.toString();
    }
  }
  return body;
}

export function startSlackMarkdownTextShim(mockApiUrl: string, port = 0): SlackMarkdownTextShim {
  const target = new URL(mockApiUrl);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const forwardUrl = new URL(url.pathname + url.search, target.origin);
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("content-length");
      let body: string | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        body = rewriteBody(headers.get("content-type") ?? "", await req.text());
      }
      const upstream = await fetch(forwardUrl, { method: req.method, headers, body });
      // fetch already decoded the body, so the length and encoding no longer apply.
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    },
  });
  return {
    apiUrl: `http://127.0.0.1:${server.port}/api/`,
    port: server.port ?? 0,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const mockApiUrl = process.argv[2];
  if (!mockApiUrl) {
    console.error("usage: bun scripts/dev/slack-markdown-text-shim.ts <slack-mock api url>");
    process.exit(1);
  }
  const shim = startSlackMarkdownTextShim(mockApiUrl, Number(process.env.PORT ?? 0));
  console.log(shim.apiUrl);
  console.error(`[slack-shim] forwarding ${shim.apiUrl} -> ${mockApiUrl}`);
}
