import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

/** The server caches the fleet for a day; an hour here keeps Home loads cheap. */
export function useFleetBenchmark(enabled = true) {
  return useQuery({
    queryKey: ["fleet-benchmark"],
    queryFn: () => api.getFleetBenchmark(),
    enabled,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}
