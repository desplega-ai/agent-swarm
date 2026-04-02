import type { MetadataRoute } from "next";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const baseUrl = "https://agent-swarm.dev";

/** Routes with custom priority overrides (key conversion pages, etc.) */
const priorityOverrides: Record<string, number> = {
  "/pricing": 0.9,
};

/**
 * Extract datePublished from a blog post's JSON-LD structured data.
 * Returns undefined if not found.
 */
function extractPublishedDate(pageDir: string): Date | undefined {
  for (const name of ["page.tsx", "page.ts"]) {
    try {
      const content = readFileSync(join(pageDir, name), "utf-8");
      const match = content.match(/datePublished:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/);
      if (match) return new Date(match[1]);
    } catch {
      // file doesn't exist, try next
    }
  }
  return undefined;
}

/**
 * Recursively find all page.tsx files in the app directory
 * and derive their routes. Skips route groups, dynamic segments,
 * private folders, and API routes.
 */
function discoverRoutes(
  dir: string,
  appDir: string,
): { route: string; dir: string }[] {
  const routes: { route: string; dir: string }[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Skip private folders, api routes, dynamic segments, and route groups
      if (
        entry.startsWith("_") ||
        entry === "api" ||
        entry.startsWith("[")
      ) {
        continue;
      }
      // For route groups like (marketing), recurse but don't add as a route segment
      if (entry.startsWith("(")) {
        routes.push(...discoverRoutes(fullPath, appDir));
        continue;
      }
      routes.push(...discoverRoutes(fullPath, appDir));
    } else if (entry === "page.tsx" || entry === "page.ts") {
      const relativePath = relative(appDir, dir);
      const route = relativePath === "" ? "/" : `/${relativePath}`;
      routes.push({ route, dir });
    }
  }

  return routes;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const appDir = join(process.cwd(), "src/app");
  const routes = discoverRoutes(appDir, appDir);

  return routes.map(({ route, dir: pageDir }) => {
    const isBlogPost = route.startsWith("/blog/") && route !== "/blog";
    const isHome = route === "/";
    const depth = route.split("/").filter(Boolean).length;

    const lastModified = isBlogPost
      ? (extractPublishedDate(pageDir) ?? new Date())
      : new Date();

    const priority =
      priorityOverrides[route] ??
      (isHome ? 1 : isBlogPost ? 0.7 : depth <= 1 ? 0.8 : 0.6);

    return {
      url: `${baseUrl}${route === "/" ? "" : route}`,
      lastModified,
      changeFrequency: isBlogPost ? "monthly" : "weekly",
      priority,
    };
  });
}
