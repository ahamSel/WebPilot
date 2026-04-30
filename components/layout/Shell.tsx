"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { ErrorBoundary } from "./ErrorBoundary";
import { useAgentStore } from "@/stores/agent";
import { useUIStore } from "@/stores/ui";
import { useThemeStore } from "@/stores/theme";
import { subscribeToDesktopCommands, isDesktopShell } from "@/lib/desktop-client";
import { CommandPalette } from "@/components/ui/CommandPalette";

export function Shell({ children }: { children: React.ReactNode }) {
  const startPolling = useAgentStore((s) => s.startPolling);
  const stopPolling = useAgentStore((s) => s.stopPolling);
  const connectionError = useAgentStore((s) => s.connectionError);
  const setView = useUIStore((s) => s.setView);
  const toasts = useUIStore((s) => s.toasts);
  const hydrateUI = useUIStore((s) => s.hydrate);
  const hydrateTheme = useThemeStore((s) => s.hydrate);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    const isElec = isDesktopShell();
    setIsElectron(isElec);
    hydrateUI();
    hydrateTheme();
    // Set titlebar height CSS variable from Electron bridge
    if (isElec) {
      const bridge = (window as Window & { webPilotDesktop?: { titlebarHeight?: number; platform?: string } }).webPilotDesktop;
      const h = bridge?.titlebarHeight || 38;
      document.documentElement.style.setProperty("--wp-titlebar-height", `${h}px`);
      if (bridge?.platform) {
        document.documentElement.setAttribute("data-platform", bridge.platform);
      }
    }
  }, [hydrateUI, hydrateTheme]);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  useEffect(() => {
    const unsub = subscribeToDesktopCommands((cmd, payload) => {
      if (cmd === "navigate" && payload?.view) {
        setView(payload.view as "home" | "library" | "activity" | "settings");
      }
    });
    return () => unsub();
  }, [setView]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function handleErrorReset() {
    setView("home");
  }

  return (
    <div className={`flex h-screen w-screen min-w-0 overflow-hidden bg-wp-bg ${isElectron ? "electron" : ""}`}>
      {/* Full-width titlebar drag strip — spans entire window top */}
      {isElectron && (
        <div
          className="wp-drag fixed top-0 left-0 right-0 z-40 bg-wp-surface border-b border-wp-border"
          style={{ height: "var(--wp-titlebar-height)" }}
        />
      )}
      <Sidebar electron={isElectron} />
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        style={isElectron ? { paddingTop: "var(--wp-titlebar-height)" } : undefined}
      >
        {connectionError && (
          <div className="flex shrink-0 items-center gap-2 bg-wp-error/10 border-b border-wp-error/20 px-4 py-2 text-xs text-wp-error">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-wp-error" />
            <span className="min-w-0 break-words">Unable to connect to backend — retrying...</span>
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          <ErrorBoundary onReset={handleErrorReset}>
            {children}
          </ErrorBoundary>
        </div>
      </main>

      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />

      {/* Toast stack */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
          {toasts.map((t) => {
            const border =
              t.type === "error" ? "border-wp-error/40" :
              t.type === "success" ? "border-wp-success/40" :
              "border-wp-border";
            const accent =
              t.type === "error" ? "text-wp-error" :
              t.type === "success" ? "text-wp-success" :
              "text-wp-text";
            return (
              <div
                key={t.id}
                className={`px-3 py-2 text-xs bg-wp-surface border ${border} rounded-[var(--wp-radius-md)] ${accent} shadow-lg max-w-xs`}
              >
                {t.message}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
