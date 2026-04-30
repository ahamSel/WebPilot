import { type InputHTMLAttributes, type TextareaHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", ...props }, ref) => (
    <input
      ref={ref}
      className={`w-full h-8 px-3 text-[13px] bg-wp-surface border border-wp-border rounded-[var(--wp-radius-sm)] text-wp-text placeholder:text-wp-text-secondary/50 focus:outline-none focus:border-wp-accent focus:ring-2 focus:ring-wp-accent/20 transition-colors ${className}`}
      {...props}
    />
  )
);
Input.displayName = "Input";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = "", ...props }, ref) => (
    <textarea
      ref={ref}
      className={`w-full px-3 py-2 text-[13px] bg-wp-surface border border-wp-border rounded-[var(--wp-radius-sm)] text-wp-text placeholder:text-wp-text-secondary/50 focus:outline-none focus:border-wp-accent focus:ring-2 focus:ring-wp-accent/20 transition-colors resize-none ${className}`}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";
