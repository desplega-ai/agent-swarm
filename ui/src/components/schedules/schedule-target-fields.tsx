import { useScripts } from "@/api/hooks/use-scripts";
import { useWorkflows } from "@/api/hooks/use-workflows";
import type { ScheduledTaskTargetType } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export interface ScheduleTargetFormValue {
  targetType: ScheduledTaskTargetType;
  taskTemplate: string;
  workflowId: string;
  scriptName: string;
  scriptArgsText: string;
}

export const EMPTY_SCHEDULE_TARGET: ScheduleTargetFormValue = {
  targetType: "agent-task",
  taskTemplate: "",
  workflowId: "",
  scriptName: "",
  scriptArgsText: "{}",
};

const TARGET_TYPE_OPTIONS: { value: ScheduledTaskTargetType; label: string }[] = [
  { value: "agent-task", label: "Agent Task" },
  { value: "workflow", label: "Workflow" },
  { value: "script", label: "Script" },
];

/** Returns null when scriptArgsText is empty/valid JSON; an error string otherwise. */
export function validateScriptArgsText(text: string): string | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch {
    return "Script args must be valid JSON (or left empty).";
  }
}

/**
 * Execution-type selector + conditional target fields, shared by the schedule
 * create and edit dialogs. Owns targetType, taskTemplate (agent-task),
 * workflowId (workflow), and scriptName/scriptArgs (script) — the parent form
 * keeps everything else (model, priority, timezone, ...).
 */
export function ScheduleTargetFields({
  value,
  onChange,
}: {
  value: ScheduleTargetFormValue;
  onChange: (next: ScheduleTargetFormValue) => void;
}) {
  const { data: workflows } = useWorkflows();
  const { data: scripts } = useScripts({ scope: "global" });
  const scriptArgsError =
    value.targetType === "script" ? validateScriptArgsText(value.scriptArgsText) : null;

  return (
    <>
      <div className="space-y-2">
        <Label>Execution Type</Label>
        <div className="flex gap-2">
          {TARGET_TYPE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              type="button"
              size="sm"
              variant={value.targetType === opt.value ? "default" : "outline"}
              onClick={() => onChange({ ...value, targetType: opt.value })}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {value.targetType === "agent-task" && (
        <div className="space-y-2">
          <Label>Task Template *</Label>
          <Textarea
            placeholder="Task description template..."
            value={value.taskTemplate}
            onChange={(e) => onChange({ ...value, taskTemplate: e.target.value })}
            required
            rows={3}
          />
        </div>
      )}

      {value.targetType === "workflow" && (
        <div className="space-y-2">
          <Label>Workflow *</Label>
          <Select
            value={value.workflowId}
            onValueChange={(v) => onChange({ ...value, workflowId: v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a workflow" />
            </SelectTrigger>
            <SelectContent>
              {workflows?.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            The workflow runs directly on schedule — no agent task is created.
          </p>
        </div>
      )}

      {value.targetType === "script" && (
        <>
          <div className="space-y-2">
            <Label>Script *</Label>
            <Select
              value={value.scriptName}
              onValueChange={(v) => onChange({ ...value, scriptName: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a global script" />
              </SelectTrigger>
              <SelectContent>
                {scripts?.map((s) => (
                  <SelectItem key={s.id} value={s.name}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Script Args (JSON)</Label>
            <Textarea
              placeholder="{}"
              value={value.scriptArgsText}
              onChange={(e) => onChange({ ...value, scriptArgsText: e.target.value })}
              rows={3}
              className="font-mono text-xs"
            />
            {scriptArgsError && <p className="text-xs text-destructive">{scriptArgsError}</p>}
          </div>
          <p className="text-xs text-muted-foreground">
            The script runs directly on schedule — no agent task is created.
          </p>
        </>
      )}
    </>
  );
}

/** Shared submit-disable check across the create + edit dialogs. */
export function isScheduleTargetInvalid(value: ScheduleTargetFormValue): boolean {
  switch (value.targetType) {
    case "agent-task":
      return !value.taskTemplate.trim();
    case "workflow":
      return !value.workflowId;
    case "script":
      return !value.scriptName || !!validateScriptArgsText(value.scriptArgsText);
    default:
      return false;
  }
}
