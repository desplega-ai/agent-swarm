import { Check, Copy } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * A `Button` that copies `value`. Only the icon changes (Copy to Check), so the
 * width stays, and "Copied" goes to the accessible name. With `children` the
 * visible text names the button ("Copy answer"). Icon-only: pass `label`.
 */
export function CopyValueButton({
  value,
  label,
  children,
  variant = "ghost",
  size = "sm",
  className,
}: Pick<ComponentProps<typeof Button>, "variant" | "size" | "className"> & {
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
      className={className}
      onClick={() => void copy(value)}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <Check /> : <Copy />}
      {children}
    </Button>
  );
}
