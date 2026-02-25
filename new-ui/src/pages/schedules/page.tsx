import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useScheduledTasks } from "@/api/hooks/use-schedules";
import { useAgents } from "@/api/hooks/use-agents";
import { formatSmartTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Clock, Timer } from "lucide-react";

function formatInterval(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  return `${hours / 24}d`;
}

export default function SchedulesPage() {
  const navigate = useNavigate();
  const { data: schedules, isLoading } = useScheduledTasks();
  const { data: agents } = useAgents();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-2xl font-bold">Schedules</h1>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-bold">Schedules</h1>

      {schedules && schedules.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Target Agent</TableHead>
                <TableHead>Next Run</TableHead>
                <TableHead>Last Run</TableHead>
                <TableHead className="w-[80px]">Enabled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((schedule) => (
                <TableRow
                  key={schedule.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => navigate(`/schedules/${schedule.id}`)}
                >
                  <TableCell className="font-medium">{schedule.name}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      {schedule.cronExpression ? (
                        <>
                          <Clock className="h-3.5 w-3.5" />
                          <code className="text-xs">{schedule.cronExpression}</code>
                        </>
                      ) : schedule.intervalMs ? (
                        <>
                          <Timer className="h-3.5 w-3.5" />
                          <span>every {formatInterval(schedule.intervalMs)}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {schedule.targetAgentId
                      ? agentMap.get(schedule.targetAgentId) ??
                        schedule.targetAgentId.slice(0, 8) + "..."
                      : "Pool"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {schedule.nextRunAt ? formatSmartTime(schedule.nextRunAt) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {schedule.lastRunAt ? formatSmartTime(schedule.lastRunAt) : "Never"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={schedule.enabled ? "default" : "secondary"}
                      className={
                        schedule.enabled
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                          : ""
                      }
                    >
                      {schedule.enabled ? "On" : "Off"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Clock className="h-8 w-8 mb-2" />
          <p className="text-sm">No scheduled tasks</p>
        </div>
      )}
    </div>
  );
}
