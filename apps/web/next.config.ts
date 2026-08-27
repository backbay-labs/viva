import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/session",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
  transpilePackages: ["@viva/core", "@viva/tokens", "@viva/ui-web"],
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
