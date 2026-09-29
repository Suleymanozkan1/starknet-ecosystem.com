import { useQuery } from "@tanstack/react-query";
import type { MeResponse } from "@nebula/shared";
import { api } from "./lib/api.js";
import { isApiError } from "./lib/http.js";

export function useMeQuery() {
  return useQuery<MeResponse | null>({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.me();
      } catch (e) {
        if (isApiError(e) && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

/** Inside the authenticated shell the session is guaranteed. */
export function useAdminMe(): MeResponse {
  const { data } = useMeQuery();
  if (!data) throw new Error("admin session missing");
  return data;
}
