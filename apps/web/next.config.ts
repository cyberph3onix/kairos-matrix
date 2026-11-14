import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["three", "@react-three/fiber", "shadergradient"],
  async redirects() {
    return [{ source: "/app", destination: "/demo", permanent: false }];
  },
  async rewrites() {
    // The live demo is a static page (public/demo/index.html) served at /demo, so the root
    // layout's Navbar / ShaderBackground never wrap it.
    const backend = process.env.AGENTS_BACKEND_URL || process.env.NEXT_PUBLIC_AGENTS_BACKEND_URL || "http://localhost:4001";
    return [
      { source: "/demo", destination: "/demo/index.html" },
      // Public paper/testnet demo of the real pipeline (SSE at /api/pipeline/run) lives on the backend.
      { source: "/api/pipeline/:path*", destination: `${backend}/api/pipeline/:path*` },
    ];
  },
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
};

export default nextConfig;
