import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    tsconfigPath: "./tsconfig.desktop.json",
  },
};

export default nextConfig;
