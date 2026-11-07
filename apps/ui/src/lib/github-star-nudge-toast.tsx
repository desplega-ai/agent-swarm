import { Star, X } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { useStats } from "@/api/hooks/use-stats";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { useDismissibleCard } from "@/hooks/use-dismissible-card";

const GITHUB_REPO_URL = "https://github.com/desplega-ai/agent-swarm";

/** Wait for a resolved identity. Anonymous tabs never share a dismissal. */
export function GitHubStarNudge() {
  const { config } = useConfig();
  const { state, userId } = useCurrentUser();
  if (state !== "ready" || !userId) return null;
  // Remount the preference hook on either change, before it can use old state.
  return <UserStarNudge key={`${config.apiUrl}:${userId}`} userId={userId} />;
}

function UserStarNudge({ userId }: { userId: string }) {
  const { data } = useStats();
  const { dismissed, dismiss } = useDismissibleCard(`github-star-nudge:${userId}:done`);
  // Stats counts every existing task, independent of list filters and pagination.
  const eligible = !dismissed && (data?.tasks.total ?? 0) >= 5;
  useEffect(() => {
    if (!eligible) return;
    return showStarNudge(dismiss);
  }, [eligible, dismiss]);
  return null;
}

function showStarNudge(done: () => void): () => void {
  let active = true;
  // A custom body: sonner's default layout wraps the text around a squeezed
  // action and pins the close button to the corner. Plain buttons keep the
  // Button tokens and the existing toast layout.
  const toastId = toast.custom(
    (id) => (
      <div className="flex w-full gap-3">
        <Star className="mt-0.5 size-4 shrink-0 fill-primary text-primary" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm font-semibold leading-5">Enjoying agent-swarm?</p>
          <p className="text-[13px] text-muted-foreground">A GitHub star helps others find it.</p>
          <button
            type="button"
            data-slot="button"
            className="mt-2 inline-flex h-8 cursor-pointer items-center gap-1.5 self-start rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[0.96]"
            onClick={() => {
              done();
              window.open(GITHUB_REPO_URL, "_blank", "noopener,noreferrer");
              toast.dismiss(id);
            }}
          >
            <Star className="size-4 fill-current" />
            Star on GitHub
          </button>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="-mt-1 -mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          onClick={() => {
            done();
            toast.dismiss(id);
          }}
        >
          <X className="size-4" />
        </button>
      </div>
    ),
    {
      duration: Number.POSITIVE_INFINITY,
      // Custom toasts skip sonner's box styles; the Toaster adds the colors.
      // Width stays overridable: sonner's phone rule makes it full-width.
      // Sonner hides a collapsed toast's contents only for styled toasts, so
      // the two data variants do it here; otherwise the body spills out below a
      // newer toast stacked in front.
      className:
        "w-[var(--width)] !rounded-lg !border !p-4 font-sans [&[data-expanded=false][data-front=false]>*]:pointer-events-none [&[data-expanded=false][data-front=false]>*]:opacity-0",
      onDismiss: () => {
        if (active) done();
      },
    },
  );
  return () => {
    // Programmatic cleanup must not persist dismissal or affect the next toast.
    active = false;
    toast.dismiss(toastId);
  };
}
