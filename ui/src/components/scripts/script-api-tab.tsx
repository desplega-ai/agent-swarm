import { Globe, KeyRound, Plus, RotateCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import {
  useCreateScriptApi,
  useDeleteScriptApi,
  useRotateScriptApiSecret,
  useScriptApis,
  useUpdateScriptApi,
} from "@/api/hooks/use-script-apis";
import type { ScriptApiAuthMode, ScriptApiRecord } from "@/api/types";
import { CopyableField, CopyIconButton, SecretField } from "@/components/shared/copyable-fields";
import { EmptyState } from "@/components/shared/empty-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { getConfig } from "@/lib/config";
import { formatSmartTime } from "@/lib/utils";

function buildCurl(url: string, authMode: ScriptApiAuthMode, token: string | null): string {
  const lines = [`curl -X POST ${url} \\`, "  -H 'Content-Type: application/json' \\"];
  if (authMode === "bearer") {
    lines.push(`  -H 'Authorization: Bearer ${token ?? "<token>"}' \\`);
  }
  lines.push("  -d '{}'");
  return lines.join("\n");
}

function EndpointCard({ scriptId, endpoint }: { scriptId: string; endpoint: ScriptApiRecord }) {
  const apiUrl = getConfig().apiUrl.replace(/\/$/, "");
  const url = `${apiUrl}/api/x/script/${endpoint.id}`;
  const [token, setToken] = useState<string | null>(null);
  const update = useUpdateScriptApi(scriptId);
  const rotate = useRotateScriptApiSecret(scriptId);
  const del = useDeleteScriptApi(scriptId);

  async function reveal() {
    try {
      setToken(await api.revealScriptApiSecret(scriptId, endpoint.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reveal token");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="truncate text-sm">{endpoint.label || "Endpoint"}</CardTitle>
          <Badge variant="outline" size="tag">
            {endpoint.authMode}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {endpoint.enabled ? "Enabled" : "Disabled"}
          </span>
          <Switch
            checked={endpoint.enabled}
            onCheckedChange={(checked) =>
              update.mutate(
                { endpointId: endpoint.id, data: { enabled: checked } },
                { onError: () => toast.error("Failed to update endpoint") },
              )
            }
          />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive-outline" size="icon" aria-label="Delete endpoint">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this endpoint?</AlertDialogTitle>
                <AlertDialogDescription>
                  The public URL will stop working immediately. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => del.mutate(endpoint.id)}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <CopyableField label="POST URL" value={url} />

        {endpoint.authMode === "bearer" &&
          (token === null ? (
            <Button variant="outline" size="sm" onClick={reveal}>
              <KeyRound className="mr-1.5 h-3.5 w-3.5" /> Reveal token
            </Button>
          ) : (
            <div className="space-y-2">
              <SecretField label="Bearer token" value={token} />
              <Button
                variant="outline"
                size="sm"
                disabled={rotate.isPending}
                onClick={async () => {
                  try {
                    const res = await rotate.mutateAsync(endpoint.id);
                    setToken(res.token);
                    toast.success("Token rotated");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Failed to rotate token");
                  }
                }}
              >
                <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Rotate
              </Button>
            </div>
          ))}

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">curl</Label>
          <div className="relative rounded-md border bg-muted/50 p-3">
            <div className="absolute right-2 top-2">
              <CopyIconButton value={buildCurl(url, endpoint.authMode, token)} />
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
              {buildCurl(url, endpoint.authMode, token)}
            </pre>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>
            {endpoint.callCount} call{endpoint.callCount === 1 ? "" : "s"}
          </span>
          <span>
            Last used: {endpoint.lastUsedAt ? formatSmartTime(endpoint.lastUsedAt) : "never"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function ScriptApiTab({ scriptId }: { scriptId: string }) {
  const { data: apis, isLoading } = useScriptApis(scriptId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [authMode, setAuthMode] = useState<ScriptApiAuthMode>("bearer");
  const [label, setLabel] = useState("");
  const create = useCreateScriptApi(scriptId);

  async function handleCreate() {
    try {
      await create.mutateAsync({ authMode, label: label.trim() || undefined });
      toast.success("Endpoint created");
      setDialogOpen(false);
      setLabel("");
      setAuthMode("bearer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create endpoint");
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4 overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Expose this script as a public{" "}
          <code className="font-mono">POST /api/x/script/&lt;id&gt;</code> endpoint. Calls run the
          script synchronously and return a JSON envelope{" "}
          <code className="font-mono">{"{ ok, result, error, durationMs }"}</code>.
        </p>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="shrink-0">
              <Plus className="mr-1.5 h-3.5 w-3.5" /> New endpoint
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New API endpoint</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="api-auth-mode">Authentication</Label>
                <Select
                  value={authMode}
                  onValueChange={(value) => setAuthMode(value as ScriptApiAuthMode)}
                >
                  <SelectTrigger id="api-auth-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bearer">Bearer token (auto-generated)</SelectItem>
                    <SelectItem value="none">None (public)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="api-label">Label (optional)</Label>
                <Input
                  id="api-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. public demo"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={create.isPending}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !apis || apis.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No API endpoints"
          description="Create an endpoint to call this script over HTTP."
        />
      ) : (
        <div className="space-y-3">
          {apis.map((endpoint) => (
            <EndpointCard key={endpoint.id} scriptId={scriptId} endpoint={endpoint} />
          ))}
        </div>
      )}
    </div>
  );
}
