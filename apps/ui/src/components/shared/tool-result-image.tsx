import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { ResultImage } from "@/logs-parser/result-images";

export function ToolResultImage({ image, index }: { image: ResultImage; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The component mounts only inside an expanded tool row; even then, wait for
  // proximity to the viewport before allocating a potentially large data URL.
  const src = useMemo(
    () => (visible ? `data:${image.mimeType};base64,${image.data}` : undefined),
    [visible, image.mimeType, image.data],
  );
  const title = `Tool result image ${index + 1}`;
  return (
    <div ref={ref} className="min-h-20">
      {failed ? (
        <p className="text-xs text-muted-foreground">
          Image preview unavailable. Use Copy result or Show full output to inspect it.
        </p>
      ) : src ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="block cursor-zoom-in rounded-md border border-border p-1"
          aria-label={`Open ${title.toLowerCase()} full size`}
        >
          <img
            src={src}
            alt={title}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="max-h-60 max-w-full rounded object-contain"
          />
        </button>
      ) : (
        <span className="text-xs text-muted-foreground">Image preview</span>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[90vh] overflow-auto sm:max-w-[90vw]"
          aria-describedby={undefined}
        >
          <DialogTitle>{title}</DialogTitle>
          {open && <img src={src} alt={title} className="max-w-none" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
