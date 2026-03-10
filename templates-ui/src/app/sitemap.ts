import type { MetadataRoute } from "next";
import { getAllTemplates } from "@/lib/templates";

const siteUrl = "https://templates.agent-swarm.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  const templates = getAllTemplates();

  const templatePages: MetadataRoute.Sitemap = templates.map((t) => ({
    url: `${siteUrl}/${t.category}/${t.name}`,
    lastModified: t.lastUpdatedAt ? new Date(t.lastUpdatedAt) : new Date(),
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [
    {
      url: siteUrl,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/builder`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    ...templatePages,
  ];
}
