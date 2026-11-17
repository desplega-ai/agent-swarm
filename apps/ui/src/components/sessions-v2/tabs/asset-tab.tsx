/**
 * An asset tab: a file, a page, or a task that a link in a session opened.
 * It sits in a pane's tab strip with the session tabs (as T3 Code mixes
 * chats, files, and the browser in one tab row), so the session and the
 * asset show side by side in the split. The body is the link preview with
 * no close button: the tab closes it.
 */

import { FileText, Globe, ListTodo, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { usePage } from "@/api/hooks/use-pages";
import { useTask } from "@/api/hooks/use-tasks";
import { LinkPreviewContent } from "@/components/link-preview/link-preview-panel";
import { EmptyState } from "@/components/shared/empty-state";
import { useSwarmLinkOrigins } from "@/components/shared/markdown-link-chip";
import { assetTabTarget, type LinkPreviewTarget } from "@/lib/link-preview";
import { isAssetTab } from "@/lib/sessions-v2";
import { taskListTitle } from "@/lib/task-title";

const PAGE_ID_RE = /^[a-f0-9]{32}$/i;

/** The preview target of an asset tab, or null for another tab or a bad id. */
export function useAssetTabTarget(tab: string): LinkPreviewTarget | null {
  const origins = useSwarmLinkOrigins();
  return useMemo(() => (isAssetTab(tab) ? assetTabTarget(tab, origins) : null), [tab, origins]);
}

/** The title and the icon of an asset tab. Null for any other tab. */
export function useAssetTabLabel(tab: string): { title: string; icon: LucideIcon } | null {
  const target = useAssetTabTarget(tab);
  // A page link can name a slug: only an id reads the page here, the slug shows as written.
  const pageId = target?.kind === "page" && PAGE_ID_RE.test(target.id) ? target.id : undefined;
  const { data: page } = usePage(pageId);
  const { data: task } = useTask(target?.kind === "task" ? target.taskId : "");
  if (!isAssetTab(tab)) return null;
  if (!target) return { title: "Unavailable", icon: FileText };
  if (target.kind === "file") return { title: target.name, icon: FileText };
  if (target.kind === "page") return { title: page?.title ?? target.id, icon: Globe };
  return { title: task ? taskListTitle(task) : "Task", icon: ListTodo };
}

/** The body of an asset tab. `onBack`: the phone screen's back button. */
export function AssetTab({ tab, onBack }: { tab: string; onBack?: () => void }) {
  const target = useAssetTabTarget(tab);
  if (!target) {
    return (
      <EmptyState
        icon={FileText}
        title="This tab has no preview"
        description="The link it came from no longer opens here. Close the tab."
        fullPage
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LinkPreviewContent target={target} onBack={onBack} />
    </div>
  );
}
