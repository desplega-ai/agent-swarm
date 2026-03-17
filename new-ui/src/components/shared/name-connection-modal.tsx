import { Loader2 } from "lucide-react";
import { useState } from "react";
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
import { useConfig } from "@/hooks/use-config";
import { generateSlug } from "@/lib/slugs";

export function NameConnectionModal() {
  const { pendingConnection, clearPendingConnection, addConnection, switchConnection } =
    useConfig();
  const [name, setName] = useState(() => generateSlug());
  const [status, setStatus] = useState<"idle" | "saving">("idle");

  if (!pendingConnection) return null;

  async function handleSave() {
    if (!pendingConnection) return;
    setStatus("saving");
    try {
      const created = addConnection({
        name: name.trim() || generateSlug(),
        apiUrl: pendingConnection.apiUrl,
        apiKey: pendingConnection.apiKey,
      });
      switchConnection(created.id);
      clearPendingConnection();
    } finally {
      setStatus("idle");
    }
  }

  function handleSkip() {
    // Use credentials for this session only — they'll be lost on refresh
    clearPendingConnection();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && handleSkip()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Name This Connection</DialogTitle>
          <DialogDescription>
            A new connection was detected from URL parameters. Give it a name to save it for future
            sessions.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">API URL</Label>
            <p className="text-sm font-mono rounded-md bg-muted p-2 break-all">
              {pendingConnection.apiUrl}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="conn-name">Connection Name</Label>
            <Input
              id="conn-name"
              placeholder={name}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleSkip}>
            Skip
          </Button>
          <Button
            onClick={handleSave}
            disabled={status === "saving"}
            className="bg-primary hover:bg-primary/90"
          >
            {status === "saving" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save & Connect"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
