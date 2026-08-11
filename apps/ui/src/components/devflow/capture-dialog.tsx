import { useState } from "react";
import type { DevFlowWorkItemType } from "@/api/devflow-types";
import { useCreateDevFlowWorkItem } from "@/api/hooks/use-devflow";
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
import { Textarea } from "@/components/ui/textarea";

export function CaptureDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createItem = useCreateDevFlowWorkItem();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<DevFlowWorkItemType>("idea");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    createItem.mutate(
      { title: title.trim(), description: description.trim(), type },
      {
        onSuccess: () => {
          setTitle("");
          setDescription("");
          setType("idea");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Capture an idea</DialogTitle>
            <DialogDescription>
              Record the raw signal first. The intake agent will normalize it without changing
              approval gates.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-5">
            <SettingsRow label="Title" htmlFor="devflow-title">
              <Input
                id="devflow-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What should change?"
                required
              />
            </SettingsRow>
            <SettingsRow label="Raw request" htmlFor="devflow-description">
              <Textarea
                id="devflow-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Include the user, problem, evidence, and constraints you already know."
                rows={6}
                required
              />
            </SettingsRow>
            <SettingsRow label="Initial type" htmlFor="devflow-type">
              <Select value={type} onValueChange={(value) => setType(value as DevFlowWorkItemType)}>
                <SelectTrigger id="devflow-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["idea", "feature", "bug", "task", "architecture", "ops"] as const).map(
                    (value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </SettingsRow>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || !description.trim() || createItem.isPending}
            >
              {createItem.isPending ? "Capturing…" : "Capture idea"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
