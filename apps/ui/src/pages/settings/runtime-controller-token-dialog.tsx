import { AlertCircle, AlertTriangle, Check, Copy, KeyRound } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useMintRuntimeControllerToken } from "@/api/hooks/use-runtime-pools";
import type { RuntimeController, RuntimeControllerToken } from "@/api/types";
import { CopyableField } from "@/components/shared/copyable-fields";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { getConfig } from "@/lib/config";

/** The controller CLI reads its token from this env var, never from a flag. */
const TOKEN_ENV = "AGENT_SWARM_CONTROLLER_TOKEN";

function controllerCommand(controller: RuntimeController, token: string): string {
  const apiUrl = getConfig().apiUrl.replace(/\/+$/, "");
  return [
    // Safe unescaped in single quotes: mintControllerToken -> insertSessionToken
    // (src/be/users.ts) builds "aseph_" + base62, so only [A-Za-z0-9_].
    `export ${TOKEN_ENV}='${token}'`,
    `agent-swarm controller --api-url ${apiUrl} --kind ${controller.kind}`,
  ].join("\n");
}

/**
 * Mint a token for a remote controller. Step 1 confirms (the old token is
 * revoked). Step 2 shows the plaintext once. The token lives only in this
 * component's state: the parent unmounts it on close, so closing drops it.
 */
export function RuntimeControllerTokenDialog({
  controller,
  onClose,
}: {
  controller: RuntimeController;
  onClose: () => void;
}) {
  const mint = useMintRuntimeControllerToken();
  const [token, setToken] = useState<RuntimeControllerToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();
  const command = useMemo(
    () => (token ? controllerCommand(controller, token.plaintext) : null),
    [controller, token],
  );

  function copyFailed() {
    toast.error("Copy failed. Select the text and copy it by hand.");
  }

  function submit() {
    setError(null);
    mint.mutate(controller.id, {
      onSuccess: (minted) => {
        setToken(minted);
        // Keep the plaintext out of the mutation state too.
        mint.reset();
      },
      onError: (err) => setError(err.message),
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        // The token cannot be shown again: only Done or the X button close it.
        onPointerDownOutside={(event) => {
          if (token) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (token) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {token ? `Token for ${controller.name}` : `Mint token for ${controller.name}?`}
          </DialogTitle>
          <DialogDescription>
            {token
              ? "Copy the token or the command before you close this dialog."
              : "A new token revokes the current one. A controller that runs with the old token disconnects."}
          </DialogDescription>
        </DialogHeader>

        {token && command ? (
          <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
            <AlertCallout tone="warning" icon={AlertTriangle}>
              This token is shown once. It expires {new Date(token.expiresAt).toLocaleString()}.
            </AlertCallout>
            <CopyableField
              label="Controller token"
              value={token.plaintext}
              onCopyError={copyFailed}
            />
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                Run the controller
              </Label>
              <div className="relative rounded-md border border-border bg-muted/35">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="absolute top-1.5 right-1.5 h-7 w-7"
                  aria-label={copied ? "Copied" : "Copy command"}
                  onClick={async () => {
                    if (!(await copy(command))) copyFailed();
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
                <pre className="overflow-x-auto whitespace-pre p-3 pr-11 font-mono text-xs leading-relaxed">
                  {command}
                </pre>
              </div>
              <p className="text-xs text-muted-foreground">
                The token goes in the {TOKEN_ENV} environment variable, never in a flag.
              </p>
            </div>
          </div>
        ) : error ? (
          <AlertCallout tone="error" icon={AlertCircle}>
            {error}
          </AlertCallout>
        ) : null}

        <DialogFooter>
          {token ? (
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" onClick={submit} disabled={mint.isPending}>
                <KeyRound className="h-3.5 w-3.5" />
                {mint.isPending ? "Minting…" : "Mint token"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
