import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

export function useRepos(filters?: { autoClone?: boolean }) {
  return useQuery({
    queryKey: ["repos", filters],
    queryFn: () => api.fetchRepos(filters),
    select: (data) => data.repos,
  });
}

export function useCreateRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      url: string;
      name: string;
      clonePath?: string;
      defaultBranch?: string;
      autoClone?: boolean;
    }) => api.createRepo(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repos"] });
    },
  });
}

export function useUpdateRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<{
        url: string;
        name: string;
        clonePath: string;
        defaultBranch: string;
        autoClone: boolean;
      }>;
    }) => api.updateRepo(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repos"] });
    },
  });
}

export function useDeleteRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.deleteRepo(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repos"] });
    },
  });
}
