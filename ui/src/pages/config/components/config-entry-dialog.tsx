import { useState } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import type { SwarmConfig, SwarmConfigScope } from "@/api/types";
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
import { type ConfigFormData, emptyConfigForm } from "@/hooks/use-swarm-config";

export function ConfigEntryDialog({
  open,
  onOpenChange,
  editEntry,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editEntry: SwarmConfig | null;
  onSubmit: (data: ConfigFormData) => void;
}) {
  const { data: agents } = useAgents();
  const [form, setForm] = useState<ConfigFormData>(() =>
    editEntry
      ? {
          scope: editEntry.scope,
          scopeId: editEntry.scopeId ?? "",
          key: editEntry.key,
          value: editEntry.isSecret ? "" : editEntry.value,
          isSecret: editEntry.isSecret,
          description: editEntry.description ?? "",
        }
      : emptyConfigForm,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editEntry ? "Edit Config Entry" : "Add Config Entry"}</DialogTitle>
            <DialogDescription>
              {editEntry ? "Update configuration entry." : "Add a new configuration entry."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Scope</Label>
              <Select
                value={form.scope}
                onValueChange={(v) =>
                  setForm({ ...form, scope: v as SwarmConfigScope, scopeId: "" })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="repo">Repo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.scope === "agent" && (
              <div className="space-y-2">
                <Label>Agent</Label>
                {agents && agents.length > 0 ? (
                  <Select
                    value={form.scopeId}
                    onValueChange={(v) => setForm({ ...form, scopeId: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select agent..." />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          <span>{a.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground font-mono">
                            {a.id.slice(0, 8)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    placeholder="Agent UUID"
                    value={form.scopeId}
                    onChange={(e) => setForm({ ...form, scopeId: e.target.value })}
                  />
                )}
              </div>
            )}
            {form.scope === "repo" && (
              <div className="space-y-2">
                <Label>Scope ID</Label>
                <Input
                  placeholder="Repo UUID"
                  value={form.scopeId}
                  onChange={(e) => setForm({ ...form, scopeId: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Key</Label>
              <Input
                placeholder="CONFIG_KEY"
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Value</Label>
              <Input
                type={form.isSecret ? "password" : "text"}
                placeholder="config value"
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Input
                placeholder="What this config does"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="config-secret"
                checked={form.isSecret}
                onCheckedChange={(checked) => setForm({ ...form, isSecret: checked })}
              />
              <Label htmlFor="config-secret">Secret value</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="bg-primary hover:bg-primary/90">
              {editEntry ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
