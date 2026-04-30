import { ReactNode } from "react";
import {
  Globe,
  MousePointer,
  Keyboard,
  ArrowUpDown,
  Eye,
  Clock,
  Check,
} from "lucide-react";

interface StepChipProps {
  action: string;
  active?: boolean;
}

const ACTION_ICONS: Record<string, ReactNode> = {
  navigate: <Globe size={12} />,
  click: <MousePointer size={12} />,
  type: <Keyboard size={12} />,
  scroll: <ArrowUpDown size={12} />,
  observe: <Eye size={12} />,
  wait: <Clock size={12} />,
  finish: <Check size={12} />,
};

function iconFor(action: string): ReactNode {
  const lower = action.toLowerCase();
  for (const [key, icon] of Object.entries(ACTION_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return <span>&middot;</span>;
}

export function StepChip({ action, active }: StepChipProps) {
  return (
    <div
      className={`flex min-w-0 max-w-full items-center gap-1.5 text-xs text-wp-text-secondary ${
        active ? "opacity-100" : "opacity-60"
      }`}
    >
      <span className="shrink-0 text-[10px]">{iconFor(action)}</span>
      <span className="min-w-0 flex-1 truncate">{action}</span>
    </div>
  );
}
