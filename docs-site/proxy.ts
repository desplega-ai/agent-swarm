import { NextResponse, type NextRequest } from "next/server";
import { MARKDOWN_CONTENT_TYPE, MEDIA_MARKDOWN, negotiateMedia } from "@/lib/content-negotiation";

export const config = {
  matcher: ["/docs", "/docs/:path*"],
};

export function proxy(req: NextRequest) {
  // Skip RSC / Next internal fetches — the app handler handles them natively.
  if (req.headers.get("rsc") !== null || req.headers.get("next-router-state-tree") !== null) {
    return;
  }

  const pathname = req.nextUrl.pathname;

  // Let next.config.mjs `.md` / `.mdx` rewrites pass through unchanged.
  if (pathname.endsWith(".md") || pathname.endsWith(".mdx")) {
    return;
  }

  const accept = req.headers.get("accept");
  const { chosen } = negotiateMedia(accept);

  if (chosen === null) {
    return new NextResponse("Not Acceptable\n", {
      status: 406,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Vary: "Accept",
      },
    });
  }

  if (chosen === MEDIA_MARKDOWN) {
    const rewritten = req.nextUrl.clone();
    rewritten.pathname = `/llms.mdx${pathname}`;
    const res = NextResponse.rewrite(rewritten);
    res.headers.set("Vary", "Accept");
    res.headers.set("Content-Type", MARKDOWN_CONTENT_TYPE);
    return res;
  }

  // HTML path: best-effort Vary: Accept via both the proxy response headers
  // and next.config.mjs `headers()`. On prerender cache hits, Next may replace
  // Vary with its own RSC variants (vercel/next.js#48480); we rely on Vercel's
  // edge to merge the config-level Vary onto the cached response.
  const res = NextResponse.next();
  res.headers.append("Vary", "Accept");
  return res;
}
