import { useMutation } from "@tanstack/react-query";
import { api } from "../client";
import type { FeedbackInput } from "../types";

export function useSubmitFeedback(endpoint: string) {
  return useMutation({
    mutationFn: (input: FeedbackInput) => api.submitFeedback(endpoint, input),
  });
}
