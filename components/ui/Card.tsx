interface CardProps {
  children: React.ReactNode;
  className?: string;
  padding?: "none" | "sm" | "md";
}

const paddings: Record<string, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
};

export function Card({ children, className = "", padding = "md" }: CardProps) {
  return (
    <div
      className={`bg-wp-surface border border-wp-border rounded-[var(--wp-radius-md)] ${paddings[padding]} ${className}`}
    >
      {children}
    </div>
  );
}
