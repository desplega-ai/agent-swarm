import { baseName } from "@/lib/comb/paths";
import type { ViewerProps } from "./file-viewer";
import { MediaGate } from "./media-gate";

/** PDFs render in the browser's own PDF viewer (an inline URL in a frame). */
export default function PdfViewer({ file, stat }: ViewerProps) {
  return (
    <MediaGate file={file} stat={stat} kind="pdf">
      {(url) => (
        <iframe
          src={url}
          title={baseName(file.path)}
          className="block h-full min-h-[72vh] w-full border-0"
        />
      )}
    </MediaGate>
  );
}
