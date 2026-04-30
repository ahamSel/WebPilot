"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { postAgentActionClient, getRuntimeSettingsClient, buildRuntimeOverrides } from "@/lib/desktop-client";
import { useAgentStore } from "@/stores/agent";
import { useThreadStore } from "@/stores/thread";
import { useUIStore } from "@/stores/ui";

export function InputBar() {
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const status = useAgentStore((s) => s.state?.status || "idle");
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const addToast = useUIStore((s) => s.addToast);

  const isRunning = status === "running";
  const isPaused = status === "paused";
  const canSend = goal.trim().length > 0 && !isRunning && !isPaused && !submitting;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSend() {
    if (!canSend) return;
    setSubmitting(true);
    try {
      const settings = await getRuntimeSettingsClient();
      const runtime = buildRuntimeOverrides(settings);
      await postAgentActionClient({
        action: "start",
        goal: goal.trim(),
        threadId: activeThreadId || undefined,
        runtime,
      });
      setGoal("");
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
        className="min-h-[32px] max-h-[120px] min-w-0 flex-1 resize-none rounded-[var(--wp-radius-sm)] border border-wp-border bg-wp-surface px-3 py-1.5 text-[13px] text-wp-text placeholder:text-wp-text-secondary/50 focus:outline-none focus:border-wp-accent focus:ring-2 focus:ring-wp-accent/20"
      />
      <Button onClick={handleSend} disabled={!canSend} size="md" aria-label="Send task">
        &#10148;
      </Button>
    </div>
  );
}
