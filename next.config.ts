import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/.well-known/http-message-signatures-directory",
        destination: "/api/wba-directory",
      },
    ];
  },
};

export default nextConfig;
