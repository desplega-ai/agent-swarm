import { RouterProvider } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { isDemoMode } from "@/lib/deployment-config";
import { Providers } from "./providers";
import { router } from "./router";

export default function App() {
  return (
    <Providers>
      <RouterProvider router={router} />
      {isDemoMode ? (
        <aside
          aria-label="Live demo environment"
          className="pointer-events-none fixed left-0 top-0 z-[60] hidden size-24 overflow-hidden md:block"
        >
          <div className="absolute left-[-2.25rem] top-5 w-36 -rotate-45 border-y border-status-info/30 bg-status-info py-1 text-center text-[11px] font-semibold text-status-info-foreground shadow-sm">
            Live demo
          </div>
        </aside>
      ) : null}
      <Toaster position="bottom-right" />
    </Providers>
  );
}
