import { type ComponentType, type LazyExoticComponent, lazy, Suspense } from "react";
import type { StatResult } from "@/lib/agent-fs/types";
import { type FileKind, getFileKind } from "@/lib/comb/file-kinds";
import type { DrivePath } from "@/lib/comb/paths";
import { ViewerSkeleton } from "./viewer-skeleton";

/**
 * What every viewer receives: the file and its `stat`. A viewer loads its own
 * bytes (`useAgentFsText` for text, a media URL for media) and renders its
 * blocks in normal flow, so the page's scroll pane scrolls it.
 */
export interface ViewerProps {
  file: DrivePath;
  stat: StatResult;
}

const FallbackViewer = lazy(() => import("./fallback-viewer"));

// Add a viewer = one entry + one component, same as live/ FileViewer.
// Step-6 points image, video, pdf, and table at their own viewers.
export const VIEWERS: Record<FileKind, LazyExoticComponent<ComponentType<ViewerProps>>> = {
  markdown: lazy(() => import("./markdown-viewer")),
  text: lazy(() => import("./text-viewer")),
  image: FallbackViewer,
  video: FallbackViewer,
  pdf: FallbackViewer,
  table: FallbackViewer,
  fallback: FallbackViewer,
};

/** Route a file to its viewer by extension (and content type for unknown extensions). */
export function FileViewer({ file, stat }: ViewerProps) {
  const Viewer = VIEWERS[getFileKind(file.path, stat.contentType, stat.size)];
  return (
    <Suspense fallback={<ViewerSkeleton />}>
      <Viewer file={file} stat={stat} />
    </Suspense>
  );
}
