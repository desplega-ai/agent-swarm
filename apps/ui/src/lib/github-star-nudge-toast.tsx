import { Star, X } from "lucide-react";
import { toast } from "sonner";
import { getConfig } from "./config";
import { GITHUB_REPO_URL, markStarNudgeDone, recordPromptSent } from "./github-star-nudge";

const TOAST_ID = "github-star-nudge";

/**
 * Call after every successful prompt send. From the 5th one, shows the star
 * notice (one toast: the fixed id updates it in place) until the user closes
 * it or clicks the button.
 */
export function notePromptSent(): void {
  const { apiUrl } = getConfig();
  if (!recordPromptSent(apiUrl, localStorage)) return;
  const done = () => markStarNudgeDone(apiUrl, localStorage);
  // A custom body: sonner's default layout wraps the text around a squeezed
  // action and pins the close button to the corner. Closing goes through
  // toast.dismiss, so it ends in onDismiss like a swipe does. Plain buttons
  // with the Button tokens: root tests import this module through the send
  // hooks and cannot resolve the `@/` imports `ui/button` pulls in.
  toast.custom(
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
          onClick={() => toast.dismiss(id)}
        >
          <X className="size-4" />
        </button>
      </div>
    ),
    {
      id: TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      // Custom toasts skip sonner's box styles; the Toaster adds the colors.
      // Width stays overridable: sonner's phone rule makes it full-width.
      // Sonner hides a collapsed toast's contents only for styled toasts, so
      // the two data variants do it here; otherwise the body spills out below a
      // newer toast stacked in front.
      className:
        "w-[var(--width)] !rounded-lg !border !p-4 font-sans [&[data-expanded=false][data-front=false]>*]:pointer-events-none [&[data-expanded=false][data-front=false]>*]:opacity-0",
      onDismiss: done,
    },
  );
}
