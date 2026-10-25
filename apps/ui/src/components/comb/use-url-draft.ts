import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/**
 * A text box whose value also lives in the URL (`?q=`, `?filter=`). The box
 * keeps its own state, so typing never waits for the URL: React Router
 * updates the location in a transition, and a box bound to the URL alone
 * drops keys. `write` puts each new value in the URL. Back and Forward (a
 * POP navigation) bring the URL's value into the box.
 */
export function useUrlDraft(
  urlValue: string,
  write: (value: string) => void,
): [string, (value: string) => void] {
  const [value, setValue] = useState(urlValue);
  const { key } = useLocation();
  const navigationType = useNavigationType();
  // Only on a history move: the URL then holds a value this box did not type.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per location
  useEffect(() => {
    if (navigationType === "POP") setValue(urlValue);
  }, [key]);
  const update = useCallback(
    (next: string) => {
      setValue(next);
      write(next);
    },
    [write],
  );
  return [value, update];
}
