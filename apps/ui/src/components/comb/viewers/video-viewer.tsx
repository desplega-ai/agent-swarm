import type { ViewerProps } from "./file-viewer";
import { MediaGate } from "./media-gate";

/**
 * Videos play with the browser's controls. From a presigned URL only the
 * metadata loads before play. In blob mode the whole file loads first (up to
 * `COMB_MEDIA_MAX_BYTES`).
 */
export default function VideoViewer({ file, stat }: ViewerProps) {
  return (
    <MediaGate file={file} stat={stat} kind="video">
      {(url, onError) => (
        <div className="flex min-h-full p-6">
          <video
            src={url}
            controls
            preload="metadata"
            playsInline
            onError={onError}
            className="m-auto max-h-[72vh] max-w-full rounded-md bg-black"
          >
            <track kind="captions" />
          </video>
        </div>
      )}
    </MediaGate>
  );
}
