import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Open state of a task's detail sheet, kept in the URL (`?task=<id>`), so a
 * link to a session with one task open can be shared. `replace` keeps Back
 * useful: opening and closing sheets does not add history entries.
 */
export function useTaskSheetParam(taskId: string): [boolean, (open: boolean) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const open = searchParams.get("task") === taskId;
  const setOpen = useCallback(
    (next: boolean) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next) sp.set("task", taskId);
          else if (sp.get("task") === taskId) sp.delete("task");
          return sp;
        },
        { replace: true },
      );
    },
    [setSearchParams, taskId],
  );
  return [open, setOpen];
}
