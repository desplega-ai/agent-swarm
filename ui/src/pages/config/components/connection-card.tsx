import { CheckCircle2, Loader2, Pencil, Signal, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Connection } from "@/lib/config";

export function ConnectionCard({
  connection,
  isActive,
  onActivate,
  onEdit,
  onDelete,
}: {
  connection: Connection;
  isActive: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [testStatus, setTestStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  async function handleTest() {
    setTestStatus("loading");
    try {
      const url = connection.apiUrl.replace(/\/+$/, "");
      const res = await fetch(`${url}/health`, {
        headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      });
      if (!res.ok) throw new Error();
      await res.json();
      setTestStatus("success");
      setTimeout(() => setTestStatus("idle"), 3000);
    } catch {
      setTestStatus("error");
      setTimeout(() => setTestStatus("idle"), 3000);
    }
  }

  return (
    <Card className={`border-border ${isActive ? "ring-1 ring-primary/50 border-primary/30" : ""}`}>
      <CardContent className="flex items-center gap-4 py-4">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{connection.name}</span>
            {isActive && (
              <Badge variant="outline" size="tag" className="border-primary/30 text-primary">
                active
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground font-mono truncate">{connection.apiUrl}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={isActive ? handleTest : onActivate}
            disabled={testStatus === "loading"}
          >
            {testStatus === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : testStatus === "success" ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-status-success" />
            ) : testStatus === "error" ? (
              <XCircle className="h-3.5 w-3.5 text-status-error" />
            ) : (
              <Signal className="h-3.5 w-3.5" />
            )}
            {isActive ? "Test" : "Connect"}
          </Button>

          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8 border-border/60"
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>

          <Button size="icon" variant="destructive-outline" className="h-8 w-8" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
