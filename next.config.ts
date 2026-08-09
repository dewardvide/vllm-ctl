import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — it must never be bundled.
  serverExternalPackages: ["better-sqlite3"],
  // This is a single-user local control plane. Long-lived SSE streams and
  // child-process supervision both depend on one persistent Node process.
  output: "standalone",
  // In development Next serves its chunks only to the host it was reached on.
  // Loopback has two spellings, and reaching the app by the other one would
  // otherwise 403 every client bundle and leave the page dead but rendered.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // The floating dev badge overlaps the bottom-left of dense panels.
  devIndicators: false,
};

export default nextConfig;
