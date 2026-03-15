import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "@telegram-apps/bridge": false,
      "@wallet-standard/core": false,
      crypto: false,
    };
    return config;
  },
};

export default nextConfig;
