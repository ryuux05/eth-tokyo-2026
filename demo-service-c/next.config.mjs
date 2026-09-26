import { fileURLToPath } from "node:url";
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: { externalDir: true },
  outputFileTracingRoot: fileURLToPath(new URL("../", import.meta.url)),
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  async rewrites() {
    return ["config", "health", "activity", "transaction", "policy/preview", "private/quote", "owner/status", "owner/challenge", "owner/register"].map(path => ({
      source: `/${path}`, destination: `/api/${path}`,
    }));
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'` },
    ] }];
  },
};
export default config;
