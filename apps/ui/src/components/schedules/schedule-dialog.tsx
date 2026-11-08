/**
 * The create and edit dialog of a schedule. The Schedules page and the
 * use-case Overview in Sessions (step-10) open it.
 */

import { useMemo, useState } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import { useModelsCatalog } from "@/api/hooks/use-models-catalog";
import type { useCreateSchedule } from "@/api/hooks/use-schedules";
import {
  EMPTY_SCHEDULE_TARGET,
  isScheduleTargetInvalid,
  ScheduleTargetFields,
  type ScheduleTargetFormValue,
} from "@/components/schedules/schedule-target-fields";
import { StartInPicker } from "@/components/sessions-v2/start-in-picker";
import { useMyGroups } from "@/components/sessions-v2/use-my-groups";
import { ModelCombobox } from "@/components/shared/model-combobox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/contexts/current-user-context";
import { findModelOption, modelGroupsForSchedule } from "@/lib/agent-runtime-models";
import { MODEL_TIER_OPTIONS } from "@/lib/model-tiers";
import { groupCrumb } from "@/lib/session-groups";

type CreateScheduleInput = Parameters<ReturnType<typeof useCreateSchedule>["mutate"]>[0];

export interface ScheduleFormData extends ScheduleTargetFormValue {
  name: string;
  /** The Sessions group its runs start in, or null for the server default key. */
  key: string | null;
  scheduleType: "cron" | "interval";
  cronExpression: string;
  intervalMinutes: number;
  description: string;
  taskType: string;
  tags: string;
  priority: number;
  targetAgentId: string;
  timezone: string;
  model: string;
  modelTier: string;
  enabled: boolean;
}

export const emptyScheduleForm: ScheduleFormData = {
  name: "",
  key: null,
  ...EMPTY_SCHEDULE_TARGET,
  scheduleType: "cron",
  cronExpression: "",
  intervalMinutes: 60,
  description: "",
  taskType: "",
  tags: "",
  priority: 50,
  targetAgentId: "",
  timezone: "UTC",
  model: "",
  modelTier: "",
  enabled: true,
};

export function ScheduleDialog({
  open,
  onOpenChange,
  onSubmit,
  editData,
  initialKey = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: ScheduleFormData) => void;
  editData?: ScheduleFormData | null;
  /** The Sessions group a new schedule starts in (the use-case Overview's "New schedule"). */
  initialKey?: string | null;
}) {
  const { data: agents } = useAgents();
  const { data: modelsCatalog } = useModelsCatalog();
  const modelGroups = useMemo(
    () => modelGroupsForSchedule(modelsCatalog?.providers),
    [modelsCatalog?.providers],
  );
  const [form, setForm] = useState<ScheduleFormData>(
    editData ?? { ...emptyScheduleForm, key: initialKey },
  );
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  const { targets, writeBlock } = useMyGroups(me);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
    if (!editData) setForm({ ...emptyScheduleForm, key: initialKey });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editData ? "Edit Schedule" : "Create Schedule"}</DialogTitle>
            <DialogDescription>
              {editData ? "Update schedule configuration." : "Set up a recurring task schedule."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                placeholder="Schedule name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            {editData ? null : (
              <div className="space-y-1">
                {/* The ghost trigger's own padding: line its text up with the labels. */}
                <div className="-ml-1.5">
                  <StartInPicker
                    value={form.key}
                    label={form.key ? groupCrumb(form.key, me, () => "") : "No group"}
                    targets={targets}
                    writeBlock={writeBlock}
                    onChange={(key) => setForm({ ...form, key })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Its runs show in this Sessions group.
                </p>
              </div>
            )}
            <ScheduleTargetFields value={form} onChange={(next) => setForm({ ...form, ...next })} />
            <div className="space-y-2">
              <Label>Schedule Type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={form.scheduleType === "cron" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, scheduleType: "cron" })}
                >
                  Cron
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.scheduleType === "interval" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, scheduleType: "interval" })}
                >
                  Interval
                </Button>
              </div>
            </div>
            {form.scheduleType === "cron" ? (
              <div className="space-y-2">
                <Label>Cron Expression *</Label>
                <Input
                  placeholder="0 * * * *"
                  value={form.cronExpression}
                  onChange={(e) => setForm({ ...form, cronExpression: e.target.value })}
                  className="font-mono"
                  required={form.scheduleType === "cron"}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Interval (minutes)</Label>
                <Input
                  type="number"
                  min={1}
                  value={form.intervalMinutes}
                  onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                placeholder="Optional description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Model Tier</Label>
              <Select
                value={form.modelTier}
                onValueChange={(v) => setForm({ ...form, modelTier: v === "_none" ? "" : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">Default</SelectItem>
                  {MODEL_TIER_OPTIONS.map((tier) => (
                    <SelectItem key={tier.value} value={tier.value}>
                      {tier.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Target Agent</Label>
                <Select
                  value={form.targetAgentId}
                  onValueChange={(v) => setForm({ ...form, targetAgentId: v === "_none" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Task Pool" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">Task Pool</SelectItem>
                    {agents?.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                        {a.isLead ? " (Lead)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority (0–100)</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Task Type</Label>
                <Input
                  placeholder="e.g. code, research"
                  value={form.taskType}
                  onChange={(e) => setForm({ ...form, taskType: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Model</Label>
                <ModelCombobox
                  value={form.model}
                  onChange={(model) => setForm({ ...form, model })}
                  groups={modelGroups}
                  selected={findModelOption(form.model, modelGroups)}
                  placeholder="Default"
                  clearLabel="Default"
                  creatable
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Input
                  placeholder="UTC"
                  value={form.timezone}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Tags (comma-separated)</Label>
                <Input
                  placeholder="daily, sync"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="schedule-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
              />
              <Label htmlFor="schedule-enabled">Enabled</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-primary hover:bg-primary/90"
              disabled={!form.name.trim() || isScheduleTargetInvalid(form)}
            >
              {editData ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The create request for a filled-in schedule form. */
export function scheduleCreateInput(data: ScheduleFormData): CreateScheduleInput {
  const tags = data.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    ...(data.key && { key: data.key }),
    name: data.name,
    targetType: data.targetType,
    ...(data.targetType === "agent-task" && { taskTemplate: data.taskTemplate }),
    ...(data.targetType === "workflow" && { workflowId: data.workflowId }),
    ...(data.targetType === "script" && {
      scriptName: data.scriptName,
      scriptArgs: data.scriptArgsText.trim() ? JSON.parse(data.scriptArgsText) : undefined,
    }),
    ...(data.scheduleType === "cron"
      ? { cronExpression: data.cronExpression }
      : { intervalMs: data.intervalMinutes * 60 * 1000 }),
    ...(data.description && { description: data.description }),
    ...(data.taskType && { taskType: data.taskType }),
    ...(tags.length > 0 && { tags }),
    ...(data.priority !== 50 && { priority: data.priority }),
    ...(data.targetAgentId && { targetAgentId: data.targetAgentId }),
    ...(data.timezone !== "UTC" && { timezone: data.timezone }),
    ...(data.model && { model: data.model }),
    ...(data.modelTier && { modelTier: data.modelTier }),
    enabled: data.enabled,
  };
}
