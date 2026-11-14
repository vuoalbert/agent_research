import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local preview aliases only; keep dev-only assets available when a review
  // opens the same server through either hostname.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  // pin the workspace root: a stray package-lock.json one level up otherwise
  // makes Turbopack infer the wrong root and warn on every build
  turbopack: { root: __dirname },
  // the dev-mode badge paints over the bottom-left of the viewport
  devIndicators: false,
  // the AI app moved from /ai to /; keep old links working
  async redirects() {
    return [{ source: "/ai", destination: "/", permanent: false }];
  },
};

export default nextConfig;
