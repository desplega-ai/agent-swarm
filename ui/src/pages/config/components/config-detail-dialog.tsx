import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { SwarmConfig } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export function ConfigDetailDialog({
  config,
  onOpenChange,
  agentName,
}: {
  config: SwarmConfig | null;
  onOpenChange: (open: boolean) => void;
  agentName?: string;
}) {
  const [showValue, setShowValue] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setShowValue(config ? !config.isSecret : false);
  }, [config]);

  function handleCopy() {
    if (!config) return;
    navigator.clipboard.writeText(config.value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={!!config} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{config?.key}</DialogTitle>
          <DialogDescription>{config?.description || "No description"}</DialogDescription>
        </DialogHeader>
        {config && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" size="tag">
                {config.scope}
              </Badge>
              {config.isSecret && (
                <Badge
                  variant="outline"
                  size="tag"
                  className="border-status-active/30 text-status-active"
                >
                  secret
                </Badge>
              )}
            </div>

            {config.scope !== "global" && config.scopeId && (
              <div>
                <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                  {config.scope === "agent" ? "Agent" : "Scope ID"}
                </Label>
                <p className="text-sm mt-0.5">{agentName || `${config.scopeId.slice(0, 8)}...`}</p>
              </div>
            )}

            <div>
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">Value</Label>
              <div className="flex items-center gap-1 mt-1">
                <code className="flex-1 text-sm font-mono rounded-md bg-muted p-2 break-all select-text">
                  {showValue ? config.value : "••••••••••••••••"}
                </code>
                <div className="flex flex-col gap-1 shrink-0">
                  {config.isSecret && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setShowValue(!showValue)}
                    >
                      {showValue ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleCopy}>
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-status-success" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
