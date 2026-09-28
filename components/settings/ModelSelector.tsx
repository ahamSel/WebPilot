"use client";

import { useId } from "react";
import type { ModelOption } from "@/lib/runtime-provider-presets";

interface ModelSelectorProps {
  label: string;
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
  /** Free-text model id with suggestions, for catalogs too large for a select. */
  searchable?: boolean;
  /** Model ids known to be valid; used to flag typos in searchable mode. */
  knownIds?: Set<string>;
}

const fieldClass =
  "h-8 min-w-0 flex-1 rounded-[var(--wp-radius-sm)] border border-wp-border bg-wp-surface px-2 text-[13px] text-wp-text focus:outline-none focus:border-wp-accent disabled:cursor-not-allowed disabled:opacity-60";

export function ModelSelector({ label, value, options, onChange, searchable = false, knownIds }: ModelSelectorProps) {
  const listId = useId();

  if (searchable) {
    const selected = options.find((opt) => opt.value === value);
    const unknown = !!value && !!knownIds?.size && !knownIds.has(value);
    return (
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center justify-between gap-4">
          <label className="w-20 text-[13px] text-wp-text-secondary shrink-0" htmlFor={`${listId}-input`}>{label}</label>
          <input
            id={`${listId}-input`}
            list={listId}
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
            placeholder="vendor/model, e.g. google/gemini-3.8-flash"
            spellCheck={false}
            autoComplete="off"
            className={fieldClass}
          />
          <datalist id={listId}>
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.description ? `${opt.label} · ${opt.description}` : opt.label}
              </option>
            ))}
          </datalist>
        </div>
        {(selected?.description || unknown) && (
          <p className={`text-right text-[11px] ${unknown ? "text-wp-error" : "text-wp-text-secondary"}`}>
            {unknown ? "Not in OpenRouter's tool-capable model list." : `${selected?.label} · ${selected?.description}`}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center justify-between gap-4">
      <label className="w-20 text-[13px] text-wp-text-secondary shrink-0">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!options.length}
        className={fieldClass}
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
