import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensure a blog slug is unique by checking if the directory already exists.
 * If collision detected, appends a 5-char SHA256 hash suffix.
 */
export function ensureUniqueSlug(
  slug: string,
  blogBasePath: string,
): string {
  const targetDir = join(blogBasePath, slug);

  if (!existsSync(targetDir)) {
    return slug;
  }

  // Collision: append 5-char hash suffix
  const hashInput = `${slug}-${new Date().toISOString()}`;
  const hashSuffix = createHash("sha256")
    .update(hashInput)
    .digest("hex")
    .slice(0, 5);

  const uniqueSlug = `${slug}-${hashSuffix}`;
  console.log(`[slug] Collision detected for "${slug}", using "${uniqueSlug}"`);
  return uniqueSlug;
}

/**
 * Parse the METADATA: JSON line from blog writer output.
 * Returns the parsed metadata and the cleaned output (without METADATA lines).
 */
export function parseBlogMetadata(
  output: string,
): { metadata: { slug: string; image_filename?: string } | null; cleanedOutput: string } {
  const lines = output.split("\n");
  const cleanedLines: string[] = [];
  let metadata: { slug: string; image_filename?: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("METADATA:")) {
      try {
        const jsonStr = trimmed.slice("METADATA:".length).trim();
        metadata = JSON.parse(jsonStr);
      } catch {
        // Keep line if JSON parse fails
        cleanedLines.push(line);
      }
    } else {
      cleanedLines.push(line);
    }
  }

  return { metadata, cleanedOutput: cleanedLines.join("\n") };
}

/**
 * Extract title, main_topic, keywords, and subjects from TSX blog content.
 * Ports Python's _record_blog_content extraction logic.
 */
export function extractBlogMetadataFromContent(content: string): {
  title: string | null;
  mainTopic: string | null;
  keywords: string[];
  subjects: string[];
} {
  // Extract title from metadata
  const titleMatch = content.match(/title:\s*['"]([^'"]+)['"]/);
  const title = titleMatch?.[1] ?? null;

  // Extract main_topic: text before first colon, or before pipe
  let mainTopic: string | null = null;
  if (title) {
    if (title.includes(":")) {
      mainTopic = title.split(":")[0]?.trim() ?? null;
    } else if (title.includes("|")) {
      mainTopic = title.split("|")[0]?.trim().slice(0, 50) ?? null;
    } else {
      mainTopic = title.slice(0, 50);
    }
  }

  // Extract keywords from metadata
  const keywordsMatch = content.match(/keywords:\s*['"]([^'"]+)['"]/);
  const keywords = keywordsMatch?.[1]
    ? keywordsMatch[1].split(",").map((k) => k.trim())
    : [];

  // Extract subjects from H2/H3 headings
  const headingRegex = /<h[23][^>]*>([^<]+)<\/h[23]>/gi;
  const subjects: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(content)) !== null && subjects.length < 10) {
    if (match[1]) subjects.push(match[1].trim());
  }

  // Fallback: extract description if no subjects found
  if (subjects.length === 0) {
    const descMatch = content.match(/description:\s*['"]([^'"]+)['"]/);
    if (descMatch?.[1]) {
      subjects.push(descMatch[1].slice(0, 100));
    }
  }

  return { title, mainTopic, keywords, subjects };
}
