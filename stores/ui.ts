import { create } from "zustand";

type DisplayMode = "simple" | "detailed";
type View = "home" | "library" | "activity" | "settings";

type ToastType = "info" | "error" | "success";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface UIStore {
  view: View;
  setView: (view: View) => void;
  displayMode: DisplayMode;
  hydrate: () => void;
  setDisplayMode: (mode: DisplayMode) => void;
  toggleDisplayMode: () => void;
  toasts: Toast[];
  addToast: (message: string, type?: ToastType) => void;
  dismissToast: (id: string) => void;
}

const DISPLAY_MODE_KEY = "webpilot.display-mode";

function readDisplayMode(): DisplayMode {
  if (typeof window === "undefined") return "simple";
  const v = localStorage.getItem(DISPLAY_MODE_KEY);
  return v === "detailed" ? "detailed" : "simple";
}

export const useUIStore = create<UIStore>((set, get) => ({
  view: "home",
  setView: (view) => set({ view }),
  displayMode: "simple",
  hydrate: () => {
    const stored = readDisplayMode();
    if (stored !== get().displayMode) {
      set({ displayMode: stored });
    }
  },
  setDisplayMode: (mode) => {
    localStorage.setItem(DISPLAY_MODE_KEY, mode);
    set({ displayMode: mode });
  },
  toggleDisplayMode: () => {
    const next = get().displayMode === "simple" ? "detailed" : "simple";
    get().setDisplayMode(next);
  },
  toasts: [],
  addToast: (message, type = "info") => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => get().dismissToast(id), type === "error" ? 5000 : 3000);
  },
  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
