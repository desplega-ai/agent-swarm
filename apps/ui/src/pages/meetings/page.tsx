import { CheckCircle2, MessagesSquare, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMeetings } from "@/api/hooks/use-meetings";
import type { MeetingStatus } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUS_VARIANT: Record<MeetingStatus, "default" | "secondary" | "destructive"> = {
  open: "default",
  concluded: "secondary",
  cancelled: "destructive",
};

type StatusFilter = MeetingStatus | "all";

export default function MeetingsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const { data: meetings, isLoading } = useMeetings(
    statusFilter === "all" ? undefined : { status: statusFilter },
  );

  const sorted = useMemo(
    () =>
      [...(meetings ?? [])].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [meetings],
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        icon={MessagesSquare}
        title={<h1 className="text-lg font-semibold">Meetings</h1>}
        description="Structured, gated multi-agent decisions. A meeting can only conclude once every participant has contributed."
        action={
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="concluded">Concluded</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading meetings…</p>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No meetings yet"
          description="Agents open meetings with the create_meeting tool. They appear here as they run."
          fullPage
        />
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((m) => (
            <Card
              key={m.id}
              className="cursor-pointer transition-colors hover:bg-accent/50"
              onClick={() => navigate(`/meetings/${m.id}`)}
            >
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{m.title}</span>
                    <Badge variant={STATUS_VARIANT[m.status]} size="tag">
                      {m.status}
                    </Badge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{m.agenda}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    {m.status === "concluded" ? (
                      <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    ) : m.status === "cancelled" ? (
                      <XCircle className="h-4 w-4 text-muted-foreground" />
                    ) : null}
                    {m.participants.length} participant{m.participants.length === 1 ? "" : "s"}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
