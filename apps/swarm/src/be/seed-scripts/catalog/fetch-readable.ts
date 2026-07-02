import { z } from "zod";

export const argsSchema = z.object({
  url: z.string().describe("Absolute http(s) URL of the page to extract"),
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Truncate extracted text to this many characters (default 20000)"),
});

const ENTITIES: any = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(input: string): string {
  let out = input.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m: string) => ENTITIES[m] || m);
  out = out.replace(/&#(\d+);/g, (_m: string, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 10)),
  );
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m: string, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 16)),
  );
  return out;
}

/** Fetch a web page and return readable article text with nav/ads/boilerplate stripped. */
export default async function fetchReadable(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { url } = parsed.data;
  if (!/^https?:\/\//i.test(url)) return { error: "url must be an absolute http(s) URL" };
  const maxChars = parsed.data.maxChars || 20000;

  const html: any = await ctx.stdlib.fetchJson(url, {
    headers: { "User-Agent": "agent-swarm-scripts", Accept: "text/html,*/*" },
  });
  const raw = typeof html === "string" ? html : JSON.stringify(html);

  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogMatch = raw.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  const title = decodeEntities((ogMatch?.[1] ?? titleMatch?.[1] ?? "").trim());

  let body = raw;
  // Drop non-content regions entirely (tag + inner content).
  body = body.replace(
    /<(script|style|noscript|nav|header|footer|aside|svg|template|form|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  body = body.replace(/<!--[\s\S]*?-->/g, " ");
  // Keep block boundaries as newlines so paragraphs survive.
  body = body.replace(/<\/(p|div|section|article|li|h[1-6]|br|tr)>/gi, "\n");
  body = body.replace(/<br\s*\/?>/gi, "\n");
  // Strip all remaining tags.
  body = body.replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);
  body = body
    .split("\n")
    .map((line: string) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((line: string) => line.length > 0)
    .join("\n");
  body = body.replace(/\n{3,}/g, "\n\n");

  const truncated = body.length > maxChars;
  if (truncated) body = body.slice(0, maxChars);

  return { title, text: body, url, length: body.length, truncated };
}
