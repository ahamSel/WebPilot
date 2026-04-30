import { type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  "inline-flex items-center justify-center font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-wp-accent/40 disabled:opacity-40 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary: "bg-wp-accent text-white hover:bg-wp-accent-hover",
  ghost:
    "bg-transparent text-wp-text-secondary hover:bg-wp-surface-raised hover:text-wp-text",
  danger: "bg-wp-error/10 text-wp-error hover:bg-wp-error/20",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs rounded-[var(--wp-radius-sm)]",
  md: "h-8 px-3.5 text-[13px] rounded-[var(--wp-radius-sm)]",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
