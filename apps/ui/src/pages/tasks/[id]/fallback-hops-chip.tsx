import { Shuffle } from "lucide-react";
import type { FallbackHop, ProviderErrorClass } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatSmartTime } from "@/lib/utils";

/** What ended the session on the profile the work left. */
export const PROVIDER_ERROR_LABEL: Record<ProviderErrorClass, string> = {
  rate_limit: "rate limit",
  model_window: "model window used up",
  seat: "seat cannot run the model",
  credits: "credits used up",
  overloaded: "provider overloaded",
  server_error: "provider server error",
  auth: "authentication failed",
  pool_empty: "no usable key",
};

/**
 * The provider-error fallback hops the work took, as a chip with their count.
 * The popover lists each hop (from → to, why, when) and the fallbacks it
 * skipped. No chip when the work never hopped.
 */
export function FallbackHopsChip({ hops }: { hops: readonly FallbackHop[] | undefined }) {
  if (!hops || hops.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge
          variant="outline"
          asChild
          className="h-6 gap-1 px-2 text-muted-foreground outline-none hit-area [--hit-size:44px] hover:text-foreground"
        >
          <button type="button" aria-label={`Fallback hops (${hops.length})`}>
            <Shuffle aria-hidden />
            <span className="font-mono tabular-nums">{hops.length}</span>
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-96 p-3">
        <p className="mb-2 text-meta font-medium text-muted-foreground">Fallback hops</p>
        <ol className="flex flex-col gap-2">
          {hops.map((hop) => (
            <li key={`${hop.from}-${hop.profile}-${hop.at}`} className="text-meta">
              <div className="font-mono">
                {hop.from} → {hop.profile}
              </div>
              <div className="text-muted-foreground">
                {PROVIDER_ERROR_LABEL[hop.errorClass] ?? hop.errorClass} ·{" "}
                <time dateTime={hop.at}>{formatSmartTime(hop.at)}</time>
              </div>
              {hop.skipped && hop.skipped.length > 0 ? (
                <ul className="mt-1 text-muted-foreground">
                  {hop.skipped.map((skip) => (
                    <li key={skip.profile}>
                      Skipped <span className="font-mono">{skip.profile}</span>: {skip.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
}
