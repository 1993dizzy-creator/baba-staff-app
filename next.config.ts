import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  async headers() {
    return [
      {
        // 01-B push worker: always revalidated so a fixed worker reaches devices promptly.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/attendance/overview",
        destination: "/admin/payroll/attendance",
        permanent: false,
      },
      {
        source: "/attendance/overview/:path*",
        destination: "/admin/payroll/attendance/:path*",
        permanent: false,
      },
    ];
  },
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
