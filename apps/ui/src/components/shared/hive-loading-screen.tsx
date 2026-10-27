import { HiveMark } from "@/components/shared/hive-mark";
import { cn } from "@/lib/utils";
import "./hive-loading-screen.css";

/**
 * Route-level Suspense fallback: the bare mark over a soft glow. No status copy
 * and no skeleton — placeholder blocks get mistaken for real layout while the
 * chunk loads, whereas the mark reads as "loading" without asserting content.
 * Centered in its container (the app shell's content area). `fullPage` centers
 * it in the window, for a fallback with no sized parent (a top-level route).
 */
export function HiveLoadingScreen({ fullPage = false }: { fullPage?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-center px-4 py-12",
        fullPage ? "min-h-svh w-full bg-background" : "min-h-full",
      )}
    >
      <div className="relative flex items-center justify-center">
        <div
          className="hive-loading-glow pointer-events-none absolute h-72 w-72 rounded-full"
          aria-hidden="true"
        />
        <div className="hive-loading-float relative">
          <HiveMark size={200} pulses dataFlow />
        </div>
      </div>
    </div>
  );
}
