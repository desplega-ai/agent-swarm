/**
 * Build a Latin-1-safe RFC 6266 Content-Disposition value for downloads.
 * `filename` provides a conservative ASCII fallback while `filename*`
 * preserves the original UTF-8 filename for clients that support RFC 5987.
 */
export function attachmentContentDisposition(filename: string): string {
  const safeFilename = filename.replace(/[\r\n\0]/g, "");
  const asciiFallback = safeFilename.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  const encodedFilename = encodeURIComponent(safeFilename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiFallback || "download"}"; filename*=UTF-8''${encodedFilename || "download"}`;
}
