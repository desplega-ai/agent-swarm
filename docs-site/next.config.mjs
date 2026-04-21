import { createMDX } from "fumadocs-mdx/next";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  turbopack: {
    root: __dirname,
  },
  async rewrites() {
    return [
      {
        source: "/docs/:path*.mdx",
        destination: "/llms.mdx/docs/:path*",
      },
      {
        source: "/docs/:path*.md",
        destination: "/llms.mdx/docs/:path*",
      },
    ];
  },
  async headers() {
    // acceptmarkdown.com compliance: advertise that /docs/* responses vary on
    // the Accept header so CDNs/caches don't cross-serve HTML vs. markdown.
    // Declared here (not just in proxy.ts) so the header is applied even when
    // Next.js serves a prerendered static HTML response from cache.
    return [
      {
        source: "/docs",
        headers: [{ key: "Vary", value: "Accept" }],
      },
      {
        source: "/docs/:path*",
        headers: [{ key: "Vary", value: "Accept" }],
      },
    ];
  },
};

export default withMDX(config);
