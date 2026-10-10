import { Skeleton } from "@/components/ui/skeleton";

const SKELETON_WIDTHS = ["w-2/5", "w-4/5", "w-3/4", "w-11/12", "w-2/3", "w-1/2"];

/** Placeholder lines while a viewer or its bytes load. */
export function ViewerSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6" aria-busy="true">
      {SKELETON_WIDTHS.map((width) => (
        <Skeleton key={width} className={`h-4 ${width}`} />
      ))}
    </div>
  );
}
