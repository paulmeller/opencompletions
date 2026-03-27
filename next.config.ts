import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  allowedDevOrigins: [
    process.env.REPLIT_DEV_DOMAIN || "",
    "*.riker.replit.dev",
    "*.replit.dev",
  ].filter(Boolean),
};

export default nextConfig;
