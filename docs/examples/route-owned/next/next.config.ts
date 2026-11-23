import type { NextConfig } from "next";
import { withMicrofrontends } from "@vercel/microfrontends/next/config";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    useTypeScriptCli: true,
  },
  partialPrefetching: true,
  transpilePackages: ["@vercel/microfrontends"],
  async headers() {
    return [
      {
        headers: [{ key: "X-Route-Owned-Example", value: "next" }],
        source: "/:path*",
      },
    ];
  },
};

export default withMicrofrontends(nextConfig);
