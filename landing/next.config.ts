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
};

export default nextConfig;
