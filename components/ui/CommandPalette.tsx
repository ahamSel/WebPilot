"use client";

import { useState, useEffect, useRef } from "react";
import { useUIStore } from "@/stores/ui";
import { useAgentStore } from "@/stores/agent";
import { useThreadStore } from "@/stores/thread";
import { postAgentActionClient } from "@/lib/desktop-client";

interface Command {
  id: string;
  label: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const setView = useUIStore((s) => s.setView);
  const setActiveThread = useThreadStore((s) => s.setActiveThread);
  const agentStatus = useAgentStore((s) => s.state?.status || "idle");

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const commands: Command[] = [
    { id: "home", label: "Go to Home", action: () => { setView("home"); onClose(); } },
    { id: "library", label: "Go to Library", action: () => { setView("library"); onClose(); } },
    { id: "activity", label: "Go to Activity", action: () => { setView("activity"); onClose(); } },
    { id: "settings", label: "Go to Settings", action: () => { setView("settings"); onClose(); } },
    { id: "new-thread", label: "New thread", action: () => { setActiveThread(null); setView("home"); onClose(); } },
  ];

  if (agentStatus === "running") {
    commands.push({
      id: "pause",
      label: "Pause run",
      action: () => { postAgentActionClient({ action: "pause" }); onClose(); },
    });
    commands.push({
      id: "stop",
      label: "Stop run",
      action: () => { postAgentActionClient({ action: "stop" }); onClose(); },
    });
  }
  if (agentStatus === "paused") {
    commands.push({
      id: "resume",
      label: "Resume run",
      action: () => { postAgentActionClient({ action: "resume" }); onClose(); },
    });
  }

  const filtered = query
    ? commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : commands;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && filtered.length > 0) {
      filtered[0].action();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" onClick={onClose}>
      <div
        className="w-full max-w-md bg-wp-surface border border-wp-border rounded-[var(--wp-radius-lg)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
          className="w-full px-4 py-3 text-[13px] bg-transparent text-wp-text placeholder:text-wp-text-secondary/50 border-b border-wp-border focus:outline-none"
        />
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.map((cmd) => (
            <button
              key={cmd.id}
              onClick={cmd.action}
              className="w-full text-left px-4 py-2 text-[13px] text-wp-text hover:bg-wp-surface-raised transition-colors"
            >
              {cmd.label}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-4 py-2 text-[13px] text-wp-text-secondary">No results</div>
          )}
        </div>
      </div>
    </div>
  );
}
