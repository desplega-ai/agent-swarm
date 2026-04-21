import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "blob.imference.com",
      },
    ],
  },
  // Advertise Accept-based content negotiation on every route so CDNs (Vercel
  // Edge included) cache the HTML and markdown variants separately. The
  // proxy.ts middleware appends `Accept` to its own responses, but Next.js
  // sets its own Vary on prerendered HTML routes and discards anything
  // middleware appended — declaring it here ensures every response advertises
  // it consistently.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Vary", value: "Accept" }],
      },
    ];
  },
};

export default nextConfig;
