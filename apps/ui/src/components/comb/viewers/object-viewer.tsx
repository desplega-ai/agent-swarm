import { FileWarning } from "lucide-react";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { DEFAULT_EMBED_HEIGHT, ObjectEmbed } from "@/components/objects/object-embed";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useTheme } from "@/hooks/use-theme";
import { objectKindFor, swarmObjectId } from "@/lib/comb/file-kinds";
import { useCan } from "@/lib/use-can";
import type { ViewerProps } from "./file-viewer";
import { TextGate } from "./text-gate";
import TextViewer from "./text-viewer";

type ObjectView = "object" | "source";

const MIN_EMBED_HEIGHT = 240;
// The `p-3` around the embed, top plus bottom.
const BODY_PADDING_PX = 24;

/**
 * A swarm board (`.excalidraw`) or sheet (`.sheet.json`): the live, editable
 * ObjectEmbed found by the `swarm.id` in the file, and the raw JSON behind a
 * Source toggle (where comments anchor). People without `objects.write` get
 * the read-only embed; the server enforces it either way.
 */
export default function ObjectViewer({ file, stat }: ViewerProps) {
  const [view, setView] = useState<ObjectView>("object");
  const body = useRef<HTMLDivElement>(null);
  const height = usePaneHeight(body);
  const label = objectKindFor(file.path) === "sheet" ? "Sheet" : "Board";
  const views = [
    { value: "object", label, tooltip: `Open the ${label.toLowerCase()} to view and edit it` },
    { value: "source", label: "Source", tooltip: "The file as JSON. Comments anchor here." },
  ] as const;
  return (
    <div className="flex min-h-full flex-col">
      {/* Not document text: comments never anchor on the toolbar. */}
      <div
        data-comb-skip
        className="sticky top-0 left-0 z-10 flex items-center gap-3 border-b border-border-subtle bg-card px-3 py-2"
      >
        <SegmentedControl
          aria-label={`${label} view`}
          size="sm"
          value={view}
          onValueChange={setView}
          options={views}
        />
      </div>
      <div ref={body}>
        {view === "source" ? (
          <TextViewer file={file} stat={stat} />
        ) : (
          <TextGate file={file} stat={stat}>
            {(text) => (
              <ObjectBody
                text={text}
                label={label}
                height={height}
                onShowSource={() => setView("source")}
              />
            )}
          </TextGate>
        )}
      </div>
    </div>
  );
}

/**
 * The embed height that fills the nearest scrolling ancestor below `ref`: the
 * Files pane, the link preview, or the session overview's capped preview. A
 * change under 3 px is ignored, so rounding cannot resize it in a loop.
 */
function usePaneHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(DEFAULT_EMBED_HEIGHT);
  useLayoutEffect(() => {
    const el = ref.current;
    let pane = el?.parentElement ?? null;
    while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) {
      pane = pane.parentElement;
    }
    if (!el || !pane) return;
    const scroller = pane;
    const measure = () => {
      const top =
        el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      // A pane sized by its content (`max-h-*`) grows to its cap, so fill the cap.
      const cap = Number.parseFloat(getComputedStyle(scroller).maxHeight);
      const available = Number.isFinite(cap) ? cap : scroller.clientHeight;
      const next = Math.max(MIN_EMBED_HEIGHT, Math.floor(available - top - BODY_PADDING_PX));
      setHeight((current) => (Math.abs(next - current) < 3 ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

function ObjectBody({
  text,
  label,
  height,
  onShowSource,
}: {
  text: string;
  label: string;
  height: number;
  onShowSource: () => void;
}) {
  const { theme } = useTheme();
  const canWrite = useCan("objects.write");
  // shortcut: the file is read once here for its id and again by the embed; add a by-path object lookup if large files make that slow.
  const objectId = swarmObjectId(text);
  if (!objectId) {
    return (
      <EmptyState
        icon={FileWarning}
        title={`This ${label.toLowerCase()} is not indexed yet`}
        description="The file has no swarm object id, so it cannot open as a live view. The swarm adds the id the next time it reindexes the drive."
        action={
          <Button size="sm" variant="outline" onClick={onShowSource}>
            Show source
          </Button>
        }
      />
    );
  }
  return (
    <div className="p-3">
      <ObjectEmbed
        objectId={objectId}
        height={height}
        readOnly={!canWrite}
        fetch={api.fetchApi}
        theme={theme}
      />
    </div>
  );
}
