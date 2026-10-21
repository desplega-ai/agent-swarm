/**
 * The New session tab (plan Phase 5, SPEC R3): the shipped composer plus a
 * "Start in" picker. It starts in the group it was opened from. Send
 * creates the root task with that group's key (No group sends none, so the
 * server sets the default key), and the tab turns into the new session.
 */

import { useState } from "react";
import { NewSessionView } from "@/components/sessions/new-session-view";
import { useCurrentUser } from "@/contexts/current-user-context";
import { groupCrumb } from "@/lib/session-groups";
import { StartInPicker } from "./start-in-picker";
import { useMyGroups } from "./use-my-groups";

export function NewSessionTab({
  startIn,
  onStarted,
}: {
  /** The group the tab was opened from, or null for No group. */
  startIn: string | null;
  onStarted: (rootTaskId: string) => void;
}) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  const { targets, writeBlock } = useMyGroups(me);
  // A group this connection cannot start a session in falls back to No group.
  const usable = (key: string | null) => (key && !writeBlock(key) ? key : null);

  // A "+" on another group while this tab is open picks that group.
  const [group, setGroup] = useState(() => usable(startIn));
  const [opened, setOpened] = useState(startIn);
  if (startIn !== opened) {
    setOpened(startIn);
    setGroup(usable(startIn));
  }
  const label = group ? groupCrumb(group, me, () => "") : "No group";

  return (
    <NewSessionView
      startKey={group ?? undefined}
      onStarted={(created) => onStarted(created.id)}
      startIn={
        <StartInPicker
          value={group}
          label={label}
          targets={targets}
          writeBlock={writeBlock}
          onChange={setGroup}
        />
      }
    />
  );
}
