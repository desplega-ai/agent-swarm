import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/** An outline icon button that copies `value`. One width: only the icon swaps. */
export function CopyIconButton({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      onClick={() => void copy(value)}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
