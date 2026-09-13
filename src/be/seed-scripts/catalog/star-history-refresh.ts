import type { ScriptContext } from "swarm-sdk";
import * as z from "zod";
import { renderChart } from "./star-history-renderer";

export const argsSchema = z.object({
  dryRun: z.boolean().default(false),
  authenticated: z.boolean().default(true),
});

const repository = "desplega-ai/agent-swarm";
const namespace = "star-history:desplega-ai/agent-swarm";
const cacheSchema = z.object({
  fetchedAt: z.string(),
  pages: z.array(z.object({ etag: z.string().nullable(), timestamps: z.array(z.number().finite()) })),
});
type Cache = z.infer<typeof cacheSchema>;

/** Refresh the light and dark star-history images, retaining the last-known series on GitHub failure. */
export default async function main(args: z.input<typeof argsSchema>, ctx: ScriptContext) {
  const options = argsSchema.parse(args ?? {});
  const entry = await ctx.swarm.kv_getOrNull({ namespace, key: "series" });
  const parsed = cacheSchema.safeParse(entry?.value);
  const cached = parsed.success ? parsed.data : undefined;
  let series: Cache;
  let stale = false;
  let fetchError: string | undefined;
  let requests = 0;
  let notModified = 0;
  try {
    const pages: Cache["pages"] = [];
    const deadline = Date.now() + 12000;
    // Bound the job so a pagination error cannot consume the entire API budget.
    for (let page = 1; page <= 50; page++) {
      if (Date.now() > deadline) throw new Error("GitHub refresh budget exhausted");
      const previous = cached?.pages[page - 1];
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.star+json",
        "User-Agent": "agent-swarm-star-history-generator",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (options.authenticated) headers.Authorization = "Bearer [REDACTED:GITHUB_TOKEN]";
      if (previous?.etag) headers["If-None-Match"] = previous.etag;
      requests++;
      const response = await ctx.stdlib.fetch(
        `https://api.github.com/repos/${repository}/stargazers?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(1500) },
      );
      let current: Cache["pages"][number];
      if (response.status === 304 && previous) {
        current = previous;
        notModified++;
      } else {
        if (!response.ok) throw new Error(`GitHub stargazers HTTP ${response.status}`);
        const rows = z.array(z.object({ starred_at: z.string() })).parse(await response.json());
        const timestamps = rows.map((row) => Date.parse(row.starred_at));
        if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
          throw new Error("GitHub returned invalid star timestamps");
        }
        current = { etag: response.headers.get("etag"), timestamps };
      }
      pages.push(current);
      if (current.timestamps.length < 100) break;
      if (page === 50) throw new Error("Stargazer pagination exceeded 50 pages");
    }
    if (!pages.some((page) => page.timestamps.length)) throw new Error("No stargazers returned");
    series = { fetchedAt: new Date().toISOString(), pages };
    await ctx.swarm.kv_set({ namespace, key: "series", value: series });
  } catch (error) {
    if (!cached?.pages.some((page) => page.timestamps.length)) {
      throw new Error("GitHub fetch failed and no cached series exists; no pages published");
    }
    series = cached;
    stale = true;
    // Avoid transporting fetch exception text, which may include request details.
    fetchError = error instanceof Error && error.message.startsWith("GitHub stargazers HTTP")
      ? error.message : "GitHub refresh failed; using last-known series";
  }

  const timestamps = series.pages.flatMap((page) => page.timestamps).sort((a, b) => a - b);
  const pages = [];
  for (const theme of ["light", "dark"] as const) {
    const body = renderChart(repository, timestamps, theme);
    const slug = `star-history-${theme}`;
    if (options.dryRun) {
      pages.push({ slug, bytes: new TextEncoder().encode(body).length });
      continue;
    }
    const response = await ctx.swarm.page_create({
      slug, title: `Star history (${theme})`, body,
      description: `GitHub stars for ${repository}; fetched ${series.fetchedAt}`,
      contentType: "image/svg+xml", authMode: "public",
    }) as { data?: { id?: string; api_url?: string }; id?: string; api_url?: string };
    const page = response.data ?? response;
    if (!page.id || !page.api_url) throw new Error(`Failed to publish ${slug}`);
    pages.push({ slug, id: page.id, apiUrl: page.api_url });
  }
  return {
    repository, stars: timestamps.length, fetchedAt: series.fetchedAt, stale, fetchError,
    authenticated: options.authenticated, requests, notModified, dryRun: options.dryRun, pages,
  };
}
