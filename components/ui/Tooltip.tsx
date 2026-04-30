"use client";

import { useState, type ReactNode } from "react";

interface TooltipProps {
  content: string;
  side?: "right" | "top" | "bottom";
  children: ReactNode;
}

export function Tooltip({ content, side = "right", children }: TooltipProps) {
  const [show, setShow] = useState(false);

  const positionClass =
    side === "right"
      ? "left-full ml-2 top-1/2 -translate-y-1/2"
      : side === "top"
        ? "bottom-full mb-2 left-1/2 -translate-x-1/2"
        : "top-full mt-2 left-1/2 -translate-x-1/2";

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          className={`absolute z-50 px-2 py-1 text-xs text-wp-text bg-wp-surface-raised border border-wp-border rounded-[var(--wp-radius-sm)] whitespace-nowrap pointer-events-none ${positionClass}`}
        >
          {content}
        </div>
      )}
    </div>
  );
}
