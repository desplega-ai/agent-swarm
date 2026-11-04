import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";

export function VersionUpdateNotice({ onApply }: { onApply: () => void }) {
  return (
    <AlertCallout
      tone="info"
      role="status"
      action={
        <Button size="sm" variant="outline" onClick={onApply}>
          Load new version
        </Button>
      }
    >
      A new version is available.
    </AlertCallout>
  );
}
