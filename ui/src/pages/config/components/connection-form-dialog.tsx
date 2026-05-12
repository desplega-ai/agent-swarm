import { Eye, EyeOff, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import type { ConnectionFormData } from "@/hooks/use-connections";
import type { Connection } from "@/lib/config";
import { generateSlug } from "@/lib/slugs";

export function ConnectionFormDialog({
  open,
  onOpenChange,
  editConnection,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editConnection: Connection | null;
  onSubmit: (data: ConnectionFormData) => void;
}) {
  const [form, setForm] = useState<ConnectionFormData>(() =>
    editConnection
      ? { name: editConnection.name, apiUrl: editConnection.apiUrl, apiKey: editConnection.apiKey }
      : { name: "", apiUrl: "http://localhost:3013", apiKey: "" },
  );
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [placeholder] = useState(() => generateSlug());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setErrorMsg("");

    try {
      const url = form.apiUrl.replace(/\/+$/, "");
      const res = await fetch(`${url}/health`, {
        headers: form.apiKey ? { Authorization: `Bearer ${form.apiKey}` } : {},
      });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      await res.json();
      onSubmit({ ...form, name: form.name || placeholder, apiUrl: url });
      onOpenChange(false);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Connection failed");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editConnection ? "Edit Connection" : "Add Connection"}</DialogTitle>
            <DialogDescription>
              {editConnection
                ? "Update connection settings. A health check will run on save."
                : "Add a new API server connection. A health check will verify the connection."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="conn-name">Name (optional)</Label>
              <Input
                id="conn-name"
                placeholder={placeholder}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-url">API URL</Label>
              <Input
                id="conn-url"
                type="url"
                placeholder="http://localhost:3013"
                value={form.apiUrl}
                onChange={(e) => setForm({ ...form, apiUrl: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-key">API Key</Label>
              <div className="flex gap-1">
                <Input
                  id="conn-key"
                  type={showKey ? "text" : "password"}
                  placeholder="Enter your API key"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  required
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            {status === "error" && (
              <Alert variant="destructive">
                <XCircle className="h-4 w-4" />
                <AlertDescription>{errorMsg}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={status === "loading" || !form.apiUrl || !form.apiKey}
              className="bg-primary hover:bg-primary/90"
            >
              {status === "loading" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Checking...
                </>
              ) : editConnection ? (
                "Save"
              ) : (
                "Connect"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
