"use client";

import type { ModelOption } from "@/lib/runtime-provider-presets";

interface ModelSelectorProps {
  label: string;
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
}

export function ModelSelector({ label, value, options, onChange }: ModelSelectorProps) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4">
      <label className="text-[13px] text-wp-text-secondary shrink-0">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!options.length}
        className="h-8 min-w-0 flex-1 rounded-[var(--wp-radius-sm)] border border-wp-border bg-wp-surface px-2 text-[13px] text-wp-text focus:outline-none focus:border-wp-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {!options.length && <option value="">No models available</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
