import { KeyRound, Plus, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useRevokeUserToken } from "@/api/hooks/use-users";
import type { User, UserToken } from "@/api/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/relative-time";
import { formatSmartTime } from "@/lib/utils";
import { MintTokenDialog } from "./mint-token-dialog";

export function TokensTable({ user }: { user: User }) {
  const revokeToken = useRevokeUserToken();
  const [mintOpen, setMintOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<UserToken | null>(null);
  const tokens = useMemo(
    () => [...(user.tokens ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [user.tokens],
  );
  const activeCount = tokens.filter((t) => !t.revokedAt).length;

  async function revoke() {
    if (!pendingRevoke) return;
    try {
      await revokeToken.mutateAsync({ id: user.id, tokenId: pendingRevoke.id });
      toast.success("Token revoked");
      setPendingRevoke(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke token");
    }
  }

  return (
    <>
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">MCP tokens</h2>
              <p className="text-xs text-muted-foreground">
                Hosted client access for this user. Plaintext tokens are only shown at mint time.
              </p>
            </div>
            <Button size="sm" onClick={() => setMintOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Mint token
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="outline" size="tag">
              {activeCount} active
            </Badge>
            <Badge variant="outline" size="tag">
              {tokens.length} total
            </Badge>
          </div>

          {tokens.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-8 text-center">
              <KeyRound className="mx-auto h-6 w-6 text-muted-foreground/60" />
              <p className="mt-2 text-sm font-medium">No MCP tokens</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Mint one to connect this person from Claude Code, Cursor, VS Code, or another MCP
                client.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.label || "Unlabeled"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      aswt_...{token.tokenPreview}
                    </TableCell>
                    <TableCell>
                      <TimeCell value={token.createdAt} />
                    </TableCell>
                    <TableCell>
                      {token.lastUsedAt ? (
                        <TimeCell value={token.lastUsedAt} />
                      ) : (
                        <span className="text-muted-foreground/70">Never</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {token.revokedAt ? (
                        <Badge
                          variant="outline"
                          size="tag"
                          className="border-status-error/30 text-status-error-strong"
                        >
                          Revoked
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          size="tag"
                          className="border-status-active/30 text-status-active-strong"
                        >
                          Active
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!!token.revokedAt}
                        onClick={() => setPendingRevoke(token)}
                      >
                        <ShieldOff className="h-3.5 w-3.5 mr-1.5" />
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <MintTokenDialog user={user} open={mintOpen} onOpenChange={setMintOpen} />

      <AlertDialog open={!!pendingRevoke} onOpenChange={(open) => !open && setPendingRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke MCP token?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately blocks future `/mcp-user` requests for{" "}
              <span className="font-mono">aswt_...{pendingRevoke?.tokenPreview}</span>. Existing
              sessions revalidate on the next request.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={revoke}
              disabled={revokeToken.isPending}
            >
              {revokeToken.isPending ? "Revoking..." : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TimeCell({ value }: { value: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{formatRelative(value)}</span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[10px]">{formatSmartTime(value)}</TooltipContent>
    </Tooltip>
  );
}
