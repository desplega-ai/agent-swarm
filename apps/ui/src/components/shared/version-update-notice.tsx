import { RefreshCw, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

export interface VersionUpdateNotice {
  /** Changes when the toast text changes, so the old toast is replaced. */
  id: string;
  /** Identifies the version; a dismissal holds until a newer version appears. */
  versionKey: string;
  description: string;
  canLoad: boolean;
}

/** Short stable key for a revision string, which can hold a whole definition. */
function revisionKey(revision: string): string {
  let hash = 5381;
  for (let i = 0; i < revision.length; i++) hash = (hash * 33) ^ revision.charCodeAt(i);
  return `${(hash >>> 0).toString(36)}.${revision.length}`;
}

/** Null when no toast is needed: no update, or auto reload loads it now. */
export function versionUpdateNotice(opts: {
  entityKey: string;
  latestRevision: string | undefined;
  pending: boolean;
  editing: boolean;
  autoReload: boolean;
  canAutoReload: boolean;
}): VersionUpdateNotice | null {
  const { entityKey, latestRevision, pending, editing, autoReload, canAutoReload } = opts;
  if (!pending || latestRevision === undefined || (autoReload && canAutoReload)) return null;
  const versionKey = `${entityKey}@${revisionKey(latestRevision)}`;
  const description = editing
    ? "Finish editing to load it."
    : autoReload
      ? "Auto reload is paused because you used this view."
      : "Load it when you are ready.";
  return {
    id: `${versionKey}:${editing ? "editing" : "viewing"}`,
    versionKey,
    description,
    canLoad: !editing,
  };
}

/**
 * One toast per new version. A dismissal holds until a newer version appears;
 * leaving the entity or loading the version closes the toast.
 */
export function useVersionUpdateToast(
  opts: Parameters<typeof versionUpdateNotice>[0] & { onLoad: () => void },
) {
  const notice = versionUpdateNotice(opts);
  // Toast actions outlive renders, so they call the latest handler.
  const onLoadRef = useRef(opts.onLoad);
  onLoadRef.current = opts.onLoad;
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  const dismissedRef = useRef<string | null>(null);
  const noticeId = notice?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the toast is replaced only when its text changes
  useEffect(() => {
    const current = noticeRef.current;
    if (!current || dismissedRef.current === current.versionKey) return;
    return showVersionUpdateToast(current, {
      load: () => onLoadRef.current(),
      dismiss: () => {
        dismissedRef.current = current.versionKey;
      },
    });
  }, [noticeId]);
}

function showVersionUpdateToast(
  notice: VersionUpdateNotice,
  handlers: { load: () => void; dismiss: () => void },
): () => void {
  let active = true;
  // Same custom body as the GitHub star nudge: sonner's default layout
  // squeezes the action and pins the close button to the corner.
  const toastId = toast.custom(
    (id) => (
      <div className="flex w-full gap-3" data-testid="version-update-toast">
        <RefreshCw className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm font-semibold leading-5">A newer version is available</p>
          <p className="text-[13px] text-muted-foreground">{notice.description}</p>
          {notice.canLoad && (
            <button
              type="button"
              data-slot="button"
              className="mt-2 inline-flex h-8 cursor-pointer items-center gap-1.5 self-start rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[0.96]"
              onClick={() => {
                active = false;
                handlers.load();
                toast.dismiss(id);
              }}
            >
              Load latest
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          className="-mt-1 -mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          onClick={() => {
            handlers.dismiss();
            toast.dismiss(id);
          }}
        >
          <X className="size-4" />
        </button>
      </div>
    ),
    {
      duration: Number.POSITIVE_INFINITY,
      className:
        "w-[var(--width)] !rounded-lg !border !p-4 font-sans [&[data-expanded=false][data-front=false]>*]:pointer-events-none [&[data-expanded=false][data-front=false]>*]:opacity-0",
      // A swipe dismisses too. Programmatic cleanup must not.
      onDismiss: () => {
        if (active) handlers.dismiss();
      },
    },
  );
  return () => {
    active = false;
    toast.dismiss(toastId);
  };
}

/** Confirms an automatic reload. */
export function showVersionUpdatedToast(version?: number) {
  toast(version === undefined ? "Updated to the latest version" : `Updated to v${version}`);
}
