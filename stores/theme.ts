import { create } from "zustand";

type ThemeMode = "dark" | "light" | "system";

interface ThemeStore {
  mode: ThemeMode;
  hydrate: () => void;
  setMode: (mode: ThemeMode) => void;
  cycle: () => void;
}

const STORAGE_KEY = "webpilot.theme";
const ORDER: ThemeMode[] = ["system", "dark", "light"];

function readStored(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "dark" || v === "light" || v === "system") return v;
  return "dark";
}

function applyToDOM(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", mode);
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  mode: "dark",
  hydrate: () => {
    const stored = readStored();
    if (stored !== get().mode) {
      applyToDOM(stored);
      set({ mode: stored });
    }
  },
  setMode: (mode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    applyToDOM(mode);
    set({ mode });
  },
  cycle: () => {
    const current = get().mode;
    const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
    get().setMode(next);
  },
}));
