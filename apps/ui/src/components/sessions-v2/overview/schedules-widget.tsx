/**
 * The Schedules widget of the Overview (step-10): every schedule whose runs
 * file into the group, in a compact list with a sticky header. Each row
 * has its cadence, its agent, a read-only "Template" disclosure, its next
 * run (Run now on hover or focus), and its enabled switch. From 8
 * schedules up a search field filters the rows. The list caps at 400 px and
 * scrolls inside itself with a stable gutter, so 50+ schedules stay usable.
 */

import { ChevronRight, Clock, ExternalLink, Play, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useCreateSchedule } from "@/api/hooks/use-schedules";
import type { ScheduledTask } from "@/api/types";
import { ScheduleDialog, scheduleCreateInput } from "@/components/schedules/schedule-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  cadenceWords,
  formatNextRun,
  matchesScheduleSearch,
  SCHEDULE_SEARCH_FROM,
} from "@/lib/use-case-overview";
import { cn } from "@/lib/utils";
import {
  BlockedHint,
  PAUSED_RUN_REASON,
  useAgentNames,
  useRunNow,
  useToggleSchedule,
} from "./run-now";
import { Widget } from "./widget";

/** What a schedule runs: its task text, or the workflow or script it starts. */
function templateText(schedule: ScheduledTask): string {
  if (schedule.targetType === "workflow") return `Starts workflow ${schedule.workflowId ?? ""}`;
  if (schedule.targetType === "script") return `Runs script ${schedule.scriptName ?? ""}`;
  return schedule.taskTemplate?.trim() || "No task text.";
}

function ScheduleRow({
  schedule,
  agent,
  now,
  open,
  onToggleOpen,
  runNow,
  toggle,
}: {
  schedule: ScheduledTask;
  agent: string;
  now: number;
  open: boolean;
  onToggleOpen: () => void;
  runNow: ReturnType<typeof useRunNow>;
  toggle: ReturnType<typeof useToggleSchedule>;
}) {
  const due =
    schedule.enabled && schedule.nextRunAt ? formatNextRun(schedule.nextRunAt, now).when : null;
  const templateId = `schedule-template-${schedule.id}`;
  return (
    <li className="group/row border-b border-border-subtle last:border-b-0">
      <div className="flex min-h-13 items-center gap-3 px-3.5 py-2 hover:bg-accent/40">
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "truncate text-sm font-medium",
              !schedule.enabled && "text-muted-foreground",
            )}
          >
            {schedule.name}
          </div>
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate">
              {cadenceWords(schedule)} · {agent} ·
            </span>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={templateId}
              onClick={onToggleOpen}
              className="flex shrink-0 items-center rounded-sm hover:text-foreground"
            >
              Template
              <ChevronRight
                aria-hidden
                className={cn("size-3 transition-transform duration-150", open && "rotate-90")}
              />
            </button>
          </div>
        </div>
        {/* One slot: the next run, or Run now while the row is hovered or focused. */}
        <div className="grid w-28 shrink-0 justify-items-end">
          <span
            className={cn(
              "col-start-1 row-start-1 self-center font-mono text-xs whitespace-nowrap tabular-nums",
              "group-focus-within/row:invisible group-hover/row:invisible",
              due ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {due ?? "Paused"}
          </span>
          <span className="invisible col-start-1 row-start-1 group-focus-within/row:visible group-hover/row:visible">
            <BlockedHint reason={schedule.enabled ? null : PAUSED_RUN_REASON}>
              <Button
                size="xs"
                variant="outline"
                aria-disabled={!schedule.enabled || undefined}
                disabled={runNow.pendingId === schedule.id}
                onClick={() => runNow.run(schedule)}
                aria-label={`Run ${schedule.name} now`}
                className="aria-disabled:opacity-50"
              >
                <Play />
                Run now
              </Button>
            </BlockedHint>
          </span>
        </div>
        <Switch
          checked={schedule.enabled}
          disabled={toggle.pendingId === schedule.id}
          onCheckedChange={(enabled) => toggle.toggle(schedule, enabled)}
          aria-label={`${schedule.name} enabled`}
        />
      </div>
      {open ? (
        <div id={templateId} className="space-y-2 px-3.5 pb-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Task template</span>
            <span>read-only</span>
            <span className="flex-1" />
            <Link to={`/schedules/${schedule.id}`} className="hover:text-foreground">
              Edit in Schedules
            </Link>
          </div>
          <pre className="max-h-48 overflow-auto rounded-md border border-border-subtle bg-muted/40 p-2.5 font-mono text-xs whitespace-pre-wrap [scrollbar-gutter:stable]">
            {templateText(schedule)}
          </pre>
        </div>
      ) : null}
    </li>
  );
}

export function SchedulesWidget({
  groupKey,
  schedules,
  now,
}: {
  groupKey: string;
  schedules: ScheduledTask[];
  now: number;
}) {
  const agentName = useAgentNames();
  const runNow = useRunNow();
  const toggle = useToggleSchedule();
  const create = useCreateSchedule();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const searchable = schedules.length >= SCHEDULE_SEARCH_FROM;
  const shown = searchable
    ? schedules.filter((schedule) =>
        matchesScheduleSearch(schedule, agentName(schedule.targetAgentId), query),
      )
    : schedules;
  const enabled = schedules.filter((schedule) => schedule.enabled).length;

  return (
    <Widget
      icon={Clock}
      title="Schedules"
      count={schedules.length}
      action={
        <Button size="xs" variant="outline" onClick={() => setCreating(true)}>
          <Plus />
          New schedule
        </Button>
      }
      footer={
        <>
          <span>
            {enabled} enabled · {schedules.length - enabled} paused
          </span>
          <span className="flex-1" />
          <Link to="/schedules" className="flex items-center gap-1 hover:text-foreground">
            Open in Schedules
            <ExternalLink aria-hidden className="size-3" />
          </Link>
        </>
      }
    >
      {searchable ? (
        <div className="flex items-center gap-2 border-b border-border-subtle px-3.5 py-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden
              className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search schedules"
              aria-label="Search schedules"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {shown.length} of {schedules.length}
          </span>
        </div>
      ) : null}
      <div className="max-h-100 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="sticky top-0 z-10 flex h-8 items-center gap-3 border-b border-border-subtle bg-card px-3.5 text-xs text-muted-foreground">
          <span className="flex-1">Schedule</span>
          <span className="w-28 text-right">Next run</span>
          <span className="w-8 text-right">On</span>
        </div>
        {shown.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-sm text-muted-foreground">
            No schedule matches.
          </p>
        ) : (
          <ul aria-label="Schedules in this group">
            {shown.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                agent={agentName(schedule.targetAgentId)}
                now={now}
                open={openId === schedule.id}
                onToggleOpen={() => setOpenId((id) => (id === schedule.id ? null : schedule.id))}
                runNow={runNow}
                toggle={toggle}
              />
            ))}
          </ul>
        )}
      </div>
      {creating ? (
        <ScheduleDialog
          open
          initialKey={groupKey}
          onOpenChange={setCreating}
          onSubmit={(data) =>
            create.mutate(scheduleCreateInput(data), {
              onSuccess: () => toast.success(`Created ${data.name}.`),
              onError: (error) => toast.error(error.message),
            })
          }
        />
      ) : null}
    </Widget>
  );
}
