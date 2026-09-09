import { useMutation } from "@tanstack/react-query";
import { api } from "../client";

export function useInspectPageRoom(pageId: string) {
  return useMutation({ mutationFn: (name: string) => api.inspectPageRoom(pageId, name) });
}
