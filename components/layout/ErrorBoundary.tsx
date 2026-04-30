"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const err = this.state.error;

    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-4 overflow-y-auto px-6 text-center">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-wp-error/10">
          <AlertTriangle size={20} className="text-wp-error" />
        </div>
        <div>
          <h2 className="text-sm font-medium text-wp-text mb-1">Something went wrong</h2>
          <p className="max-w-md break-words text-xs text-wp-text-secondary">
            {err.message || "An unexpected error occurred."}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={this.reset}
            className="px-3 py-1.5 text-[13px] bg-wp-accent text-white rounded-[var(--wp-radius-sm)] hover:bg-wp-accent-hover transition-colors"
          >
            Try again
          </button>
        </div>
        <details className="mt-2 w-full max-w-lg min-w-0 text-left">
          <summary className="text-[11px] text-wp-text-secondary cursor-pointer hover:text-wp-text transition-colors">
            Error details
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[var(--wp-radius-sm)] border border-wp-border bg-wp-surface p-3 font-mono text-[11px] text-wp-error/80">
            {err.stack || err.message}
          </pre>
        </details>
      </div>
    );
  }
}
