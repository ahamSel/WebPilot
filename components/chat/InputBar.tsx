"use client";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { Button } from "@/components/ui/Button";
import { postAgentActionClient, getRuntimeSettingsClient, buildRuntimeOverrides } from "@/lib/desktop-client";
import { useAgentStore } from "@/stores/agent";
import { useThreadStore } from "@/stores/thread";
import { useUIStore } from "@/stores/ui";

export function InputBar() {
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const status = useAgentStore((s) => s.state?.status || "idle");
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const setActiveThread = useThreadStore((s) => s.setActiveThread);
  const fetchThreads = useThreadStore((s) => s.fetchThreads);
  const addToast = useUIStore((s) => s.addToast);
  const goal = useUIStore((s) => s.composerDraft);
  const setGoal = useUIStore((s) => s.setComposerDraft);
  const clearGoal = useUIStore((s) => s.clearComposerDraft);

  const isRunning = status === "running";
  const isPaused = status === "paused";
  const canSend = goal.trim().length > 0 && !isRunning && !isPaused && !submitting;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const maxHeight = 144;
    input.style.height = "auto";
    const nextHeight = Math.min(input.scrollHeight, maxHeight);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [goal]);

  async function handleSend() {
    if (!canSend) return;
    setSubmitting(true);
    try {
      const settings = await getRuntimeSettingsClient();
      const runtime = buildRuntimeOverrides(settings);
      const started = await postAgentActionClient({
        action: "start",
        goal: goal.trim(),
        threadId: activeThreadId || undefined,
        runtime,
      }) as { threadId?: string };
      if (started.threadId) {
        setActiveThread(started.threadId);
        fetchThreads().catch(() => {});
      }
      clearGoal();
    } catch (err) {
      addToast(`Failed to start: ${err instanceof Error ? err.message : "unknown"}`, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePause() {
    try {
      await postAgentActionClient({ action: "pause" });
    } catch (err) {
      addToast(`Failed to pause: ${err instanceof Error ? err.message : "unknown"}`, "error");
    }
  }

  async function handleResume() {
    try {
      await postAgentActionClient({ action: "resume" });
    } catch (err) {
      addToast(`Failed to resume: ${err instanceof Error ? err.message : "unknown"}`, "error");
    }
  }

  async function handleStop() {
    try {
      await postAgentActionClient({ action: "stop" });
    } catch (err) {
      addToast(`Failed to stop: ${err instanceof Error ? err.message : "unknown"}`, "error");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (isRunning || isPaused) {
    return (
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-t border-wp-border px-4 py-3">
        <div className="min-w-0 flex-1 truncate text-xs text-wp-text-secondary">
          {isRunning ? "Running..." : "Paused"}
        </div>
        {isRunning && (
          <Button variant="ghost" size="sm" onClick={handlePause}>
            Pause
          </Button>
        )}
        {isPaused && (
          <Button variant="primary" size="sm" onClick={handleResume}>
            Resume
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={handleStop}>
          Stop
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 shrink-0 items-end gap-2 border-t border-wp-border px-4 py-3">
      <textarea
        ref={inputRef}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask anything..."
        rows={1}
        className="min-h-[40px] max-h-36 min-w-0 flex-1 resize-none rounded-[var(--wp-radius-sm)] border border-wp-border bg-wp-surface px-3 py-2 text-[13px] leading-5 text-wp-text placeholder:text-wp-text-secondary/50 focus:outline-none focus:border-wp-accent focus:ring-2 focus:ring-wp-accent/20"
      />
      <Button onClick={handleSend} disabled={!canSend} size="md" aria-label="Send task">
        &#10148;
      </Button>
    </div>
  );
}
