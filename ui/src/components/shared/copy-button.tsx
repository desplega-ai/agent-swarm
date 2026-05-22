import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  value: string;
  ariaLabel?: string;
  className?: string;
}

export function CopyButton({ value, ariaLabel = "Copy code", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cn(
        "absolute top-1.5 right-1.5 z-10 inline-flex h-6 w-6 items-center justify-center",
        "rounded-md border border-border bg-popover/80 text-muted-foreground",
        "opacity-60 transition-opacity hover:opacity-100 hover:text-foreground",
        "supports-[backdrop-filter]:backdrop-blur",
        copied && "opacity-100 text-status-success-strong",
        className,
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
