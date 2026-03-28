import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "libsql"],
  async rewrites() {
    return [
      { source: "/docs", destination: "/api/docs" },
    ];
  },
  allowedDevOrigins: [
    process.env.REPLIT_DEV_DOMAIN || "",
    "*.riker.replit.dev",
    "*.replit.dev",
  ].filter(Boolean),
};

export default nextConfig;
