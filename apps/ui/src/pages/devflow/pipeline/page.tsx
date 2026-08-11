import { CircleDashed, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DevFlowState, DevFlowWorkItem } from "@/api/devflow-types";
import { useDevFlowWorkItems } from "@/api/hooks/use-devflow";
import { CaptureDialog } from "@/components/devflow/capture-dialog";
import { DevFlowStateBadge } from "@/components/devflow/devflow-state-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

const stages: Array<{ state: DevFlowState; label: string; gate: string }> = [
  { state: "captured", label: "Captured", gate: "Intake evidence" },
  { state: "triaged", label: "Triaged", gate: "Gate 1 · PM scope" },
  { state: "scoped", label: "Scoped", gate: "Gate 2 · Eng spec" },
  { state: "specced", label: "Specced", gate: "Next slice" },
];

function PipelineItem({ item, onOpen }: { item: DevFlowWorkItem; onOpen: () => void }) {
  return (
    <Button
      variant="ghost"
      className="h-auto w-full items-start justify-start whitespace-normal rounded-lg border border-border-subtle bg-background p-3 text-left shadow-none hover:bg-accent/50"
      onClick={onOpen}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="line-clamp-2 text-sm font-medium leading-snug">{item.title}</span>
        <span className="flex items-center gap-2">
          <Badge variant="outline" size="tag">
            {item.type}
          </Badge>
          {item.priority ? (
            <Badge variant="outline" size="tag">
              {item.priority}
            </Badge>
          ) : null}
        </span>
      </span>
    </Button>
  );
}

export default function DevFlowPipelinePage() {
  const navigate = useNavigate();
  const [captureOpen, setCaptureOpen] = useState(false);
  const { data, isLoading } = useDevFlowWorkItems();
  const activeItems =
    data?.items.filter((item) => !["blocked", "archived"].includes(item.state)) ?? [];
  const exceptionCount = (data?.items.length ?? 0) - activeItems.length;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="DevFlow Pipeline"
        description="A deterministic product-development path. Agents draft evidence; accountable humans approve gates."
        action={
          <Button size="sm" onClick={() => setCaptureOpen(true)}>
            <Plus /> Capture
          </Button>
        }
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{activeItems.length} active</span>
        <span aria-hidden="true">·</span>
        <span>{exceptionCount} blocked or archived</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid min-w-[1040px] grid-cols-4 gap-4 pb-4">
          {stages.map((stage) => {
            const items = activeItems.filter((item) => item.state === stage.state);
            return (
              <Card key={stage.state} className="min-h-[480px] gap-4 py-4 shadow-none">
                <CardHeader className="gap-2 px-4">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle>{stage.label}</CardTitle>
                    <DevFlowStateBadge state={stage.state} />
                  </div>
                  <CardDescription>
                    {stage.gate} · {items.length}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 px-3">
                  {items.map((item) => (
                    <PipelineItem
                      key={item.id}
                      item={item}
                      onOpen={() => navigate(`/devflow/work-items/${item.id}`)}
                    />
                  ))}
                  {!isLoading && items.length === 0 ? (
                    <EmptyState
                      icon={CircleDashed}
                      title="No work here"
                      description="Items appear after their preceding evidence and gate are complete."
                    />
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <CaptureDialog open={captureOpen} onOpenChange={setCaptureOpen} />
    </div>
  );
}
