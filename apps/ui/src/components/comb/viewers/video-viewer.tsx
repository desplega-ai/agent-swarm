import type { ViewerProps } from "./file-viewer";
import { MediaGate } from "./media-gate";

/** Videos play with the browser's controls. Only the metadata loads before play. */
export default function VideoViewer({ file }: ViewerProps) {
  return (
    <MediaGate file={file} noun="video">
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
