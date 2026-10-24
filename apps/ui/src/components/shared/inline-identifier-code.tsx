import { Check, Copy } from "lucide-react";
import type { JSX } from "react";
import { toast } from "sonner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

const CONFIG_IDENTIFIER = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * An env-var-style name such as `BITBUCKET_WEBHOOK_SECRET`: upper case, digits
 * and at least one underscore, so `API` or `JSON` alone do not match.
 */
export function isConfigIdentifier(text: string): boolean {
  return CONFIG_IDENTIFIER.test(text.trim());
}

type InlineCodeProps = JSX.IntrinsicElements["code"] & { node?: unknown };

/**
 * Inline code for markdown renderers. An env-var-style name gets a small copy
 * button that copies exactly the name; any other inline code renders as is.
 * The button sits in a `select-none` span so selecting the prose never picks
 * it up. It takes no width until the code is hovered or the button has
 * keyboard focus, so resting prose has no gap. Touch screens always show it,
 * with an invisible hit area that widens it without moving the text.
 */
export function InlineIdentifierCode({ node: _node, children, ...props }: InlineCodeProps) {
  const { copied, copy } = useCopyToClipboard();
  const text = Array.isArray(children) ? children.join("") : String(children ?? "");
  if (!isConfigIdentifier(text)) return <code {...props}>{children}</code>;
  const name = text.trim();
  return (
    <span className="group/identifier">
      <code {...props}>{children}</code>
      <span className="select-none">
        <button
          type="button"
          onClick={() => {
            void copy(name).then((ok) => {
              if (!ok) toast.error("Couldn't copy. The browser blocked the clipboard.");
            });
          }}
          aria-label={copied ? `Copied ${name}` : `Copy ${name}`}
          title={`Copy ${name}`}
          className="relative inline-flex h-4 w-0 items-center justify-center overflow-hidden rounded-sm align-middle text-muted-foreground opacity-0 hover:text-foreground focus-visible:ml-0.5 focus-visible:w-4 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 group-hover/identifier:ml-0.5 group-hover/identifier:w-4 group-hover/identifier:opacity-100 pointer-coarse:ml-0.5 pointer-coarse:w-4 pointer-coarse:overflow-visible pointer-coarse:opacity-100 pointer-coarse:after:absolute pointer-coarse:after:-inset-3"
        >
          {copied ? (
            <Check className="h-3 w-3 text-status-success-strong" aria-hidden />
          ) : (
            <Copy className="h-3 w-3" aria-hidden />
          )}
        </button>
      </span>
    </span>
  );
}
