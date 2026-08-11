import { useQuery } from "@tanstack/react-query";
import { api } from "../client";
import type { MeetingStatus } from "../types";

export interface MeetingFilters {
  status?: MeetingStatus;
  agentId?: string;
  limit?: number;
}

export function useMeetings(filters?: MeetingFilters) {
  return useQuery({
    queryKey: ["meetings", filters],
    queryFn: () => api.fetchMeetings(filters),
    select: (data) => data.meetings,
  });
}

export function useMeeting(id: string) {
  return useQuery({
    queryKey: ["meeting", id],
    queryFn: () => api.fetchMeeting(id),
    enabled: !!id,
  });
}
