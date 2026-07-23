import type { NextConfig } from "next";

const githubPages = process.env.GITHUB_PAGES === "true";
const githubBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  ...(githubPages
    ? {
        output: "export",
        trailingSlash: true,
        basePath: githubBasePath,
      }
    : {}),
};

export default nextConfig;
