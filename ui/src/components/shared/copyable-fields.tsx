import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

/** Bare copy icon button — used inline next to code snippets. */
export function CopyIconButton({ value }: { value: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      aria-label={copied ? "Copied" : "Copy code"}
      title={copied ? "Copied" : "Copy code"}
      className="rounded p-1 transition-colors focus:outline-none focus:ring-1 text-muted-foreground hover:text-foreground hover:bg-muted focus:ring-ring"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/** Read-only labeled field with a copy button (e.g. a webhook / API URL). */
export function CopyableField({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground uppercase tracking-wide">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={value}
          className={cn("h-9", mono && "font-mono text-xs")}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => copy(value)}
          aria-label={`Copy ${label}`}
          className="shrink-0"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

/** Read-only secret field with a reveal toggle and a copy button. */
export function SecretField({ label, value }: { label: string; value: string }) {
  const [revealed, setRevealed] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground uppercase tracking-wide">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          type={revealed ? "text" : "password"}
          value={value}
          className="h-9 font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? "Hide secret" : "Reveal secret"}
          className="shrink-0"
        >
          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => copy(value)}
          aria-label={`Copy ${label}`}
          className="shrink-0"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
