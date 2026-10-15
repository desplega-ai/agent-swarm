import { Braces, Check, Copy, Eye, EyeOff, Pencil } from "lucide-react";
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
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { parseJsonContainer, prettyJson } from "@/lib/json-value";

export function ConfigDetailDialog({
  config,
  onOpenChange,
  agentName,
  onEdit,
}: {
  config: SwarmConfig | null;
  onOpenChange: (open: boolean) => void;
  agentName?: string;
  /** Opens the entry dialog on this config. */
  onEdit?: (config: SwarmConfig) => void;
}) {
  const [showValue, setShowValue] = useState(false);
  // JSON values open formatted; the raw view is one click away.
  const [pretty, setPretty] = useState(true);
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    setShowValue(config ? !config.isSecret : false);
    setPretty(true);
  }, [config]);

  const isJson = config !== null && parseJsonContainer(config.value) !== undefined;
  let shown = "••••••••••••••••";
  if (config && showValue) shown = isJson && pretty ? prettyJson(config.value) : config.value;

  return (
    <Dialog open={!!config} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
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
                  className="border-status-active/30 text-status-active-strong"
                >
                  secret
                </Badge>
              )}
              {!config.exportToEnv && (
                <Badge variant="outline" size="tag">
                  not in agent env
                </Badge>
              )}
              {onEdit && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => onEdit(config)}
                >
                  <Pencil />
                  Edit
                </Button>
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
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                  Value
                </Label>
                {isJson && showValue && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setPretty((prev) => !prev)}
                  >
                    <Braces />
                    {pretty ? "Raw" : "Formatted"}
                  </Button>
                )}
              </div>
              <div className="flex items-start gap-1 mt-1">
                <pre className="flex-1 max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-sm font-mono whitespace-pre-wrap break-all select-text">
                  {shown}
                </pre>
                <div className="flex flex-col gap-1 shrink-0">
                  {config.isSecret && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setShowValue(!showValue)}
                      aria-label={showValue ? "Hide value" : "Show value"}
                    >
                      {showValue ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    // The stored (compact) value, whatever the view shows.
                    onClick={() => void copy(config.value)}
                    aria-label={copied ? "Copied" : "Copy value"}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-status-success-strong" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
              {isJson && (
                <p className="mt-1 text-xs text-muted-foreground">
                  JSON value. Stored on one line; Copy copies the stored value.
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
