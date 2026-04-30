interface BadgeProps {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "error" | "info";
  className?: string;
}

const tones: Record<string, string> = {
  neutral: "bg-wp-surface-raised text-wp-text-secondary",
  accent: "bg-wp-accent-muted text-wp-accent",
  success: "bg-wp-success/10 text-wp-success",
  warning: "bg-wp-warning/10 text-wp-warning",
  error: "bg-wp-error/10 text-wp-error",
  info: "bg-wp-info/10 text-wp-info",
};

export function Badge({ children, tone = "neutral", className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-[var(--wp-radius-sm)] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
