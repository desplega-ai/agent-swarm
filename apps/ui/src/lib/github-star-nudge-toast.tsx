import { Star } from "lucide-react";
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
  toast("Enjoying agent-swarm? A GitHub star helps others find it.", {
    id: TOAST_ID,
    icon: <Star className="size-4" />,
    duration: Number.POSITIVE_INFINITY,
    closeButton: true,
    action: {
      label: "Star on GitHub",
      onClick: () => {
        done();
        window.open(GITHUB_REPO_URL, "_blank", "noopener,noreferrer");
      },
    },
    onDismiss: done,
  });
}
