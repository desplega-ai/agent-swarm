import { useMutation } from "@tanstack/react-query";
import { api } from "../client";
import type { FeedbackInput } from "../types";

export function useSubmitFeedback() {
  return useMutation({
    mutationFn: (input: FeedbackInput) => api.submitFeedback(input),
  });
}
