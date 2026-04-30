"use client";

import { useUIStore } from "@/stores/ui";
import { useThemeStore } from "@/stores/theme";
import { useAgentStore } from "@/stores/agent";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  Home,
  BookOpen,
  Activity,
  Settings,
  Moon,
  Sun,
  Monitor,
} from "lucide-react";
import { ReactNode } from "react";

type View = "home" | "library" | "activity" | "settings";

const NAV_ITEMS: { view: View; label: string; icon: ReactNode }[] = [
  { view: "home", label: "Home", icon: <Home size={18} /> },
  { view: "library", label: "Library", icon: <BookOpen size={18} /> },
  { view: "activity", label: "Activity", icon: <Activity size={18} /> },
];

function ThemeIcon({ mode }: { mode: string }) {
  if (mode === "dark") return <Moon size={18} />;
  if (mode === "light") return <Sun size={18} />;
  return <Monitor size={18} />;
}

export function Sidebar({ electron = false }: { electron?: boolean }) {
  const view = useUIStore((s) => s.view);
  const setView = useUIStore((s) => s.setView);
  const themeMode = useThemeStore((s) => s.mode);
  const cycleTheme = useThemeStore((s) => s.cycle);
  const agentStatus = useAgentStore((s) => s.state?.status);
  const isRunning = agentStatus === "running" || agentStatus === "paused";

  return (
    <nav
      className={`wp-sidebar flex flex-col items-center justify-between h-full ${electron ? "pb-3" : "py-3"} bg-wp-surface ${electron ? "" : "border-r border-wp-border"}`}
      style={{ width: "var(--wp-sidebar-width)", flexShrink: 0 }}
    >
      {/* Drag region for macOS titlebar area — fills space above nav icons */}
      {electron && <div className="wp-drag w-full shrink-0" style={{ height: "var(--wp-titlebar-height)" }} />}
      <div className="flex flex-col items-center gap-1">
        {NAV_ITEMS.map((item) => (
          <Tooltip key={item.view} content={item.label} side="right">
            <button
              type="button"
              aria-label={item.label}
              onClick={() => setView(item.view)}
              className={`relative w-9 h-9 flex items-center justify-center text-base rounded-[var(--wp-radius-sm)] transition-colors ${
                view === item.view
                  ? "text-wp-accent bg-wp-accent-muted"
                  : "text-wp-text-secondary hover:text-wp-text hover:bg-wp-surface-raised"
              }`}
            >
              {item.icon}
              {item.view === "activity" && isRunning && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-wp-accent animate-pulse" />
              )}
            </button>
          </Tooltip>
        ))}
      </div>

      <div className="flex flex-col items-center gap-1">
        <Tooltip content="Settings" side="right">
          <button
            type="button"
            aria-label="Settings"
            onClick={() => setView("settings")}
            className={`w-9 h-9 flex items-center justify-center text-base rounded-[var(--wp-radius-sm)] transition-colors ${
              view === "settings"
                ? "text-wp-accent bg-wp-accent-muted"
                : "text-wp-text-secondary hover:text-wp-text hover:bg-wp-surface-raised"
            }`}
          >
            <Settings size={18} />
          </button>
        </Tooltip>
        <Tooltip content={`Theme: ${themeMode}`} side="right">
          <button
            type="button"
            aria-label={`Theme: ${themeMode}`}
            onClick={cycleTheme}
            className="w-9 h-9 flex items-center justify-center text-base text-wp-text-secondary hover:text-wp-text hover:bg-wp-surface-raised rounded-[var(--wp-radius-sm)] transition-colors"
          >
            <ThemeIcon mode={themeMode} />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}
