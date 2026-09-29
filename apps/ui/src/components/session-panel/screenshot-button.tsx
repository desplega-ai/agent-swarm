/**
 * "Add screenshot" button for the session panel's composer: captures the page
 * behind the panel and hands the PNG to the composer as an attachment.
 */

import { Camera, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { capturePageScreenshot } from "./page-screenshot";

export interface ScreenshotButtonProps {
  /** The element to capture; `null` means there is nothing to capture right now. */
  getTarget: () => HTMLElement | null;
  onCaptured: (file: File) => void;
  disabled?: boolean;
  /** Injected in tests. */
  capture?: (target: HTMLElement) => Promise<File>;
}

export function ScreenshotButton({
  getTarget,
  onCaptured,
  disabled,
  capture = (target) => capturePageScreenshot({ target }),
}: ScreenshotButtonProps) {
  const [capturing, setCapturing] = useState(false);

  const onClick = async () => {
    const target = getTarget();
    if (!target) {
      toast.error("Couldn't find the page to capture.");
      return;
    }
    setCapturing(true);
    try {
      onCaptured(await capture(target));
    } catch (error) {
      toast.error(
        `Couldn't capture the page${error instanceof Error && error.message ? `: ${error.message}` : "."}`,
      );
    } finally {
      setCapturing(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={disabled || capturing}
          aria-label="Add screenshot"
          aria-busy={capturing}
          className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
          onClick={onClick}
        >
          {capturing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Camera className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      {/* Left, not top: above the button it would cover the new attachment's remove button. */}
      <TooltipContent side="left">Add screenshot of this page</TooltipContent>
    </Tooltip>
  );
}
