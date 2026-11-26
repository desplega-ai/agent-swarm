import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { TaskSummaryCard } from "@/components/shared/task-hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { shortId } from "@/lib/short-id";
import { DASHBOARD_ROUTES, githubTitle, type SwarmLink } from "@/lib/swarm-links";

function hostOf(href: string): string {
  try {
    return new URL(href, window.location.href).host.replace(/^www\./, "");
  } catch {
    return href;
  }
}

/**
 * An external link's Open Graph preview (`GET /api/link-preview`, cached by
 * the API): image, site, title and description. While it loads, and when the
 * page gives nothing, the card shows the link's own name and host.
 */
function OgPreview({ href, name }: { href: string; name: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["link-preview", href],
    queryFn: () => api.getLinkPreview(href),
    staleTime: 60 * 60_000,
    refetchInterval: false,
    retry: false,
  });
  const [imageFailed, setImageFailed] = useState(false);
  // A page that gives only a generic title (a sign-in wall: "Linear") says less than the link's own name.
  const preview = data?.ok && (data.description || data.image) ? data : null;
  return (
    <div>
      {preview?.image && !imageFailed ? (
        <img
          src={preview.image}
          alt=""
          referrerPolicy="no-referrer"
          className="aspect-[1.91/1] w-full rounded-t-md border-b border-border-subtle bg-muted object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : null}
      <div className="space-y-1 px-3 py-2.5">
        <p className="truncate text-meta text-muted-foreground">
          {preview?.siteName ?? hostOf(href)}
        </p>
        <p className="line-clamp-2 text-sm font-medium leading-5 break-words">
          {preview?.title ?? name}
        </p>
        {isLoading ? (
          <Skeleton className="h-3 w-2/3" />
        ) : preview?.description ? (
          <p className="line-clamp-3 text-xs text-muted-foreground">{preview.description}</p>
        ) : null}
      </div>
    </div>
  );
}

/** A plain two-line card: what the link is and its name. */
function PlainCard({ noun, name }: { noun: string; name: string }) {
  return (
    <div className="space-y-0.5 px-3 py-2.5">
      <p className="text-meta text-muted-foreground">{noun}</p>
      <p className="line-clamp-2 text-sm font-medium break-all">{name}</p>
    </div>
  );
}

/**
 * What a link chip's hover card shows. A task or a session: the task's status,
 * agent, model and cost. Another dashboard link: its kind and name. A drive
 * file: its path. GitHub, GitLab, Linear, Jira and Slack: the page's Open Graph
 * preview. Each body mounts only while the card is open, so a chip costs no
 * request until someone hovers it.
 */
export function LinkHoverBody({ link, name }: { link: SwarmLink; name?: string }) {
  switch (link.type) {
    case "dashboard":
      if (link.route === "tasks" || link.route === "sessions") {
        return <TaskSummaryCard taskId={link.id} />;
      }
      return (
        <PlainCard
          noun={`${DASHBOARD_ROUTES[link.route]} · ${shortId(link.id)}`}
          name={name ?? link.id}
        />
      );
    case "file":
      return <PlainCard noun={link.folder ? "Folder" : "File"} name={link.path} />;
    case "share":
      return <PlainCard noun="Shared agent-fs file" name={link.name ?? link.href} />;
    case "github":
      return <OgPreview href={link.href} name={githubTitle(link)} />;
    case "external":
      return <OgPreview href={link.href} name={link.title} />;
  }
}
