import { FileWarning, Globe } from "lucide-react";
import { useState } from "react";
import { useHtmlSiteUrl } from "@/api/hooks/use-agent-fs";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAgentFs } from "@/contexts/agent-fs-context";
import {
  HTML_FRAME_POLICY,
  HTML_SITE_TTL_SECONDS,
  HTML_SITES_FEATURE,
  isDriveRootFile,
} from "@/lib/comb/html-view";
import { baseName, type DrivePath } from "@/lib/comb/paths";
import { cn } from "@/lib/utils";
import type { ViewerProps } from "./file-viewer";
import TextViewer from "./text-viewer";
import { ViewerSkeleton } from "./viewer-skeleton";

type HtmlView = "source" | "preview";

const VIEWS = [
  { value: "source", label: "Source", tooltip: "The HTML as text. Comments anchor here." },
  { value: "preview", label: "Preview", tooltip: "Run the page in a sandboxed frame" },
] as const;

/** Drive-root pages the person agreed to preview, for this page load. */
const approvedRootPages = new Set<string>();

function rootPageKey({ orgId, driveId, path }: DrivePath): string {
  return `${orgId}/${driveId}${path}`;
}

/**
 * An HTML file: the source (the text viewer, where comments anchor) and a
 * sandboxed preview next to it. Source is the default, so a plain visit
 * makes no public link. Without the agent-fs `html-sites` feature only the
 * source shows.
 */
export default function HtmlViewer({ file, stat }: ViewerProps) {
  const { features } = useAgentFs();
  const [view, setView] = useState<HtmlView>("source");
  if (!features.has(HTML_SITES_FEATURE)) return <TextViewer file={file} stat={stat} />;
  return (
    // The preview fills the pane, so the pane never scrolls around the frame.
    <div className={cn("flex min-h-full flex-col", view === "preview" && "h-full")}>
      {/* Not document text: comments never anchor on the toolbar. */}
      <div
        data-comb-skip
        className="sticky top-0 left-0 z-10 flex items-center gap-3 border-b border-border-subtle bg-card px-3 py-2"
      >
        <SegmentedControl
          aria-label="HTML view"
          size="sm"
          value={view}
          onValueChange={setView}
          options={VIEWS}
        />
        {view === "preview" ? (
          <span className="truncate text-xs text-muted-foreground">
            Sandboxed. The page cannot reach this dashboard.
          </span>
        ) : null}
      </div>
      {view === "source" ? (
        <TextViewer file={file} stat={stat} />
      ) : (
        <HtmlPreview key={stat.currentVersion} file={file} onShowSource={() => setView("source")} />
      )}
    </div>
  );
}

function HtmlPreview({ file, onShowSource }: { file: DrivePath; onShowSource: () => void }) {
  // A drive-root page gets a share of the whole drive, so ask first.
  const [confirmed, setConfirmed] = useState(
    () => !isDriveRootFile(file.path) || approvedRootPages.has(rootPageKey(file)),
  );
  const { url, error } = useHtmlSiteUrl(file, confirmed);

  if (!confirmed) {
    return (
      <EmptyState
        icon={Globe}
        title="Preview a page at the drive root?"
        description={`To load its files, the page gets a link to the whole drive for ${HTML_SITE_TTL_SECONDS / 60} minutes. Anyone who gets the link can read every file in the drive until it expires.`}
        action={
          <>
            <Button
              size="sm"
              onClick={() => {
                approvedRootPages.add(rootPageKey(file));
                setConfirmed(true);
              }}
            >
              Preview
            </Button>
            <Button size="sm" variant="outline" onClick={onShowSource}>
              Show source
            </Button>
          </>
        }
      />
    );
  }
  if (error) {
    return (
      <EmptyState
        icon={FileWarning}
        title="Could not preview this page"
        description={error.message}
        action={
          <Button size="sm" variant="outline" onClick={onShowSource}>
            Show source
          </Button>
        }
      />
    );
  }
  if (!url) return <ViewerSkeleton />;
  return (
    // `bg-white`: a page without a background expects the browser's white
    // canvas, not the dashboard theme behind a transparent frame.
    <iframe
      src={url}
      title={`Preview of ${baseName(file.path)}`}
      {...HTML_FRAME_POLICY}
      className="block min-h-[24rem] w-full flex-1 border-0 bg-white"
    />
  );
}
