import { Route } from "lucide-react";
import type { ReactNode } from "react";
import { BrandLogo } from "@/components/shared/brand-logo";
import { ProviderIcon } from "@/components/shared/provider-icon";
import type { AiProvider } from "@/lib/ai-providers";
import { cn } from "@/lib/utils";

/**
 * A provider mark in a bordered tile. Decorative: the provider name always
 * renders as text next to it.
 */
export function ProviderLogo({
  provider,
  size = "md",
  className,
}: {
  provider: AiProvider;
  /** `md`: list rows and the panel header. `sm`: menu items. */
  size?: "sm" | "md";
  className?: string;
}) {
  const { logo } = provider;
  const glyph = size === "md" ? "size-4" : "size-3.5";
  let mark: ReactNode;
  if ("provider" in logo) {
    mark = <ProviderIcon provider={logo.provider} className={cn(glyph, "opacity-100")} />;
  } else if ("src" in logo) {
    mark = <BrandLogo src={logo.src} className={glyph} />;
  } else if ("lucide" in logo) {
    mark = <Route aria-hidden className={glyph} />;
  } else {
    mark = (
      <span aria-hidden className="font-mono text-[11px] leading-none font-semibold">
        {logo.letter}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground",
        size === "md" ? "size-8" : "size-6",
        className,
      )}
    >
      {mark}
    </span>
  );
}
