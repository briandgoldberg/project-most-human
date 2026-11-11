import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Solana's libraries are large CommonJS packages; load them from node_modules on the server rather than bundling.
  serverExternalPackages: ["@solana/web3.js", "@solana/spl-token"],
};

export default nextConfig;
