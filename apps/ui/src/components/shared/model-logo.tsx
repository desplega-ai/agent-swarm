import { Cpu } from "lucide-react";
import { MODEL_VENDOR_LOGO, modelDisplayName, modelVendor } from "@/lib/model-vendor";
import { cn } from "@/lib/utils";
import { BrandLogo } from "./brand-logo";

/** The mark of a model's maker (Anthropic, OpenAI, DeepSeek, Z.ai, ...). A chip icon when unknown. */
export function ModelLogo({
  model,
  className,
}: {
  model: string | null | undefined;
  className?: string;
}) {
  const vendor = modelVendor(model);
  if (!vendor) {
    return <Cpu aria-hidden className={cn("size-3.5 shrink-0 opacity-70", className)} />;
  }
  return <BrandLogo src={MODEL_VENDOR_LOGO[vendor]} className={cn("size-3.5", className)} />;
}

/** Maker mark plus the pretty model name ("Claude Opus 5.5", not "claude-opus-5-5"). */
export function ModelLabel({ model, className }: { model: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <ModelLogo model={model} />
      <span className="min-w-0 truncate">{modelDisplayName(model)}</span>
    </span>
  );
}
