import { Ellipsis } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ActionSheet } from "@/components/sessions-v2/mobile/action-sheet";
import { Button } from "@/components/ui/button";
import { useIsPhone } from "@/hooks/use-mobile";

/**
 * A page header's action cluster, in two shapes. From `md` up it renders
 * `children` untouched. On a phone it shows at most the `primary` controls
 * plus one "More actions" button that opens a bottom action sheet of `more`
 * rows (`ActionSheetItem`), so the description beside it keeps the width.
 *
 *   <PageActions
 *     title={page.title}
 *     primary={<FavoriteButton … className="size-11" />}
 *     more={<ActionSheetItem icon={FileDown} label="Export PDF" onSelect={exportPdf} />}
 *   >
 *     …the desktop buttons…
 *   </PageActions>
 *
 * `title` names the sheet: the full page name, which the phone bar truncates.
 */
export function PageActions({
  title,
  primary,
  more,
  children,
}: {
  title: ReactNode;
  primary?: ReactNode;
  more: ReactNode;
  children: ReactNode;
}) {
  const isPhone = useIsPhone();
  const [open, setOpen] = useState(false);
  if (!isPhone) return <>{children}</>;
  return (
    <div className="flex items-center">
      {primary}
      <Button
        variant="ghost"
        size="icon"
        className="size-11"
        aria-label="More actions"
        onClick={() => setOpen(true)}
      >
        <Ellipsis className="size-5" />
      </Button>
      <ActionSheet open={open} onOpenChange={setOpen} title={title}>
        {more}
      </ActionSheet>
    </div>
  );
}
