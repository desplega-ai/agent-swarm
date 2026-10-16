import { Braces } from "lucide-react";
import { useState } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import type { SwarmConfig, SwarmConfigScope } from "@/api/types";
import { SecretInput } from "@/components/shared/secret-input";
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
import { Textarea } from "@/components/ui/textarea";
import { type ConfigFormData, emptyConfigForm } from "@/hooks/use-swarm-config";
import { compactJson, parseJsonContainer, prettyJson } from "@/lib/json-value";
import { isEnvExportRestrictedKey } from "../../../../../../src/utils/config-env-export";

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
          // The stored value, secrets included (masked until revealed), so an
          // edit starts from what is there. A JSON value opens formatted.
          value: editEntry.isSecret ? editEntry.value : prettyJson(editEntry.value),
          isSecret: editEntry.isSecret,
          description: editEntry.description ?? "",
          exportToEnv: editEntry.exportToEnv,
        }
      : emptyConfigForm,
  );
  const exportRestricted = isEnvExportRestrictedKey(form.key);
  // A JSON object or array is edited in a text area (formatted or raw) and
  // stored on one line. The editor stays a text area while the text is being
  // edited, even when it does not parse for a moment.
  const isJson = parseJsonContainer(form.value) !== undefined;
  const [jsonEditor, setJsonEditor] = useState(isJson);
  const [pretty, setPretty] = useState(isJson);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = compactJson(form.value);
    const data = { ...form, value };
    onSubmit(exportRestricted ? { ...data, exportToEnv: false } : data);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
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
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="config-value">Value</Label>
                {jsonEditor && !form.isSecret && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    disabled={!isJson}
                    title={isJson ? undefined : "Not valid JSON yet"}
                    onClick={() => {
                      setForm({
                        ...form,
                        value: pretty ? compactJson(form.value) : prettyJson(form.value),
                      });
                      setPretty((prev) => !prev);
                    }}
                  >
                    <Braces />
                    {pretty ? "Raw" : "Formatted"}
                  </Button>
                )}
              </div>
              {form.isSecret ? (
                <SecretInput
                  id="config-value"
                  placeholder="config value"
                  value={form.value}
                  onChange={(value) => setForm({ ...form, value })}
                  autoComplete="new-password"
                  required
                />
              ) : jsonEditor ? (
                <Textarea
                  id="config-value"
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  spellCheck={false}
                  className="max-h-[50vh] min-h-32 font-mono text-xs"
                  required
                />
              ) : (
                <Input
                  id="config-value"
                  placeholder="config value"
                  value={form.value}
                  onChange={(e) => {
                    const value = e.target.value;
                    // Pasted JSON moves to the text area, formatted.
                    const json = parseJsonContainer(value) !== undefined;
                    setForm({ ...form, value: json ? prettyJson(value) : value });
                    if (json) {
                      setJsonEditor(true);
                      setPretty(true);
                    }
                  }}
                  required
                />
              )}
              {jsonEditor && !form.isSecret && (
                <p className="text-xs text-muted-foreground">
                  JSON value. Saved compacted on one line, whichever view you edit in.
                </p>
              )}
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
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Switch
                  id="config-export-to-env"
                  checked={form.exportToEnv && !exportRestricted}
                  disabled={exportRestricted}
                  onCheckedChange={(checked) => setForm({ ...form, exportToEnv: checked })}
                />
                <Label htmlFor="config-export-to-env">Export to agent env</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                {exportRestricted
                  ? "Only the API server reads this key, so it never reaches agent shells."
                  : form.exportToEnv
                    ? "Agent shells see this value in their environment."
                    : "Kept out of agent shells. Agents use it through a connection or script credential binding."}
              </p>
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
