import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

interface CopyIconButtonProps {
  value: string;
  /** Tooltip label, e.g. "Copy base URL". Defaults to "Copy". */
  label?: string;
  size?: "icon-xs" | "icon-sm";
  variant?: "ghost" | "outline";
  className?: string;
}

/**
 * Icon-only copy button: Copy icon with a tooltip, briefly swapping to a
 * Check on success. Used across the connection / OAuth-app detail pages
 * wherever a value is copyable — no text label, minimal footprint.
 */
export function CopyIconButton({
  value,
  label = "Copy",
  size = "icon-xs",
  variant = "ghost",
  className,
}: CopyIconButtonProps) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size={size}
          variant={variant}
          aria-label={copied ? "Copied" : label}
          disabled={!value}
          onClick={(event) => {
            event.stopPropagation();
            copy(value);
          }}
          className={cn("shrink-0 text-muted-foreground hover:text-foreground", className)}
        >
          {copied ? <Check className="text-status-success-strong" /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}
