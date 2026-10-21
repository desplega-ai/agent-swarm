import {
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  MouseSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useState } from "react";
import type { SessionListItem } from "@/api/types";

/**
 * dnd-kit's default text tells screen readers to drag with the space bar
 * and announces item ids. Neither fits the sessions drags: each has a
 * keyboard path instead (`m` moves rows, `v` splits), and the result says
 * what changed.
 */
const silent = () => undefined;
export const SILENT_DRAG_ACCESSIBILITY = {
  screenReaderInstructions: { draggable: "" },
  announcements: {
    onDragStart: silent,
    onDragOver: silent,
    onDragEnd: silent,
    onDragCancel: silent,
  } satisfies Announcements,
};

/** The mouse starts a drag after 5 px, so a click still clicks. There is no keyboard sensor. */
export function useMouseDragSensors() {
  return useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 5 } }));
}

interface RowDragData {
  session: SessionListItem;
}

interface GroupDropData {
  /** The group key, or null for No group. */
  groupKey: string | null;
}

/**
 * A session row as a drag source: only the ref and the pointer listeners.
 * The row keeps its treeitem role (dnd-kit's attributes would make it a
 * button). The keyboard path is `m`, so there is no keyboard sensor.
 */
export function useRowDraggable(rowKey: string, session: SessionListItem) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: rowKey,
    data: { session } satisfies RowDragData,
  });
  return { dragRef: setNodeRef, dragListeners: listeners, isDragging };
}

/** A group row (or No group) as a drop target. `undefined` takes no drops (Shared with me). */
export function useGroupDroppable(rowKey: string, groupKey: string | null | undefined) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop:${rowKey}`,
    disabled: groupKey === undefined,
    data: { groupKey: groupKey ?? null } satisfies GroupDropData,
  });
  return { dropRef: setNodeRef, isOver: isOver && groupKey !== undefined };
}

/**
 * Drag rows onto a group (plan Phase 5): the mouse starts a drag after 5 px,
 * so a click still opens the row. A row in the selection drags the whole
 * selection.
 */
export function useRowDrag({
  dragTargets,
  onDrop,
}: {
  /** What a drag of this row moves: the selection when the row is in it, else the row. */
  dragTargets: (session: SessionListItem) => SessionListItem[];
  onDrop: (sessions: SessionListItem[], groupKey: string | null) => void;
}) {
  const sensors = useMouseDragSensors();
  const [dragging, setDragging] = useState<SessionListItem[] | null>(null);

  const onDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as RowDragData | undefined;
    setDragging(data ? dragTargets(data.session) : null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const over = event.over?.data.current as GroupDropData | undefined;
    if (dragging && over) onDrop(dragging, over.groupKey);
    setDragging(null);
  };
  return {
    sensors,
    accessibility: SILENT_DRAG_ACCESSIBILITY,
    dragging,
    onDragStart,
    onDragEnd,
    onDragCancel: () => setDragging(null),
  };
}
