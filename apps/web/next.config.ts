import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["three", "@react-three/fiber", "shadergradient"],
  async rewrites() {
    // The live demo is a static page (public/demo/index.html) served at /demo, so the root
    // layout's Navbar / ShaderBackground never wrap it.
    return [{ source: "/demo", destination: "/demo/index.html" }];
  },
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
};

export default nextConfig;
