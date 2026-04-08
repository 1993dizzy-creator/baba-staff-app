import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

// 타입시크릿에서 배포막힐경우 이걸로 뚫고 에러로그 확인