"use client";

import { useEffect } from "react";
import { useThemeStore } from "@/stores/theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const mode = useThemeStore((s) => s.mode);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", mode);
  }, [mode]);

  return <>{children}</>;
}
