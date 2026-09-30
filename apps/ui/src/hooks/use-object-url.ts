import { useEffect, useState } from "react";

/**
 * An object URL for `blob`. It is revoked when the blob changes and on
 * unmount. `type` sets the URL's content type: the bytes are not copied, and
 * `blob` itself keeps its type.
 */
export function useObjectUrl(blob: Blob | undefined, type?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(
      type && blob.type !== type ? blob.slice(0, blob.size, type) : blob,
    );
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [blob, type]);
  // On a blob change the old URL shows for one more render. It is revoked after that commit.
  return blob ? url : null;
}

/** A `data:` URL of `blob` with the content type `type`. The bytes are read once per blob. */
export function useDataUrl(blob: Blob | undefined, type: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => setUrl(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(blob.slice(0, blob.size, type));
    return () => {
      reader.abort();
      setUrl(null);
    };
  }, [blob, type]);
  return blob ? url : null;
}
