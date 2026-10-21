import { Check, Copy } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * A `Button` that copies `value`. Only the icon changes (Copy to Check), so the
 * width stays, and "Copied" goes to the accessible name. With `children` the
 * visible text names the button ("Copy answer"). Icon-only: pass `label`.
 * Other props pass through, so it works under `TooltipTrigger asChild`. A
 * blocked clipboard gets a toast.
 */
export function CopyValueButton({
  value,
  label,
  children,
  variant = "ghost",
  size = "sm",
  onClick,
  ...props
}: Omit<ComponentProps<typeof Button>, "value" | "children"> & {
  value: string;
  /** The accessible name of an icon-only button ("Copy task id"). */
  label?: string;
  children?: ReactNode;
}) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        void copy(value).then((ok) => {
          if (!ok) toast.error("Couldn't copy. The browser blocked the clipboard.");
        });
      }}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <Check /> : <Copy />}
      {children}
    </Button>
  );
}
