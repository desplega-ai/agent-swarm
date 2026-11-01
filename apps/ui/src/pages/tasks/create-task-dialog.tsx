import { ChevronDown, MessageSquare, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
import { ComposerDock } from "@/components/sessions/composer-dock";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { MODEL_TIER_OPTIONS } from "@/lib/model-tiers";
import { taskListTitle } from "@/lib/task-title";
import { TaskEffortField } from "./task-effort-field";

export interface TaskFormData {
  task: string;
  agentId: string;
  taskType: string;
  tags: string;
  priority: number;
  dependsOn: string[];
  modelTier: string;
  effort: string;
}

const emptyTaskForm: TaskFormData = {
  task: "",
  agentId: "",
  taskType: "",
  tags: "",
  priority: 50,
  dependsOn: [],
  modelTier: "",
  effort: "",
};

export function CreateTaskDialog({
  open,
  onOpenChange,
  onSubmit,
  initialValues,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: TaskFormData) => Promise<void>;
  isPending: boolean;
  /** Starting values from a task template, applied each time the dialog opens. */
  initialValues?: Partial<TaskFormData>;
}) {
  const { data: agents } = useAgents();
  const { data: tasksData } = useTasks({ status: "pending", limit: 200 });
  const { data: runningTasksData } = useTasks({ status: "in_progress", limit: 200 });
  const [form, setForm] = useState<TaskFormData>(() => ({ ...emptyTaskForm, ...initialValues }));
  const [depSearch, setDepSearch] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const fieldsId = useId();

  // Re-seed the form whenever the dialog transitions from closed → open. We
  // capture the latest `initialValues` via a ref so the effect doesn't fire
  // on every parent render (where callers typically pass a fresh object
  // literal). Reusing the same dialog instance across "To start" templates
  // relies on this re-seed.
  const initialValuesRef = useRef(initialValues);
  initialValuesRef.current = initialValues;
  useEffect(() => {
    if (open) {
      setForm({ ...emptyTaskForm, ...initialValuesRef.current });
      setDepSearch("");
      setAdvancedOpen(false);
      setError(null);
    }
  }, [open]);

  const leadAgent = agents?.find((a) => a.isLead) ?? agents?.[0];
  const selectedAgent = agents?.find((a) => a.id === (form.agentId || leadAgent?.id));
  const setEffort = useCallback((effort: string) => setForm((f) => ({ ...f, effort })), []);

  // Merge pending + running tasks for dependency picker
  const availableDeps = useMemo(() => {
    const all = [...(tasksData?.tasks ?? []), ...(runningTasksData?.tasks ?? [])];
    const seen = new Set<string>();
    return all.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, [tasksData, runningTasksData]);

  const filteredDeps = useMemo(() => {
    if (!depSearch) return availableDeps;
    const q = depSearch.toLowerCase();
    return availableDeps.filter(
      (t) =>
        t.task.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q),
    );
  }, [availableDeps, depSearch]);

  async function handleSubmit() {
    if (isPending || !form.task.trim()) return;
    const agentId = form.agentId || leadAgent?.id || "";
    if (!agentId) return;
    if (!Number.isInteger(form.priority) || form.priority < 0 || form.priority > 100) {
      setError("Enter a whole number from 0 to 100 for priority.");
      setAdvancedOpen(true);
      return;
    }
    setError(null);
    try {
      await onSubmit({ ...form, agentId });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the task. Try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 px-5 pt-6 pb-5 text-left sm:px-6">
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>Describe the work. Choose an agent to handle it.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 pb-5 sm:px-6">
          <ComposerDock
            value={form.task}
            onChange={(task) => setForm((current) => ({ ...current, task }))}
            onSubmit={() => void handleSubmit()}
            isPending={isPending}
            disabled={!selectedAgent}
            pendingLabel="Creating task…"
            sendLabel={isPending ? "Creating…" : "Create task"}
            showSendLabel
            inputLabel="Task description"
            placeholder="What needs to be done?"
            routeLabel=""
            fullWidth
            autoFocus
            className="p-0 bg-transparent [&_textarea]:min-h-36"
            modeControl={
              <Select
                value={form.agentId || leadAgent?.id || ""}
                onValueChange={(agentId) => setForm({ ...form, agentId, effort: "" })}
                disabled={isPending}
              >
                <SelectTrigger
                  aria-label="Assign to agent"
                  className="h-9 max-w-44 border-0 bg-transparent shadow-none dark:bg-transparent sm:max-w-64"
                >
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.isLead ? " (Lead)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          {error ? (
            <p role="alert" className="mt-3 text-sm text-status-error-strong">
              {error}
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={advancedOpen}
            aria-controls={`${fieldsId}-advanced`}
            onClick={() => setAdvancedOpen((value) => !value)}
            className="mt-3 -ml-2 text-muted-foreground"
          >
            <SlidersHorizontal className="size-3.5" />
            Advanced settings
            <ChevronDown className={advancedOpen ? "size-3.5 rotate-180" : "size-3.5"} />
          </Button>
          <div id={`${fieldsId}-advanced`}>
            <AnimatedReveal open={advancedOpen}>
              <fieldset disabled={isPending} className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`${fieldsId}-type`}>Task type</Label>
                  <Input
                    id={`${fieldsId}-type`}
                    placeholder="e.g. code, research"
                    value={form.taskType}
                    onChange={(e) => setForm({ ...form, taskType: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${fieldsId}-priority`}>Priority (0–100)</Label>
                  <Input
                    id={`${fieldsId}-priority`}
                    type="number"
                    min={0}
                    max={100}
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor={`${fieldsId}-tags`}>Tags (comma-separated)</Label>
                  <Input
                    id={`${fieldsId}-tags`}
                    placeholder="feature, urgent"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${fieldsId}-tier`}>Model tier</Label>
                  <Select
                    value={form.modelTier}
                    onValueChange={(v) => setForm({ ...form, modelTier: v === "_none" ? "" : v })}
                  >
                    <SelectTrigger id={`${fieldsId}-tier`} className="w-full">
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
                <TaskEffortField
                  agent={selectedAgent}
                  tier={form.modelTier}
                  value={form.effort}
                  onChange={setEffort}
                  enabled={open}
                />
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor={`${fieldsId}-dependencies`}>Dependencies</Label>
                  {form.dependsOn.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {form.dependsOn.map((depId) => {
                        const depTask = availableDeps.find((t) => t.id === depId);
                        return (
                          <Badge key={depId} variant="outline" size="tag" className="gap-1">
                            #{depId.slice(0, 8)}{" "}
                            {depTask ? taskListTitle(depTask).slice(0, 20) : ""}
                            <button
                              type="button"
                              aria-label={`Remove dependency ${depId.slice(0, 8)}`}
                              onClick={() =>
                                setForm({
                                  ...form,
                                  dependsOn: form.dependsOn.filter((d) => d !== depId),
                                })
                              }
                            >
                              <X className="size-3" />
                            </button>
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                  <div className="space-y-1">
                    <Input
                      id={`${fieldsId}-dependencies`}
                      placeholder="Search pending/running tasks..."
                      value={depSearch}
                      onChange={(e) => setDepSearch(e.target.value)}
                    />
                    {depSearch && filteredDeps.length > 0 && (
                      <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-popover">
                        {filteredDeps.slice(0, 10).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            disabled={form.dependsOn.includes(t.id)}
                            onClick={() => {
                              setForm({ ...form, dependsOn: [...form.dependsOn, t.id] });
                              setDepSearch("");
                            }}
                            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <StatusBadge status={t.status} />
                            <span className="truncate flex-1">{taskListTitle(t)}</span>
                            <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                              #{t.id.slice(0, 8)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </fieldset>
            </AnimatedReveal>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-1 border-t border-border-subtle bg-muted/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-6">
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => {
              const params = new URLSearchParams();
              if (form.task) params.set("seed", form.task);
              onOpenChange(false);
              void navigate(`/sessions/new${params.size ? `?${params}` : ""}`);
            }}
          >
            <MessageSquare className="size-4" />
            Start as a session
          </Button>
          <p className="text-xs text-muted-foreground">Your text opens as an unsent draft.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
