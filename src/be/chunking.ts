export interface MemoryChunk {
  content: string;
  chunkIndex: number;
  totalChunks: number;
  headings: string[];
}

const MAX_CHUNK_SIZE = 2000; // ~500 tokens
const CHUNK_OVERLAP = 100; // chars
const MIN_CHUNK_SIZE = 50; // skip trivially small chunks

/**
 * Two-stage markdown-aware content chunker.
 * Stage 1: Split by markdown headers (#, ##, ###) to preserve document structure.
 * Stage 2: If any section exceeds MAX_CHUNK_SIZE, apply recursive character splitting.
 * Small files (< MAX_CHUNK_SIZE) are returned as a single chunk.
 */
export function chunkContent(text: string): MemoryChunk[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < MIN_CHUNK_SIZE) {
    return [];
  }

  // Small content: single chunk
  if (trimmed.length <= MAX_CHUNK_SIZE) {
    return [{ content: trimmed, chunkIndex: 0, totalChunks: 1, headings: [] }];
  }

  // Stage 1: Split by markdown headers
  const sections = splitByHeaders(trimmed);

  // Stage 2: Split oversized sections
  const rawChunks: { content: string; headings: string[] }[] = [];
  for (const section of sections) {
    if (section.content.length <= MAX_CHUNK_SIZE) {
      rawChunks.push(section);
    } else {
      const subChunks = recursiveSplit(section.content);
      for (const sub of subChunks) {
        rawChunks.push({ content: sub, headings: section.headings });
      }
    }
  }

  // Filter out trivially small chunks and build final result
  const filtered = rawChunks.filter((c) => c.content.trim().length >= MIN_CHUNK_SIZE);
  if (filtered.length === 0) {
    return [{ content: trimmed, chunkIndex: 0, totalChunks: 1, headings: [] }];
  }

  return filtered.map((c, i) => ({
    content: c.headings.length > 0 ? `${c.headings.join(" > ")}\n\n${c.content}` : c.content,
    chunkIndex: i,
    totalChunks: filtered.length,
    headings: c.headings,
  }));
}

interface Section {
  content: string;
  headings: string[];
}

function splitByHeaders(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentContent: string[] = [];
  const headingStack: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      // Flush current section
      if (currentContent.length > 0) {
        const content = currentContent.join("\n").trim();
        if (content) {
          sections.push({ content, headings: [...headingStack] });
        }
        currentContent = [];
      }

      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();

      // Update heading stack: pop everything at or below this level
      while (headingStack.length >= level) {
        headingStack.pop();
      }
      headingStack.push(`${"#".repeat(level)} ${title}`);
    } else {
      currentContent.push(line);
    }
  }

  // Flush remaining content
  if (currentContent.length > 0) {
    const content = currentContent.join("\n").trim();
    if (content) {
      sections.push({ content, headings: [...headingStack] });
    }
  }

  // If no headers found, return as single section
  if (sections.length === 0) {
    return [{ content: text, headings: [] }];
  }

  return sections;
}

const SEPARATORS = ["\n\n", "\n", ". ", " "];

function recursiveSplit(text: string): string[] {
  return recursiveSplitWithSeparators(text, 0);
}

function recursiveSplitWithSeparators(text: string, separatorIndex: number): string[] {
  if (text.length <= MAX_CHUNK_SIZE) {
    return [text.trim()].filter((s) => s.length > 0);
  }

  if (separatorIndex >= SEPARATORS.length) {
    // Last resort: hard split at MAX_CHUNK_SIZE with overlap
    return hardSplit(text);
  }

  const separator = SEPARATORS[separatorIndex]!;
  const parts = text.split(separator);

  if (parts.length <= 1) {
    // This separator doesn't split; try next
    return recursiveSplitWithSeparators(text, separatorIndex + 1);
  }

  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? current + separator + part : part;
    if (candidate.length <= MAX_CHUNK_SIZE) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current.trim());
      }
      // If part itself is too big, recursively split it
      if (part.length > MAX_CHUNK_SIZE) {
        chunks.push(...recursiveSplitWithSeparators(part, separatorIndex + 1));
        current = "";
      } else {
        current = part;
      }
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // Add overlap between chunks
  return addOverlap(chunks, text);
}

function hardSplit(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + MAX_CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end).trim());
    start = end - CHUNK_OVERLAP;
    if (start >= text.length - MIN_CHUNK_SIZE) break;
  }
  return chunks.filter((c) => c.length > 0);
}

function addOverlap(chunks: string[], _originalText: string): string[] {
  if (chunks.length <= 1) return chunks;

  const result: string[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const prevChunk = chunks[i - 1]!;
    const chunk = chunks[i]!;
    // Take the last CHUNK_OVERLAP chars from previous chunk as prefix
    const overlapText = prevChunk.slice(-CHUNK_OVERLAP);
    // Only add overlap if it doesn't make the chunk too long
    if (overlapText.length + chunk.length <= MAX_CHUNK_SIZE + CHUNK_OVERLAP) {
      result.push(overlapText + chunk);
    } else {
      result.push(chunk);
    }
  }
  return result;
}
