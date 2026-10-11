import { AlertCircle, AlertTriangle, KeyRound } from "lucide-react";
import { useState } from "react";
import { useMintRuntimeControllerToken } from "@/api/hooks/use-runtime-pools";
import type { RuntimeController, RuntimeControllerToken } from "@/api/types";
import { CopyButton } from "@/components/shared/copy-button";
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
import { getConfig } from "@/lib/config";

/** The controller CLI reads its token from this env var, never from a flag. */
const TOKEN_ENV = "AGENT_SWARM_CONTROLLER_TOKEN";

function controllerCommand(controller: RuntimeController, token: string): string {
  const apiUrl = getConfig().apiUrl.replace(/\/+$/, "");
  return [
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
      <DialogContent className="sm:max-w-2xl">
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

        {token ? (
          <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
            <AlertCallout tone="warning" icon={AlertTriangle}>
              This token is shown once. It expires {new Date(token.expiresAt).toLocaleString()}.
            </AlertCallout>
            <CopyableField label="Controller token" value={token.plaintext} />
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                Run the controller
              </Label>
              <div className="relative rounded-md border border-border bg-muted/35">
                <CopyButton
                  value={controllerCommand(controller, token.plaintext)}
                  ariaLabel="Copy command"
                />
                <pre className="overflow-x-auto whitespace-pre p-3 pr-11 font-mono text-xs leading-relaxed">
                  {controllerCommand(controller, token.plaintext)}
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
