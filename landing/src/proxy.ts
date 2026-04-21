import { type NextRequest, NextResponse } from "next/server";
import {
  MARKDOWN_CONTENT_TYPE,
  MEDIA_MARKDOWN,
  negotiateMedia,
} from "@/lib/content-negotiation";

/**
 * Routes that have a corresponding pre-rendered markdown file under public/md/.
 * The proxy only attempts a markdown rewrite for these paths so that unrelated
 * routes (404 pages, future additions, etc.) return 406 instead of leaking
 * HTML to a client that explicitly asked for markdown.
 */
const MARKDOWN_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/pricing",
  "/blog",
  "/blog/deep-dive-agent-identity-soul-md",
  "/blog/deep-dive-context-compaction-design",
  "/blog/deep-dive-dag-workflow-engine-pause-resume",
  "/blog/deep-dive-prompt-cache-scheduling-dead-zone",
  "/blog/deep-dive-soul-md-identity-stack",
  "/blog/deep-dive-task-state-machine-recovery",
  "/blog/openfort-hackathon",
  "/blog/swarm-metrics",
  "/blog/task-delegation-architecture",
  "/examples",
  "/examples/x402",
]);

/**
 * Files that already contain markdown but are served from /public/ with the
 * wrong static-file Content-Type. The proxy overrides headers to comply with
 * acceptmarkdown.com without changing their URLs.
 */
const LLMS_FILES: ReadonlySet<string> = new Set(["/llms.txt", "/llms-full.txt"]);

function setVary(headers: Headers): void {
  // Use append so we don't clobber Next.js's own Vary entries (rsc,
  // next-router-state-tree, etc.) on prerendered HTML responses. The HTTP
  // spec treats Vary as a comma-separated list of field names.
  headers.append("Vary", "Accept");
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // /llms.txt and /llms-full.txt are inherently markdown — always serve as such.
  if (LLMS_FILES.has(pathname)) {
    const res = NextResponse.next();
    res.headers.set("Content-Type", MARKDOWN_CONTENT_TYPE);
    setVary(res.headers);
    return res;
  }

  const accept = req.headers.get("accept");
  const { chosen } = negotiateMedia(accept);

  if (!chosen) {
    return new NextResponse("Not Acceptable", {
      status: 406,
      headers: { "Content-Type": "text/plain; charset=utf-8", Vary: "Accept" },
    });
  }

  if (chosen === MEDIA_MARKDOWN) {
    // Strip trailing slash, then map "/" → "/index".
    const normalized = pathname.replace(/\/+$/, "") || "/index";

    if (!MARKDOWN_ROUTES.has(normalized === "/index" ? "/" : normalized)) {
      // No markdown representation generated for this route — return 406 rather
      // than serving HTML, since the client explicitly asked for markdown.
      return new NextResponse("Not Acceptable", {
        status: 406,
        headers: { "Content-Type": "text/plain; charset=utf-8", Vary: "Accept" },
      });
    }

    const url = req.nextUrl.clone();
    url.pathname = `/md${normalized}.md`;
    const res = NextResponse.rewrite(url);
    res.headers.set("Content-Type", MARKDOWN_CONTENT_TYPE);
    setVary(res.headers);
    return res;
  }

  // HTML wins — pass through but advertise content negotiation.
  const res = NextResponse.next();
  setVary(res.headers);
  return res;
}

/**
 * Matcher excludes Next internals, API routes, the /md/ directory we serve
 * from, and any path with a static asset extension.
 *
 * /llms.txt and /llms-full.txt intentionally match (they end in .txt but the
 * exclusion regex only matches asset extensions like .png/.css/etc.).
 */
export const config = {
  matcher: [
    "/((?!_next/|api/|md/|favicon\\.ico|.+\\.(?:png|jpg|jpeg|gif|webp|svg|ico|js|mjs|css|map|json|woff|woff2|ttf|eot|md)$).*)",
  ],
};
