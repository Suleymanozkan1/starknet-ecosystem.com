import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { MeResponse } from "@nebula/shared";
import { api } from "../lib/api.js";
import { qk, useMe } from "../lib/queries.js";
import { factionColor } from "../lib/gameMeta.js";

/** Inside authenticated routes `me` is guaranteed by <RequireAuth>. */
export function useSession(): MeResponse {
  const { data } = useMe();
  if (!data) throw new Error("useSession used outside an authenticated route");
  return data;
}

export function useLogout(): () => Promise<void> {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* cookie may already be gone — we clear local state regardless */
    }
    qc.setQueryData(qk.me, null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" && q.queryKey[0] !== "factions" });
    navigate("/", { replace: true });
  }, [qc, navigate]);
}

/** Re-points the global accent color to the player's faction. */
export function useFactionAccent(factionId: string | null | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--nf-accent", factionColor(factionId));
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", "#04060c");
  }, [factionId]);
}
