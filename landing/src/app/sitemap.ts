import type { MetadataRoute } from "next";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const baseUrl = "https://agent-swarm.dev";

/**
 * Recursively find all page.tsx files in the app directory
 * and derive their routes. Skips route groups and dynamic segments.
 */
function discoverRoutes(dir: string, appDir: string): string[] {
  const routes: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Skip private folders, api routes, and route groups
      if (entry.startsWith("_") || entry === "api" || entry.startsWith("(")) {
        // For route groups like (marketing), still recurse into them
        if (entry.startsWith("(")) {
          routes.push(...discoverRoutes(fullPath, appDir));
        }
        continue;
      }
      routes.push(...discoverRoutes(fullPath, appDir));
    } else if (entry === "page.tsx" || entry === "page.ts") {
      const relativePath = relative(appDir, dir);
      const route = relativePath === "" ? "/" : `/${relativePath}`;
      routes.push(route);
    }
  }

  return routes;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const appDir = join(process.cwd(), "src/app");
  const routes = discoverRoutes(appDir, appDir);

  return routes.map((route) => {
    const isBlogPost = route.startsWith("/blog/") && route !== "/blog";
    const isHome = route === "/";
    const depth = route.split("/").filter(Boolean).length;

    return {
      url: `${baseUrl}${route === "/" ? "" : route}`,
      lastModified: new Date(),
      changeFrequency: isBlogPost ? "monthly" : "weekly",
      priority: isHome ? 1 : isBlogPost ? 0.7 : depth <= 1 ? 0.8 : 0.6,
    };
  });
}
