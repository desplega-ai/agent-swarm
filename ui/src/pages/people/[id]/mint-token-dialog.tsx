import { AlertTriangle, KeyRound } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useMcpUserConfig } from "@/api/hooks/use-integrations-meta";
import { useMintUserToken } from "@/api/hooks/use-users";
import type { MintTokenResponse, User } from "@/api/types";
import { CopyButton } from "@/components/shared/copy-button";
import { Badge } from "@/components/ui/badge";
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
import { buildMcpClientSnippets } from "@/lib/mcp-client-snippets";
import { cn } from "@/lib/utils";

interface MintTokenDialogProps {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MintTokenDialog({ user, open, onOpenChange }: MintTokenDialogProps) {
  const mintToken = useMintUserToken();
  const mcpConfig = useMcpUserConfig();
  const [label, setLabel] = useState("");
  const [result, setResult] = useState<MintTokenResponse | null>(null);

  const snippets = useMemo(() => {
    if (!result || !mcpConfig.data?.mcpUserUrl) return [];
    return buildMcpClientSnippets({
      serverUrl: mcpConfig.data.mcpUserUrl,
      token: result.plaintext,
    });
  }, [mcpConfig.data?.mcpUserUrl, result]);

  async function mint() {
    try {
      const minted = await mintToken.mutateAsync({
        id: user.id,
        label: label.trim() || null,
      });
      setResult(minted);
      toast.success("Token minted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mint token");
    }
  }

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setLabel("");
      setResult(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] overflow-hidden grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <DialogTitle>{result ? "MCP token minted" : "Mint MCP token"}</DialogTitle>
          <DialogDescription>
            {result
              ? "Copy the token or a client config before closing this dialog."
              : `Create a hosted MCP token for ${user.name}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-1 space-y-4">
          {!result ? (
            <div className="space-y-2">
              <Label htmlFor="mcp-token-label">Label</Label>
              <Input
                id="mcp-token-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="MacBook, Cursor, Claude Code"
                className="h-9"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Labels are operator-facing only and help identify which client should be revoked.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3 rounded-md border border-status-warning/30 bg-status-warning/10 p-3">
                <AlertTriangle className="h-4 w-4 mt-0.5 text-status-warning-strong" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-status-warning-strong">
                    This plaintext token is shown once.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    After closing this dialog, the server only stores a hash and the preview suffix.
                  </p>
                </div>
              </div>

              <SnippetBlock
                label="Plaintext token"
                description="Use this as the bearer token if your client has its own MCP config UI."
                value={result.plaintext}
                language="text"
                emphasize
              />

              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Client snippets</h3>
                  <p className="text-xs text-muted-foreground">
                    Server URL:{" "}
                    <span className="font-mono">{mcpConfig.data?.mcpUserUrl ?? "loading..."}</span>
                  </p>
                </div>
                {mcpConfig.isError && (
                  <Badge
                    variant="outline"
                    size="tag"
                    className="border-status-error/30 text-status-error-strong"
                  >
                    Config unavailable
                  </Badge>
                )}
              </div>

              <div className="grid gap-3">
                {snippets.map((snippet) => (
                  <SnippetBlock
                    key={snippet.id}
                    label={snippet.label}
                    description={snippet.description}
                    value={snippet.value}
                    language={snippet.language}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <Button onClick={() => close(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button onClick={mint} disabled={mintToken.isPending}>
                <KeyRound className="h-3.5 w-3.5 mr-1.5" />
                {mintToken.isPending ? "Minting..." : "Mint token"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SnippetBlock({
  label,
  description,
  value,
  language,
  emphasize,
}: {
  label: string;
  description: string;
  value: string;
  language: string;
  emphasize?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{label}</p>
            <Badge variant="outline" size="tag" className="uppercase text-[10px]">
              {language}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className={cn("relative bg-muted/35", emphasize && "bg-status-active/10")}>
        <CopyButton value={value} ariaLabel={`Copy ${label}`} />
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words p-3 pr-11 text-xs font-mono leading-relaxed">
          {value}
        </pre>
      </div>
    </div>
  );
}
