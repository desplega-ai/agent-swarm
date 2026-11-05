import { type ReactNode, useState } from "react";

/**
 * An `<img>` for a URL the dashboard does not control (an https link, a Slack
 * app avatar, a presigned agent-fs URL). It sends no referrer, and it renders
 * `fallback` with no `src` and after this `src` fails to load. A new `src`
 * gets a fresh try.
 */
export function ImageWithFallback({
  src,
  alt,
  className,
  fallback,
  onError,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  fallback: ReactNode;
  /** Called once when `src` fails, after the fallback takes its place. */
  onError?: () => void;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || src === failedSrc) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => {
        setFailedSrc(src);
        onError?.();
      }}
      className={className}
    />
  );
}
