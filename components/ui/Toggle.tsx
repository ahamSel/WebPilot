interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  className?: string;
}

export function Toggle({ checked, onChange, label, className = "" }: ToggleProps) {
  return (
    <label className={`inline-flex items-center gap-2 cursor-pointer ${className}`}>
      <button
        role="switch"
        type="button"
        aria-label={label}
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors ${
          checked ? "bg-wp-accent" : "bg-wp-border"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
      {label && <span className="text-[13px] text-wp-text-secondary">{label}</span>}
    </label>
  );
}
