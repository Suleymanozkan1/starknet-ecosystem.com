import { create } from "zustand";

export interface Toast {
  id: number;
  kind: "info" | "success" | "warn" | "error" | "loot" | "levelup";
  title: string;
  body?: string;
  ttl?: number;
}

interface UiState {
  toasts: Toast[];
  chatOpen: boolean;
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  setChatOpen: (open: boolean) => void;
}

let nextId = 1;

export const useUi = create<UiState>()((set, get) => ({
  toasts: [],
  chatOpen: false,
  pushToast: (t) => {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-4), { ...t, id }] });
    window.setTimeout(() => get().dismissToast(id), t.ttl ?? 4500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
  setChatOpen: (chatOpen) => set({ chatOpen }),
}));

export const toast = {
  info: (title: string, body?: string) => useUi.getState().pushToast({ kind: "info", title, ...(body ? { body } : {}) }),
  success: (title: string, body?: string) => useUi.getState().pushToast({ kind: "success", title, ...(body ? { body } : {}) }),
  warn: (title: string, body?: string) => useUi.getState().pushToast({ kind: "warn", title, ...(body ? { body } : {}) }),
  error: (title: string, body?: string) => useUi.getState().pushToast({ kind: "error", title, ...(body ? { body } : {}), ttl: 7000 }),
};
