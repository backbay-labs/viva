import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const staticExport = process.env.VIVA_STATIC_EXPORT === "1";

const sessionReferrerHeaders: Pick<NextConfig, "headers"> = staticExport
  ? {}
  : {
      async headers() {
        return [
          {
            source: "/session",
            headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
          },
        ];
      },
    };

const nextConfig: NextConfig = {
  assetPrefix: staticExport ? "." : undefined,
  ...sessionReferrerHeaders,
  output: staticExport ? "export" : undefined,
  transpilePackages: ["@viva/core", "@viva/tokens", "@viva/ui-web"],
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
