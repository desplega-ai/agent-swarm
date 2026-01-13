/**
 * Content preview utilities for smart truncation and content type detection
 */

export type ContentType = 'json' | 'html' | 'text' | 'code';

/**
 * Detect content type from string
 */
export function detectContentType(content: string): ContentType {
  const trimmed = content.trim();

  // Check for JSON
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON, continue checking
    }
  }

  // Check for HTML
  if (trimmed.startsWith('<') && trimmed.includes('>')) {
    return 'html';
  }

  // Check for code (heuristic: contains common programming patterns)
  const codePatterns = [
    /function\s+\w+\s*\(/,
    /const\s+\w+\s*=/,
    /let\s+\w+\s*=/,
    /var\s+\w+\s*=/,
    /class\s+\w+/,
    /import\s+.*from/,
    /export\s+(default|const|function|class)/,
  ];

  if (codePatterns.some(pattern => pattern.test(content))) {
    return 'code';
  }

  return 'text';
}

/**
 * Generate smart preview for long content
 */
export function generatePreview(
  content: string,
  maxLength: number
): { preview: string; isTruncated: boolean; extraInfo?: string } {
  if (content.length <= maxLength) {
    return { preview: content, isTruncated: false };
  }

  const contentType = detectContentType(content);

  switch (contentType) {
    case 'json':
      return generateJsonPreview(content, maxLength);

    case 'html':
      return generateHtmlPreview(content, maxLength);

    case 'code':
      return generateCodePreview(content, maxLength);

    default:
      return generateTextPreview(content, maxLength);
  }
}

/**
 * Generate preview for JSON content
 */
function generateJsonPreview(
  content: string,
  maxLength: number
): { preview: string; isTruncated: boolean; extraInfo: string } {
  try {
    const obj = JSON.parse(content);

    if (content.length <= maxLength) {
      return { preview: content, isTruncated: false, extraInfo: '' };
    }

    // Show structure summary
    const preview = JSON.stringify(obj, null, 2).slice(0, maxLength);
    const lastNewline = preview.lastIndexOf('\n');
    const truncatedPreview = lastNewline > 0 ? preview.slice(0, lastNewline) : preview;

    const hiddenChars = content.length - truncatedPreview.length;
    const totalFields = countJsonFields(obj);
    const visibleFields = countJsonFields(JSON.parse(truncatedPreview + '}'));
    const hiddenFields = totalFields - visibleFields;

    return {
      preview: truncatedPreview,
      isTruncated: true,
      extraInfo: hiddenFields > 0
        ? `+${hiddenFields} more fields, ${hiddenChars} chars`
        : `+${hiddenChars} chars`,
    };
  } catch {
    // If JSON parsing fails, treat as text
    return generateTextPreview(content, maxLength);
  }
}

/**
 * Count total fields in JSON object (recursive)
 */
function countJsonFields(obj: unknown): number {
  if (typeof obj !== 'object' || obj === null) return 0;

  let count = 0;
  for (const value of Object.values(obj)) {
    count++;
    if (typeof value === 'object' && value !== null) {
      count += countJsonFields(value);
    }
  }
  return count;
}

/**
 * Generate preview for HTML content
 */
function generateHtmlPreview(
  content: string,
  maxLength: number
): { preview: string; isTruncated: boolean; extraInfo: string } {
  // Strip HTML tags for preview
  const strippedText = content.replace(/<[^>]*>/g, '');
  const textPreview = generateTextPreview(strippedText, maxLength);

  const tagCount = (content.match(/<[^>]+>/g) || []).length;

  return {
    preview: textPreview.preview,
    isTruncated: true,
    extraInfo: `HTML content, ${tagCount} tags`,
  };
}

/**
 * Generate preview for code content
 */
function generateCodePreview(
  content: string,
  maxLength: number
): { preview: string; isTruncated: boolean; extraInfo: string } {
  const lines = content.split('\n');

  if (content.length <= maxLength) {
    return { preview: content, isTruncated: false, extraInfo: '' };
  }

  let preview = '';
  let lineCount = 0;

  for (const line of lines) {
    if (preview.length + line.length + 1 > maxLength) break;
    preview += line + '\n';
    lineCount++;
  }

  const hiddenLines = lines.length - lineCount;

  return {
    preview: preview.trimEnd(),
    isTruncated: true,
    extraInfo: hiddenLines > 0 ? `+${hiddenLines} more lines` : '',
  };
}

/**
 * Generate preview for plain text content
 */
function generateTextPreview(
  content: string,
  maxLength: number
): { preview: string; isTruncated: boolean; extraInfo: string } {
  if (content.length <= maxLength) {
    return { preview: content, isTruncated: false, extraInfo: '' };
  }

  // Try to break at word boundary
  let preview = content.slice(0, maxLength);
  const lastSpace = preview.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.8) {
    preview = preview.slice(0, lastSpace);
  }

  const hiddenChars = content.length - preview.length;

  return {
    preview,
    isTruncated: true,
    extraInfo: `+${hiddenChars} chars`,
  };
}
