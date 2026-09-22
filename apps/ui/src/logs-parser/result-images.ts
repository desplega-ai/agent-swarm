export interface ResultImage {
  mimeType: string;
  data: string;
}

const IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp|avif)$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function imageBlock(value: unknown): ResultImage | undefined {
  const block = record(value);
  if (!block) return;
  if (block.type === "image") {
    const source = record(block.source);
    const mimeType = source?.type === "base64" ? source.media_type : block.mimeType;
    const data = source?.type === "base64" ? source.data : block.data;
    if (
      typeof mimeType === "string" &&
      IMAGE_MIME.test(mimeType) &&
      typeof data === "string" &&
      data.length > 0
    ) {
      return { mimeType, data };
    }
  }
  // OpenCode's tool state attachments are FileParts, with an inline data URL.
  if (block.type === "file" && typeof block.url === "string") {
    const match = /^data:(image\/[a-z+]+);base64,/.exec(block.url);
    if (match && IMAGE_MIME.test(match[1]) && block.mime === match[1]) {
      const data = block.url.slice(match[0].length);
      if (data) return { mimeType: match[1], data };
    }
  }
}

/** Only inspect content containers, never arbitrary tool data or text examples. */
export function resultImages(value: unknown): ResultImage[] {
  const image = imageBlock(value);
  if (image) return [image];
  if (Array.isArray(value)) return value.flatMap(resultImages);
  const obj = record(value);
  if (!obj) return [];
  return [obj.content, obj.attachments].flatMap((parts) =>
    Array.isArray(parts) ? parts.flatMap(resultImages) : [],
  );
}

/** Called only when the tool row is expanded. Does not construct any data URLs. */
export function imageResultPreview(
  body: string,
): { images: ResultImage[]; text: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return;
  }
  const images = resultImages(value);
  if (!images.length) return;
  const data = new Set(images.map((image) => image.data));
  let index = 0;
  const text = JSON.stringify(
    value,
    (_key, item) => {
      const image = imageBlock(item);
      return image && data.has(image.data) ? `[Image ${++index}]` : item;
    },
    2,
  );
  return { images, text };
}
