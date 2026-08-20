import { AlertCircle, Check, Copy, Pencil, X } from "lucide-react";
import { useState } from "react";
import { useAgentRuntimeInstances, useUpdateAgentMaxTasks } from "@/api/hooks/use-agents";
import type { Agent, RuntimeInstance } from "@/api/types";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoRow } from "@/components/ui/info-row";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { formatRelative } from "@/lib/relative-time";
import {
  formatSlots,
  RUNTIME_CREDENTIAL_TONE,
  RUNTIME_LIVENESS_TONE,
  runtimeCredentialState,
  runtimeLiveness,
  runtimeLivenessHelp,
  shortRuntimeId,
} from "@/lib/runtime-instances";
import { cn, formatSmartTime } from "@/lib/utils";

const MAX_TASKS_MIN = 1;
const MAX_TASKS_MAX = 100;

function MaxTasksEditor({
  value,
  onSave,
  saving,
}: {
  value: number;
  onSave: (value: number) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const parsed = Number(draft.trim());
  const valid = /^\d+$/.test(draft.trim()) && parsed >= MAX_TASKS_MIN && parsed <= MAX_TASKS_MAX;

  function save() {
    if (!valid) return;
    if (parsed !== value) onSave(parsed);
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium tabular-nums">{value}</span>
        <span className="text-xs text-muted-foreground">
          concurrent task{value === 1 ? "" : "s"} across all runtimes
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label="Edit logical task limit"
          onClick={() => {
            setDraft(String(value));
            setEditing(true);
          }}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        min={MAX_TASKS_MIN}
        max={MAX_TASKS_MAX}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-7 w-20"
        aria-label="Logical task limit"
        autoFocus
      />
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        aria-label="Save task limit"
        disabled={!valid || saving}
        onClick={save}
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        aria-label="Cancel editing task limit"
        onClick={() => setEditing(false)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function RuntimeInstanceRow({
  instance,
  staleThresholdMinutes,
}: {
  instance: RuntimeInstance;
  staleThresholdMinutes?: number;
}) {
  const liveness = runtimeLiveness(instance);
  const tone = RUNTIME_LIVENESS_TONE[liveness];
  const credTone = RUNTIME_CREDENTIAL_TONE[runtimeCredentialState(instance.credentialReady)];
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot)} aria-hidden />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void copy(instance.id)}
            aria-label={`Copy runtime id ${instance.id}`}
            className="flex items-center gap-1 font-mono text-xs text-foreground/80 hover:text-foreground"
          >
            {shortRuntimeId(instance.id)}
            {copied ? (
              <Check className="h-3 w-3 text-status-success-strong" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground/70" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="font-mono text-[10px]">
          {copied ? "Copied" : instance.id}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" size="tag" className={tone.badge}>
            {tone.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          {runtimeLivenessHelp(liveness, staleThresholdMinutes)}
        </TooltipContent>
      </Tooltip>
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatSlots(instance.reportedSlots)}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" size="tag" className={credTone.badge}>
            {credTone.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{credTone.help}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="ml-auto text-xs text-muted-foreground">
            seen {formatRelative(instance.lastSeenAt)}
          </span>
        </TooltipTrigger>
        <TooltipContent className="font-mono text-[10px]">
          {formatSmartTime(instance.lastSeenAt)}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export interface RuntimeInstancesPanelProps {
  maxTasks: number;
  instances: RuntimeInstance[];
  staleThresholdMinutes?: number;
  isLoading: boolean;
  isError: boolean;
  onSaveMaxTasks: (value: number) => void;
  savingMaxTasks: boolean;
}

export function RuntimeInstancesPanel({
  maxTasks,
  instances,
  staleThresholdMinutes,
  isLoading,
  isError,
  onSaveMaxTasks,
  savingMaxTasks,
}: RuntimeInstancesPanelProps) {
  const live = instances.filter((i) => i.isLive);
  const liveSlots = live.reduce((sum, i) => sum + i.reportedSlots, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Runtime instances</CardTitle>
        {instances.length > 0 && (
          <CardAction className="flex items-center gap-1 text-xs text-muted-foreground">
            {live.length} live · {formatSlots(liveSlots)} reported
            <InfoTip content="Reported slots are each worker process's own execution capacity. The logical task limit caps concurrent tasks for the agent as a whole and is configured independently — it is not the sum of slots." />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <InfoRow label="Logical task limit">
          <MaxTasksEditor value={maxTasks} onSave={onSaveMaxTasks} saving={savingMaxTasks} />
        </InfoRow>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : isError ? (
          <AlertCallout tone="error" icon={AlertCircle}>
            Failed to load runtime instances.
          </AlertCallout>
        ) : instances.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runtime instances are currently registered for this agent. They appear when workers
            register in multi-runtime mode (MULTI_RUNTIME_ENABLED).
          </p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {instances.map((instance) => (
              <RuntimeInstanceRow
                key={instance.id}
                instance={instance}
                staleThresholdMinutes={staleThresholdMinutes}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function RuntimeInstancesSection({ agent }: { agent: Agent }) {
  const { data, isLoading, isError } = useAgentRuntimeInstances(agent.id);
  const updateMaxTasks = useUpdateAgentMaxTasks();

  return (
    <RuntimeInstancesPanel
      maxTasks={agent.capacity?.max ?? agent.maxTasks ?? 1}
      instances={data?.runtimeInstances ?? []}
      staleThresholdMinutes={data?.staleThresholdMinutes}
      isLoading={isLoading}
      isError={isError}
      savingMaxTasks={updateMaxTasks.isPending}
      onSaveMaxTasks={(value) => updateMaxTasks.mutate({ agentId: agent.id, maxTasks: value })}
    />
  );
}
