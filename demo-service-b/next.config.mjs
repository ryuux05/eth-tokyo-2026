import { fileURLToPath } from "node:url";

export default {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: { externalDir: true },
  outputFileTracingRoot: fileURLToPath(new URL("../", import.meta.url)),
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  async rewrites() {
    return ["health", "activity", "owner/status", "owner/challenge", "owner/register", "owner/workspace", "owner/permissions", "agent/lookup", "private/report"].map(path => ({ source: `/${path}`, destination: `/api/${path}` }));
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ] }];
  },
};
