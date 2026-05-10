import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/inventory/logs/recent",
        destination: "/api/inventory/logs?mode=recent",
      },
      {
        source: "/api/inventory/snapshot/latest",
        destination: "/api/inventory/snapshot?mode=latest",
      },
      {
        source: "/api/inventory/snapshot/list",
        destination: "/api/inventory/snapshot?mode=list",
      },
    ];
  },
};

export default nextConfig;
