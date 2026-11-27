import { useSearchParams } from "react-router-dom";
import { ConnectCard } from "@/components/comb/connect-card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * A chromeless app inside another page's iframe. The browser partitions
 * storage there, so an agent-fs key saved in the frame does not persist:
 * link to the dashboard instead of connecting.
 */
export function useEmbeddedFrame(): boolean {
  const [searchParams] = useSearchParams();
  return searchParams.get("mode") === "chromeless" && window.self !== window.top;
}

/**
 * Comb's connect flow in a dialog. Connecting changes the agent-fs state,
 * which unmounts the caller's not-connected prompt and this dialog with it.
 */
export function ConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="border-0 bg-transparent p-0 shadow-none sm:max-w-md"
      >
        <DialogTitle className="sr-only">Connect agent-fs</DialogTitle>
        <ConnectCard />
      </DialogContent>
    </Dialog>
  );
}
