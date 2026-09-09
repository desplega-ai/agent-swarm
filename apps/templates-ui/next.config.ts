import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel's adapter owns deployment output and does not emit standalone traces.
  output: process.env.VERCEL === "1" ? undefined : "standalone",
};

export default nextConfig;
