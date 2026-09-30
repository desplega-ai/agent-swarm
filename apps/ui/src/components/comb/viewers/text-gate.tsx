import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useAgentFsText } from "@/api/hooks/use-agent-fs";
import { AlertCallout } from "@/components/ui/alert-callout";
import FallbackViewer from "./fallback-viewer";
import type { ViewerProps } from "./file-viewer";
import { ViewerSkeleton } from "./viewer-skeleton";

/**
 * Load a file as text and pass it to `children`. Owns the loading state, the
 * load error, and the "too large" fallback, so text viewers render text only.
 */
export function TextGate({
  file,
  stat,
  children,
}: ViewerProps & { children: (text: string) => ReactNode }) {
  const content = useAgentFsText(file);
  if (content.data?.tooLarge) return <FallbackViewer file={file} stat={stat} tooLarge />;
  if (content.data) return children(content.data.text);
  if (content.error) {
    return (
      <div className="p-6">
        <AlertCallout tone="error" icon={AlertCircle} title="Could not load the file">
          {content.error.message}
        </AlertCallout>
      </div>
    );
  }
  return <ViewerSkeleton />;
}
