import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { RuntimePoolApiError } from "@/api/client";
import { useCreateRuntimePoolAgent, useDeleteRuntimePool } from "@/api/hooks/use-runtime-pools";
import type { ProviderName, RuntimePool } from "@/api/types";
import { AlertCallout } from "@/components/ui/alert-callout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import { Switch } from "@/components/ui/switch";
import { HARNESS_LABEL, LOCAL_HARNESSES } from "@/lib/agent-runtime-models";
import { NumberField, optionalInt } from "./runtime-pool-fields";
import { RUNTIME_POOLS_PATH } from "./runtime-pools-shared";

export function CreateAgentDialog({
  poolId,
  open,
  onOpenChange,
}: {
  poolId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateRuntimePoolAgent(poolId);
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<ProviderName | "default">("default");
  const [maxTasks, setMaxTasks] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [isLead, setIsLead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maxTasksValue = optionalInt(maxTasks, 1);
  const maxTasksInvalid = maxTasksValue === undefined || (maxTasksValue ?? 0) > 100;

  function reset() {
    setName("");
    setHarness("default");
    setMaxTasks("");
    setTemplateId("");
    setIsLead(false);
    setError(null);
  }

  /** Every way out (Cancel, Escape, overlay, success) clears the draft. */
  function close() {
    reset();
    onOpenChange(false);
  }

  function submit() {
    if (!name.trim() || maxTasksInvalid) return;
    setError(null);
    create.mutate(
      {
        name: name.trim(),
        ...(isLead ? { isLead: true } : {}),
        ...(harness !== "default" ? { harnessProvider: harness } : {}),
        ...(typeof maxTasksValue === "number" ? { maxTasks: maxTasksValue } : {}),
        ...(templateId.trim() ? { templateId: templateId.trim() } : {}),
      },
      {
        onSuccess: (agent) => {
          toast.success(`Created ${agent.name}`);
          close();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create agent on this pool</DialogTitle>
          <DialogDescription>
            The agent starts offline. It comes online when the pool starts a runtime for it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <SettingsRow label="Name" htmlFor="pool-agent-name" required>
            <Input
              id="pool-agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </SettingsRow>
          <SettingsRow label="Harness" htmlFor="pool-agent-harness">
            <Select
              value={harness}
              onValueChange={(v) => setHarness(v as ProviderName | "default")}
            >
              <SelectTrigger id="pool-agent-harness" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Swarm default</SelectItem>
                {LOCAL_HARNESSES.map((h) => (
                  <SelectItem key={h} value={h}>
                    {HARNESS_LABEL[h]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <NumberField
            id="pool-agent-max-tasks"
            label="Max tasks"
            value={maxTasks}
            onChange={setMaxTasks}
            error={
              maxTasksInvalid ? "Enter a whole number from 1 to 100, or leave blank." : undefined
            }
            helper="Blank uses the default."
          />
          <SettingsRow
            label="Template ID"
            htmlFor="pool-agent-template"
            helper="Optional. The agent template to start from."
          >
            <Input
              id="pool-agent-template"
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
              className="font-mono"
            />
          </SettingsRow>
          <SettingsRow label="Lead" htmlFor="pool-agent-lead" helper="A swarm has one lead.">
            <Switch id="pool-agent-lead" checked={isLead} onCheckedChange={setIsLead} />
          </SettingsRow>
          {error ? (
            <AlertCallout tone="error" icon={AlertCircle}>
              {error}
            </AlertCallout>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || maxTasksInvalid || create.isPending}>
              {create.isPending ? "Creating…" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeletePoolDialog({
  pool,
  open,
  onOpenChange,
}: {
  pool: RuntimePool;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const remove = useDeleteRuntimePool(pool.id);
  // A 409 can require runtime teardown or forced unbinding.
  const [needsForce, setNeedsForce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    remove.mutate(needsForce, {
      onSuccess: () => {
        toast.success(`Deleted ${pool.name}`);
        onOpenChange(false);
        void navigate(RUNTIME_POOLS_PATH);
      },
      onError: (err) => {
        if (err instanceof RuntimePoolApiError && err.status === 409 && !needsForce) {
          setNeedsForce(true);
          return;
        }
        setError(err.message);
      },
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setNeedsForce(false);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {needsForce ? `${pool.name} requires teardown or unbinding` : `Delete ${pool.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {needsForce
              ? "Force delete only unbinds agents after every runtime is offline. Scale to zero or disable the pool and wait before deleting."
              : "Deleting requires every runtime to be offline. Disable the pool and wait for teardown. Bound agents require a forced delete."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <AlertCallout tone="error" icon={AlertCircle}>
            {error}
          </AlertCallout>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={(event) => {
              // Keep the dialog open until the server answers.
              event.preventDefault();
              confirm();
            }}
          >
            {remove.isPending ? "Deleting…" : needsForce ? "Force delete" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
