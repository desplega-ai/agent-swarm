import { ReactFlowProvider, useReactFlow, type Viewport } from "@xyflow/react";
import { ChevronDown, Maximize2, ScanSearch, X, ZoomIn } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type { WorkflowDefinition } from "@/api/types";
import { MarkdownView } from "@/components/shared/markdown-view";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn } from "@/lib/utils";
import { PHONE_FIT_OPTIONS, PhoneGraphCanvas } from "./phone-graph";
import { PhoneStepsList } from "./phone-steps";

/** More nodes than this opens on the Steps list: a long graph is a lot of panning. */
const STEPS_FIRST_ABOVE = 12;

type View = "graph" | "steps";

/**
 * One tap fits the whole graph into the canvas (the overview), the next goes
 * back to where the user was (the readable zoom).
 */
function FitButton() {
  const flow = useReactFlow();
  const [fitted, setFitted] = useState(false);
  const before = useRef<Viewport | null>(null);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-9"
      aria-label={fitted ? "Back to readable zoom" : "Fit whole graph"}
      title={fitted ? "Back to readable zoom" : "Fit whole graph"}
      onClick={() => {
        if (!fitted) {
          before.current = flow.getViewport();
          void flow.fitView(PHONE_FIT_OPTIONS);
        } else if (before.current) {
          void flow.setViewport(before.current, { duration: 250 });
        }
        setFitted(!fitted);
      }}
    >
      {fitted ? <ZoomIn className="size-4" /> : <ScanSearch className="size-4" />}
    </Button>
  );
}

/**
 * Definition tab on a phone: one card that fills the rest of the screen. A
 * Graph / Steps switch and the canvas tools sit in a 40px strip; below it is
 * the canvas at a readable zoom, or the same nodes as tappable rows. Tapping a
 * node (either way) opens the inspector as a bottom sheet, so there is no
 * permanent, mostly empty Inspector card.
 */
export function PhoneDefinition({
  definition,
  selectedNodeId,
  onSelectNode,
  onExpand,
  footer,
}: {
  definition: WorkflowDefinition;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onExpand: () => void;
  footer?: ReactNode;
}) {
  const { searchParams, setParam } = useUrlSearchState();
  const nodeCount = definition.nodes.length;
  const defaultView: View = nodeCount > STEPS_FIRST_ABOVE ? "steps" : "graph";
  const view: View =
    readStringParam(searchParams, "view", defaultView) === "steps" ? "steps" : "graph";
  const [hintShown, setHintShown] = useState(true);

  return (
    <ReactFlowProvider>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div className="flex min-h-[22rem] flex-1 flex-col overflow-hidden rounded-lg border bg-card">
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-1.5">
            <SegmentedControl<View>
              size="sm"
              aria-label="Definition view"
              value={view}
              onValueChange={(next) => setParam("view", next, { defaultValue: defaultView })}
              options={[
                { value: "graph", label: "Graph" },
                { value: "steps", label: `Steps · ${nodeCount}` },
              ]}
            />
            {view === "graph" && (
              <div className="flex items-center">
                <FitButton />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9"
                  onClick={onExpand}
                  aria-label="Expand graph"
                  title="Expand graph"
                >
                  <Maximize2 className="size-4" />
                </Button>
              </div>
            )}
          </div>
          {view === "graph" ? (
            <div className="relative min-h-0 flex-1">
              <PhoneGraphCanvas
                definition={definition}
                onNodeClick={onSelectNode}
                onInteract={() => setHintShown(false)}
                className="h-full"
              />
              {hintShown && (
                <p className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full border bg-background/85 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                  Tap a node to inspect · drag to pan · pinch to zoom
                </p>
              )}
            </div>
          ) : (
            <PhoneStepsList
              definition={definition}
              selectedNodeId={selectedNodeId}
              onSelect={onSelectNode}
            />
          )}
        </div>
        {footer}
      </div>
    </ReactFlowProvider>
  );
}

/** Full-screen graph for a phone, opened by the card's expand button. */
export function PhoneGraphDialog({
  open,
  onOpenChange,
  title,
  definition,
  onSelectNode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  definition: WorkflowDefinition;
  /** A tap closes the dialog and shows that node in the inspector sheet. */
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh w-dvw max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none"
      >
        <ReactFlowProvider>
          <DialogHeader className="shrink-0 flex-row items-center justify-between gap-1 border-b px-4 py-1.5">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title}
            </DialogTitle>
            <FitButton />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-mr-2 size-9 shrink-0"
              onClick={() => onOpenChange(false)}
              aria-label="Close expanded graph"
            >
              <X className="size-4" />
            </Button>
          </DialogHeader>
          <PhoneGraphCanvas
            definition={definition}
            onNodeClick={onSelectNode}
            className="min-h-0 flex-1"
          />
        </ReactFlowProvider>
      </DialogContent>
    </Dialog>
  );
}

/** Bottom sheet that holds the node inspector on a phone. */
export function PhoneNodeSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DrawerContent
        className="h-[72dvh] data-[vaul-drawer-direction=bottom]:max-h-[72dvh]"
        aria-describedby={undefined}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-1 pb-1">
          <DrawerTitle className="min-w-0 truncate text-sm">{title}</DrawerTitle>
          <DrawerDescription className="sr-only">
            Definition of the selected workflow node
          </DrawerDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mr-2 size-9 shrink-0"
            onClick={onClose}
            aria-label="Close inspector"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col border-t">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Header description for a phone: one line, tap to read all of it. The stock
 * `CollapsibleDescription` spends a second row on its "Show more" link.
 */
export function PhoneDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 60 || text.includes("\n");
  if (!long) {
    return <p className="text-sm leading-snug text-muted-foreground">{text}</p>;
  }
  return (
    <div className="flex items-start gap-1 text-sm text-muted-foreground">
      {open ? (
        <div className="min-w-0 flex-1 leading-snug">
          <MarkdownView text={text} />
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="min-w-0 flex-1 text-left">
          <span className="line-clamp-1 block leading-snug">{text.split("\n")[0]}</span>
        </button>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Collapse description" : "Expand description"}
        onClick={() => setOpen(!open)}
        className="-my-2 -mr-2 flex size-9 shrink-0 items-center justify-center"
      >
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
    </div>
  );
}
